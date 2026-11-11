// Google Ads changes as API operations (pure: no I/O). tethr's ads tools turn a
// request into these, and googleAds:mutate runs them as one atomic batch.
//
// Built in: new campaigns start PAUSED (turning one on is spending, which the
// gate checks), Search on Google only, ads point at the company's own website,
// and nothing is ever removed (stopping something means pausing it).

import { DAYS_PER_MONTH } from "../spend/amount.js";

export const ADS_LIMITS = {
  name: 100,
  keywordChars: 80,
  keywordsPerCall: 50,
  negativesPerCall: 50,
  headlineChars: 30,
  minHeadlines: 3,
  maxHeadlines: 15,
  descriptionChars: 90,
  minDescriptions: 2,
  maxDescriptions: 4,
  changesPerCall: 20,
  maxDailyBudget: 10_000,
  maxCpc: 100,
};

/** Countries a new campaign can target, by code (Google's geo target ids). */
const COUNTRIES: Record<string, number> = { US: 2840, CA: 2124, GB: 2826, AU: 2036, NZ: 2554, IE: 2372 };
const ENGLISH = 1000;
const MATCH: Record<string, string> = { exact: "EXACT", phrase: "PHRASE", broad: "BROAD" };

export class AdsInputError extends Error {}

export interface Keyword {
  text: string;
  match: "EXACT" | "PHRASE" | "BROAD";
}

export interface CampaignSpec {
  name: string;
  dailyBudget: number;
  finalUrl: string;
  keywords: Keyword[];
  negatives: Keyword[];
  headlines: string[];
  descriptions: string[];
  maxCpc: number | null;
  countries: string[];
}

export type MutateOperation = Record<string, unknown>;

const micros = (amount: number) => String(Math.round(amount * 1_000_000));

function text(value: unknown, field: string, max: number): string {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!s) throw new AdsInputError(`${field} is missing.`);
  if (s.length > max) throw new AdsInputError(`${field} is ${s.length} characters; Google allows ${max}: "${s}".`);
  return s;
}

function money(value: unknown, field: string, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[$,\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0) throw new AdsInputError(`${field} must be an amount above 0.`);
  if (n > max) throw new AdsInputError(`${field} is ${n}; the most tethr sets is ${max}.`);
  return Math.round(n * 100) / 100;
}

/** "malaria pills" / { text, match: "exact" }; a bracketed or quoted keyword is exact or phrase. */
export function keywordOf(raw: unknown, field: string): Keyword {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { text: raw };
  let t = typeof o.text === "string" ? o.text.trim() : "";
  let match = typeof o.match === "string" ? MATCH[o.match.toLowerCase()] : undefined;
  if (/^\[.*\]$/.test(t)) [t, match] = [t.slice(1, -1), match ?? "EXACT"];
  else if (/^".*"$/.test(t)) [t, match] = [t.slice(1, -1), match ?? "PHRASE"];
  return { text: text(t, field, ADS_LIMITS.keywordChars), match: (match ?? "PHRASE") as Keyword["match"] };
}

function keywordList(raw: unknown, field: string, max: number, required: boolean): Keyword[] {
  const list = Array.isArray(raw) ? raw : [];
  if (required && !list.length) throw new AdsInputError(`Give at least one ${field.replace(/s$/, "")}.`);
  if (list.length > max) throw new AdsInputError(`At most ${max} ${field} per call.`);
  return list.map((k, i) => keywordOf(k, `${field} ${i + 1}`));
}

function textList(raw: unknown, field: string, min: number, max: number, chars: number): string[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length < min || list.length > max) throw new AdsInputError(`Give ${min} to ${max} ${field}.`);
  return list.map((h, i) => text(h, `${field} ${i + 1}`, chars));
}

/** The company's own web domains, from Integrations' inside addresses. */
export function companyDomains(internalAddresses: string[]): string[] {
  return internalAddresses
    .map((e) => e.trim().toLowerCase().replace(/^.*@/, "").replace(/^\*\./, ""))
    .filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
}

/** An ad's landing page: https, on the company's own website. */
export function landingUrl(raw: unknown, domains: string[]): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new AdsInputError("final_url must be a full web address (https://…).");
  }
  if (url.protocol !== "https:") throw new AdsInputError("final_url must start with https://.");
  const host = url.hostname.toLowerCase();
  if (!domains.some((d) => host === d || host.endsWith(`.${d}`))) {
    throw new AdsInputError(`Ads only point at the company's own website (${domains.join(", ") || "set its domain in Integrations → inside addresses"}); ${host} isn't one.`);
  }
  return url.toString();
}

export function parseCampaign(input: Record<string, unknown>, domains: string[]): CampaignSpec {
  const countries = (Array.isArray(input.countries) && input.countries.length ? input.countries : ["US"]).map((c) => String(c).toUpperCase());
  for (const c of countries) if (!COUNTRIES[c]) throw new AdsInputError(`Country ${c} isn't one tethr targets (${Object.keys(COUNTRIES).join(", ")}).`);
  return {
    name: text(input.name, "name", ADS_LIMITS.name),
    dailyBudget: money(input.daily_budget, "daily_budget", ADS_LIMITS.maxDailyBudget),
    finalUrl: landingUrl(input.final_url, domains),
    keywords: keywordList(input.keywords, "keywords", ADS_LIMITS.keywordsPerCall, true),
    negatives: keywordList(input.negatives, "negatives", ADS_LIMITS.negativesPerCall, false),
    headlines: textList(input.headlines, "headlines", ADS_LIMITS.minHeadlines, ADS_LIMITS.maxHeadlines, ADS_LIMITS.headlineChars),
    descriptions: textList(input.descriptions, "descriptions", ADS_LIMITS.minDescriptions, ADS_LIMITS.maxDescriptions, ADS_LIMITS.descriptionChars),
    maxCpc: input.max_cpc === undefined || input.max_cpc === null || input.max_cpc === "" ? null : money(input.max_cpc, "max_cpc", ADS_LIMITS.maxCpc),
    countries,
  };
}

const keywordCreate = (adGroup: string, k: Keyword): MutateOperation => ({
  adGroupCriterionOperation: { create: { adGroup, status: "ENABLED", keyword: { text: k.text, matchType: k.match } } },
});
const negativeCreate = (campaign: string, k: Keyword): MutateOperation => ({
  campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text: k.text, matchType: k.match } } },
});
const adCreate = (adGroup: string, finalUrl: string, headlines: string[], descriptions: string[]): MutateOperation => ({
  adGroupAdOperation: {
    create: {
      adGroup,
      status: "ENABLED",
      ad: { finalUrls: [finalUrl], responsiveSearchAd: { headlines: headlines.map((t) => ({ text: t })), descriptions: descriptions.map((t) => ({ text: t })) } },
    },
  },
});

/** A whole Search campaign, paused, in one batch (temporary ids tie the pieces together). */
export function buildCreateCampaign(customerId: string, spec: CampaignSpec, stamp = new Date().toISOString().slice(0, 16)): MutateOperation[] {
  const base = `customers/${customerId}`;
  const budget = `${base}/campaignBudgets/-1`;
  const campaign = `${base}/campaigns/-2`;
  const adGroup = `${base}/adGroups/-3`;
  return [
    {
      campaignBudgetOperation: {
        create: { resourceName: budget, name: `${spec.name} · ${stamp}`, amountMicros: micros(spec.dailyBudget), deliveryMethod: "STANDARD", explicitlyShared: false },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: spec.name,
          status: "PAUSED",
          advertisingChannelType: "SEARCH",
          campaignBudget: budget,
          // Maximize clicks, with a ceiling per click when one is given.
          targetSpend: spec.maxCpc ? { cpcBidCeilingMicros: micros(spec.maxCpc) } : {},
          networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    ...spec.countries.map((c) => ({ campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: `geoTargetConstants/${COUNTRIES[c]}` } } } })),
    { campaignCriterionOperation: { create: { campaign, language: { languageConstant: `languageConstants/${ENGLISH}` } } } },
    ...spec.negatives.map((k) => negativeCreate(campaign, k)),
    { adGroupOperation: { create: { resourceName: adGroup, campaign, name: `${spec.name} · main`, status: "ENABLED", type: "SEARCH_STANDARD" } } },
    ...spec.keywords.map((k) => keywordCreate(adGroup, k)),
    adCreate(adGroup, spec.finalUrl, spec.headlines, spec.descriptions),
  ];
}

const ID = /^\d+$/;
const PAIR = /^\d+~\d+$/;
function idOf(raw: unknown, field: string, pair = false): string {
  const s = String(raw ?? "").trim();
  if (!(pair ? PAIR : ID).test(s)) throw new AdsInputError(`${field} must be ${pair ? "adGroupId~id (from google_ads_report structure)" : "a numeric id (from google_ads_report structure)"}.`);
  return s;
}

const RESOURCE: Record<string, { path: string; op: string; pair: boolean }> = {
  campaign: { path: "campaigns", op: "campaignOperation", pair: false },
  ad_group: { path: "adGroups", op: "adGroupOperation", pair: false },
  keyword: { path: "adGroupCriteria", op: "adGroupCriterionOperation", pair: true },
  ad: { path: "adGroupAds", op: "adGroupAdOperation", pair: true },
};

/** One change, already checked, and what it does to spending (read by the spend adapter). */
export interface AdsChange {
  action: "pause" | "enable" | "add_keywords" | "add_negatives" | "add_ad" | "add_ad_group" | "set_keyword_bid" | "rename";
  /** For pause/enable/rename: what it applies to. */
  target?: "campaign" | "ad_group" | "keyword" | "ad";
  id?: string;
  operations: MutateOperation[];
  summary: string;
}

/** The changes an ads_change call asks for, as operations. */
export function parseChanges(customerId: string, raw: unknown, domains: string[]): AdsChange[] {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) throw new AdsInputError("Give at least one change.");
  if (list.length > ADS_LIMITS.changesPerCall) throw new AdsInputError(`At most ${ADS_LIMITS.changesPerCall} changes per call.`);
  const base = `customers/${customerId}`;
  return list.map((item, i): AdsChange => {
    const c = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const action = String(c.action ?? "");
    const label = `change ${i + 1}`;
    if (action === "pause" || action === "enable") {
      const target = String(c.target ?? "");
      const r = RESOURCE[target];
      if (!r) throw new AdsInputError(`${label}: target must be campaign, ad_group, keyword or ad.`);
      const id = idOf(c.id, `${label} id`, r.pair);
      return {
        action,
        target: target as AdsChange["target"],
        id,
        operations: [{ [r.op]: { update: { resourceName: `${base}/${r.path}/${id}`, status: action === "pause" ? "PAUSED" : "ENABLED" }, updateMask: "status" } }],
        summary: `${action === "pause" ? "Pause" : "Turn on"} ${target.replace("_", " ")} ${id}`,
      };
    }
    if (action === "add_keywords") {
      const adGroup = `${base}/adGroups/${idOf(c.ad_group_id, `${label} ad_group_id`)}`;
      const keywords = keywordList(c.keywords, "keywords", ADS_LIMITS.keywordsPerCall, true);
      return { action, operations: keywords.map((k) => keywordCreate(adGroup, k)), summary: `Add ${keywords.length} keyword${keywords.length === 1 ? "" : "s"}` };
    }
    if (action === "add_negatives") {
      const campaign = `${base}/campaigns/${idOf(c.campaign_id, `${label} campaign_id`)}`;
      const keywords = keywordList(c.keywords, "negatives", ADS_LIMITS.negativesPerCall, true);
      return { action, operations: keywords.map((k) => negativeCreate(campaign, k)), summary: `Add ${keywords.length} negative keyword${keywords.length === 1 ? "" : "s"}` };
    }
    if (action === "add_ad") {
      const adGroup = `${base}/adGroups/${idOf(c.ad_group_id, `${label} ad_group_id`)}`;
      const headlines = textList(c.headlines, "headlines", ADS_LIMITS.minHeadlines, ADS_LIMITS.maxHeadlines, ADS_LIMITS.headlineChars);
      const descriptions = textList(c.descriptions, "descriptions", ADS_LIMITS.minDescriptions, ADS_LIMITS.maxDescriptions, ADS_LIMITS.descriptionChars);
      return { action, operations: [adCreate(adGroup, landingUrl(c.final_url, domains), headlines, descriptions)], summary: "Add an ad" };
    }
    if (action === "add_ad_group") {
      const campaign = `${base}/campaigns/${idOf(c.campaign_id, `${label} campaign_id`)}`;
      const name = text(c.name, `${label} name`, ADS_LIMITS.name);
      const tempGroup = `${base}/adGroups/-${10 + i}`;
      const keywords = keywordList(c.keywords, "keywords", ADS_LIMITS.keywordsPerCall, false);
      return {
        action,
        operations: [
          { adGroupOperation: { create: { resourceName: tempGroup, campaign, name, status: "ENABLED", type: "SEARCH_STANDARD" } } },
          ...keywords.map((k) => keywordCreate(tempGroup, k)),
        ],
        summary: `Add ad group "${name}"${keywords.length ? ` with ${keywords.length} keywords` : ""}`,
      };
    }
    if (action === "set_keyword_bid") {
      const id = idOf(c.keyword_id, `${label} keyword_id`, true);
      const bid = money(c.max_cpc, `${label} max_cpc`, ADS_LIMITS.maxCpc);
      return {
        action,
        operations: [{ adGroupCriterionOperation: { update: { resourceName: `${base}/adGroupCriteria/${id}`, cpcBidMicros: micros(bid) }, updateMask: "cpcBidMicros" } }],
        summary: `Set keyword ${id}'s bid to $${bid}`,
      };
    }
    if (action === "rename") {
      const target = String(c.target ?? "");
      if (target !== "campaign" && target !== "ad_group") throw new AdsInputError(`${label}: only a campaign or an ad group can be renamed.`);
      const r = RESOURCE[target]!;
      const id = idOf(c.id, `${label} id`);
      const name = text(c.name, `${label} name`, ADS_LIMITS.name);
      return { action, target, id, operations: [{ [r.op]: { update: { resourceName: `${base}/${r.path}/${id}`, name }, updateMask: "name" } }], summary: `Rename ${target.replace("_", " ")} ${id} to "${name}"` };
    }
    throw new AdsInputError(`${label}: action must be pause, enable, add_keywords, add_negatives, add_ad, add_ad_group, set_keyword_bid or rename. Nothing is removed in Google Ads; pause it instead.`);
  });
}

/** A campaign budget's new daily amount. */
export function buildBudget(budgetResource: string, dailyBudget: number): MutateOperation[] {
  return [{ campaignBudgetOperation: { update: { resourceName: budgetResource, amountMicros: micros(dailyBudget) }, updateMask: "amountMicros" } }];
}

export function parseBudget(input: Record<string, unknown>): { campaignId: string; dailyBudget: number } {
  return { campaignId: idOf(input.campaign_id, "campaign_id"), dailyBudget: money(input.daily_budget, "daily_budget", ADS_LIMITS.maxDailyBudget) };
}

/** Planned monthly spend from live campaigns' daily budgets; a budget shared by several counts once. */
export function plannedFromBudgets(rows: Array<{ budget: string; dailyAmount: number }>): number {
  const byBudget = new Map(rows.map((r) => [r.budget, r.dailyAmount]));
  return [...byBudget.values()].reduce((sum, d) => sum + d, 0) * DAYS_PER_MONTH;
}
