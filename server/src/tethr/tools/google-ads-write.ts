import type { SpendAdapter, SpendAssessment } from "../spend/adapters.js";
import { DAYS_PER_MONTH } from "../spend/amount.js";
import { getIntegrations } from "../integrations.js";
import { adsHeaders, API_VERSIONS, field, getConfig, microsToAmount, query } from "./google-ads.js";
import { AdsInputError, companyDomains, parseBudget, parseChanges, plannedFromBudgets, type MutateOperation } from "./google-ads-ops.js";

// Changing a Google Ads account (googleAds:mutate), reading what it plans to
// spend, and the spend adapter the approval gate uses for the cap and for
// "your own changes win". Everything goes through one backend so tests can put
// a fake account in its place.

export class AdsApiError extends Error {}

export interface AdsBackend {
  configured(): boolean;
  customerId(): string;
  search(gaql: string): Promise<Array<Record<string, unknown>>>;
  /** One atomic batch. validateOnly: Google checks everything and changes nothing. Returns the resource names made or changed. */
  mutate(operations: MutateOperation[], opts?: { validateOnly?: boolean }): Promise<string[]>;
}

/** Google's error, in a line or two (its own messages, the first few). */
export function googleError(body: unknown, status: number): string {
  const err = (body as { error?: { message?: string; details?: Array<{ errors?: Array<{ message?: string; trigger?: { stringValue?: string } }> }> } })?.error;
  const details = (err?.details ?? []).flatMap((d) => d.errors ?? []).map((e) => `${e.message ?? ""}${e.trigger?.stringValue ? ` ("${e.trigger.stringValue}")` : ""}`.trim());
  const text = (details.length ? details.slice(0, 5).join("; ") : err?.message) || `HTTP ${status}`;
  return text.slice(0, 600);
}

function resourceNames(body: unknown): string[] {
  const responses = (body as { mutateOperationResponses?: Array<Record<string, { resourceName?: string } | undefined>> })?.mutateOperationResponses ?? [];
  return responses.flatMap((r) => Object.values(r).map((v) => v?.resourceName).filter((n): n is string => typeof n === "string"));
}

const liveBackend: AdsBackend = {
  configured: () => getConfig() !== null,
  customerId: () => getConfig()?.customerId ?? "",
  search: async (gaql) => {
    const cfg = getConfig();
    if (!cfg) throw new AdsApiError("Google Ads isn't set up");
    return query(cfg, gaql);
  },
  mutate: async (operations, opts = {}) => {
    const cfg = getConfig();
    if (!cfg) throw new AdsApiError("Google Ads isn't set up");
    const headers = await adsHeaders(cfg);
    for (const v of API_VERSIONS) {
      const res = await fetch(`https://googleads.googleapis.com/${v}/customers/${cfg.customerId}/googleAds:mutate`, {
        method: "POST",
        headers,
        body: JSON.stringify({ mutateOperations: operations, partialFailure: false, validateOnly: opts.validateOnly === true }),
      });
      if (res.status === 404) continue;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new AdsApiError(googleError(body, res.status));
      return resourceNames(body);
    }
    throw new AdsApiError("no supported Google Ads API version answered");
  },
};

let backend: AdsBackend = liveBackend;

/** For tests: a fake account (null puts the real one back). */
export function setAdsBackendForTests(fake: AdsBackend | null): void {
  backend = fake ?? liveBackend;
}

export function adsBackend(): AdsBackend {
  // Under tests nothing reaches Google unless a test put a fake in place.
  if (backend === liveBackend && (process.env.VITEST || process.env.NODE_ENV === "test")) {
    return { ...liveBackend, configured: () => false };
  }
  return backend;
}

export interface CampaignState {
  id: string;
  name: string;
  status: string;
  budget: string;
  dailyAmount: number;
  shared: boolean;
}

export async function campaignState(campaignId: string): Promise<CampaignState | null> {
  if (!/^\d+$/.test(campaignId)) return null;
  const [row] = await adsBackend().search(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.campaign_budget, campaign_budget.amount_micros, campaign_budget.explicitly_shared
     FROM campaign WHERE campaign.id = ${campaignId} LIMIT 1`,
  );
  if (!row) return null;
  const c = row.campaign as Record<string, unknown>;
  const b = field(row, "campaign_budget");
  return {
    id: String(c.id),
    name: String(c.name ?? ""),
    status: String(c.status ?? ""),
    budget: String(field(c, "campaign_budget") ?? ""),
    dailyAmount: microsToAmount(field(b, "amount_micros") as number),
    shared: field(b, "explicitly_shared") === true,
  };
}

/** Live campaigns' budgets (a shared budget appears once per campaign; plannedFromBudgets counts it once). */
export async function liveBudgets(): Promise<Array<{ campaignId: string; budget: string; dailyAmount: number }>> {
  const rows = await adsBackend().search(
    `SELECT campaign.id, campaign.campaign_budget, campaign_budget.amount_micros FROM campaign WHERE campaign.status = 'ENABLED'`,
  );
  return rows.map((r) => {
    const c = r.campaign as Record<string, unknown>;
    return { campaignId: String(c.id), budget: String(field(c, "campaign_budget") ?? ""), dailyAmount: microsToAmount(field(field(r, "campaign_budget"), "amount_micros") as number) };
  });
}

let currencyCache: string | null = null;
async function accountCurrency(): Promise<string> {
  if (currencyCache) return currencyCache;
  const [row] = await adsBackend().search("SELECT customer.currency_code FROM customer LIMIT 1");
  currencyCache = String(field(row?.customer, "currency_code") ?? "USD");
  return currencyCache;
}

/** Clients a person uses (not the API tethr itself uses). */
const PERSON_CLIENTS = new Set(["GOOGLE_ADS_WEB_CLIENT", "GOOGLE_ADS_MOBILE_APP", "GOOGLE_ADS_EDITOR"]);
const EDIT_WINDOW_DAYS = 14;

/** A person's change to this campaign or budget in the last two weeks, said in a line, or null. */
export async function recentPersonEdit(resource: string, what: string, now = new Date()): Promise<string | null> {
  if (!/^customers\/\d+\/(campaigns|campaignBudgets)\/\d+$/.test(resource)) return null;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const from = day(new Date(now.getTime() - EDIT_WINDOW_DAYS * 86_400_000));
  const to = day(new Date(now.getTime() + 86_400_000));
  // Google doesn't filter change history by the changed item's name, so it's
  // read by type for the window and matched here.
  const rows = await adsBackend().search(
    `SELECT change_event.change_date_time, change_event.client_type, change_event.change_resource_type, change_event.change_resource_name
     FROM change_event
     WHERE change_event.change_date_time >= '${from}' AND change_event.change_date_time <= '${to}'
       AND change_event.change_resource_type IN ('CAMPAIGN', 'CAMPAIGN_BUDGET')
     ORDER BY change_event.change_date_time DESC LIMIT 1000`,
  );
  const edit = rows
    .map((r) => field(r, "change_event") as Record<string, unknown>)
    .find((e) => field(e, "change_resource_name") === resource && PERSON_CLIENTS.has(String(field(e, "client_type"))));
  if (!edit) return null;
  const when = String(field(edit, "change_date_time") ?? "").slice(0, 10);
  return `a person changed this ${what} in Google Ads${when ? ` on ${when}` : ""}`;
}

/** What one ads tool call does to planned monthly spend. Bad input spends nothing (the tool refuses it). */
async function assess(companyId: string, tool: string, input: Record<string, unknown>): Promise<SpendAssessment> {
  const none: SpendAssessment = { monthlyDelta: 0, personEdit: null };
  try {
    if (tool === "ads_set_budget") {
      const { campaignId, dailyBudget } = parseBudget(input);
      const state = await campaignState(campaignId);
      if (!state) return none;
      const live = (await liveBudgets()).some((r) => r.budget === state.budget);
      const delta = live ? (dailyBudget - state.dailyAmount) * DAYS_PER_MONTH : 0;
      return { monthlyDelta: delta, personEdit: delta > 0 ? await recentPersonEdit(state.budget, "budget") : null };
    }
    if (tool === "ads_change") {
      const domains = companyDomains(getIntegrations(companyId).internalAddresses);
      const changes = parseChanges(adsBackend().customerId(), input.changes, domains);
      const live = await liveBudgets();
      const counted = new Set(live.map((r) => r.budget));
      let delta = 0;
      let personEdit: string | null = null;
      for (const change of changes) {
        if (change.action !== "enable" || change.target !== "campaign" || !change.id) continue;
        const state = await campaignState(change.id);
        if (!state || state.status === "ENABLED") continue;
        if (!counted.has(state.budget)) {
          delta += state.dailyAmount * DAYS_PER_MONTH;
          counted.add(state.budget);
        }
        personEdit ??= await recentPersonEdit(`customers/${adsBackend().customerId()}/campaigns/${state.id}`, "campaign");
      }
      return { monthlyDelta: delta, personEdit };
    }
    // A new campaign is created paused: it spends nothing until it's turned on.
    return none;
  } catch (err) {
    if (err instanceof AdsInputError) return none;
    throw err;
  }
}

export const googleAdsAdapter: SpendAdapter = {
  connector: "Google Ads",
  configured: () => adsBackend().configured(),
  plannedMonthly: async () => ({ amount: plannedFromBudgets(await liveBudgets()), currency: await accountCurrency() }),
  assess,
};
