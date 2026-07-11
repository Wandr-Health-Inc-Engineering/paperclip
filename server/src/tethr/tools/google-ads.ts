// Google Ads — READ-ONLY analysis access for Tethr agents (Ledger, Tailwind).
// Ported from scout-wandr-app's raw-fetch client (no SDK). Deliberately ships
// ONLY read/analyze queries: agents can pull performance data and RECOMMEND
// changes, but cannot mutate the account or spend money. Any actual bid/budget/
// campaign change stays a human-approved, spend-gated recommendation (gating.ts)
// or is applied by a human in Google Ads / the Scout UI. Reuses the GOOGLE_ADS_*
// OAuth creds already in the env.

const OAUTH_URL = "https://oauth2.googleapis.com/token";
const API_VERSIONS = ["v23", "v22", "v21"];

interface AdsConfig {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  customerId: string;
  loginCustomerId?: string;
}

function getConfig(): AdsConfig | null {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  const clientId = process.env.GOOGLE_ADS_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN?.trim();
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID?.trim();
  if (!developerToken || !clientId || !clientSecret || !refreshToken || !customerId) return null;
  return {
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.trim() || undefined,
  };
}

export function googleAdsConfigured(): boolean {
  return getConfig() !== null;
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(cfg: AdsConfig): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token;
  const res = await fetch(OAUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`google ads oauth failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.token;
}

/** Run a GAQL SELECT. Tries API versions until one isn't a 404. READ-ONLY. */
async function query(cfg: AdsConfig, gaql: string): Promise<Array<Record<string, unknown>>> {
  const token = await getAccessToken(cfg);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": cfg.developerToken,
    "Content-Type": "application/json",
  };
  if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId;
  let lastErr = "";
  for (const v of API_VERSIONS) {
    const res = await fetch(
      `https://googleads.googleapis.com/${v}/customers/${cfg.customerId}/googleAds:search`,
      { method: "POST", headers, body: JSON.stringify({ query: gaql }) },
    );
    if (res.status === 404) continue;
    if (!res.ok) {
      lastErr = `${res.status} ${await res.text().catch(() => "")}`.slice(0, 300);
      throw new Error(`google ads query failed: ${lastErr}`);
    }
    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    return data.results ?? [];
  }
  throw new Error(`google ads query failed: no supported API version (${lastErr})`);
}

export function microsToAmount(micros: number | string | undefined): number {
  return (Number(micros) || 0) / 1_000_000;
}

/** Shared auth context for other Google Ads endpoints (e.g. Keyword Planner). */
export async function adsRequestContext(): Promise<
  { headers: Record<string, string>; customerId: string; version: string } | null
> {
  const cfg = getConfig();
  if (!cfg) return null;
  const token = await getAccessToken(cfg);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": cfg.developerToken,
    "Content-Type": "application/json",
  };
  if (cfg.loginCustomerId) headers["login-customer-id"] = cfg.loginCustomerId;
  return { headers, customerId: cfg.customerId, version: API_VERSIONS[0] };
}

function dateRange(days: number): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

const money = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

// ---- Read reports ---------------------------------------------------------

async function accountOverview(cfg: AdsConfig, days: number): Promise<string> {
  const { startDate, endDate } = dateRange(days);
  const rows = await query(
    cfg,
    `SELECT metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
            metrics.conversions_value, metrics.ctr, metrics.average_cpc, metrics.cost_per_conversion
     FROM customer WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`,
  );
  let imp = 0, clicks = 0, cost = 0, conv = 0, val = 0;
  for (const r of rows) {
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    imp += Number(m.impressions) || 0;
    clicks += Number(m.clicks) || 0;
    cost += microsToAmount(m.cost_micros as number);
    conv += Number(m.conversions) || 0;
    val += Number(m.conversions_value) || 0;
  }
  const cpa = conv > 0 ? cost / conv : 0;
  const roas = cost > 0 ? val / cost : 0;
  return [
    `Account overview (last ${days}d):`,
    `- Spend ${money(cost)} · Impr ${imp} · Clicks ${clicks} · CTR ${pct(clicks / (imp || 1))}`,
    `- Conversions ${conv.toFixed(1)} · CPA ${money(cpa)} · Value ${money(val)} · ROAS ${roas.toFixed(2)}x`,
  ].join("\n");
}

async function campaignMetrics(cfg: AdsConfig, days: number): Promise<string> {
  const { startDate, endDate } = dateRange(days);
  const rows = await query(
    cfg,
    `SELECT campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros,
            metrics.conversions, metrics.ctr, metrics.average_cpc, metrics.cost_per_conversion
     FROM campaign
     WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND campaign.status != 'REMOVED'
     ORDER BY metrics.cost_micros DESC`,
  );
  const byName = new Map<string, { cost: number; clicks: number; conv: number; imp: number }>();
  for (const r of rows) {
    const c = (r.campaign ?? {}) as Record<string, unknown>;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    const name = String(c.name ?? "?");
    const prev = byName.get(name) ?? { cost: 0, clicks: 0, conv: 0, imp: 0 };
    prev.cost += microsToAmount(m.cost_micros as number);
    prev.clicks += Number(m.clicks) || 0;
    prev.conv += Number(m.conversions) || 0;
    prev.imp += Number(m.impressions) || 0;
    byName.set(name, prev);
  }
  const lines = [...byName.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, 15)
    .map(([name, s]) => `- ${name}: spend ${money(s.cost)}, clicks ${s.clicks}, conv ${s.conv.toFixed(1)}, CPA ${money(s.conv > 0 ? s.cost / s.conv : 0)}`);
  return `Campaigns (last ${days}d, top by spend):\n${lines.join("\n") || "(none)"}`;
}

async function keywordMetrics(cfg: AdsConfig, days: number): Promise<string> {
  const { startDate, endDate } = dateRange(days);
  const rows = await query(
    cfg,
    `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type,
            metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions,
            metrics.ctr, metrics.average_cpc, metrics.cost_per_conversion
     FROM keyword_view
     WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
       AND ad_group_criterion.status != 'REMOVED' AND ad_group_criterion.type = 'KEYWORD'
     ORDER BY metrics.cost_micros DESC LIMIT 500`,
  );
  const lines = rows.slice(0, 25).map((r) => {
    const k = ((r.ad_group_criterion ?? {}) as Record<string, unknown>).keyword as Record<string, unknown> | undefined;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    const cost = microsToAmount(m.cost_micros as number);
    const conv = Number(m.conversions) || 0;
    return `- "${k?.text ?? "?"}" [${k?.match_type ?? "?"}]: spend ${money(cost)}, clicks ${m.clicks ?? 0}, conv ${conv.toFixed(1)}, CPA ${money(conv > 0 ? cost / conv : 0)}`;
  });
  return `Keywords (last ${days}d, top 25 by spend):\n${lines.join("\n") || "(none)"}`;
}

async function searchTerms(cfg: AdsConfig, days: number): Promise<string> {
  const { startDate, endDate } = dateRange(days);
  const rows = await query(
    cfg,
    `SELECT search_term_view.search_term, metrics.impressions, metrics.clicks,
            metrics.cost_micros, metrics.conversions
     FROM search_term_view
     WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND metrics.impressions > 0
     ORDER BY metrics.cost_micros DESC LIMIT 100`,
  );
  const lines = rows.slice(0, 25).map((r) => {
    const t = ((r.search_term_view ?? {}) as Record<string, unknown>).search_term;
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    return `- "${t ?? "?"}": spend ${money(microsToAmount(m.cost_micros as number))}, clicks ${m.clicks ?? 0}, conv ${Number(m.conversions).toFixed(1)}`;
  });
  return `Search terms (last ${days}d, top 25 by spend):\n${lines.join("\n") || "(none)"}`;
}

const REPORTS: Record<string, (cfg: AdsConfig, days: number) => Promise<string>> = {
  overview: accountOverview,
  campaigns: campaignMetrics,
  keywords: keywordMetrics,
  search_terms: searchTerms,
};

import type { TethrTool } from "./types.js";

export const googleAdsReportTool: TethrTool = {
  name: "google_ads_report",
  description:
    "READ-ONLY Google Ads performance report for analysis and recommendations. report ∈ overview|campaigns|keywords|search_terms; days = lookback (default 30). Cannot change the account or spend — recommend changes for human approval.",
  inputSchema: {
    type: "object",
    properties: {
      report: { type: "string", enum: Object.keys(REPORTS), description: "which report" },
      days: { type: "number", description: "lookback window in days (default 30)" },
    },
    required: ["report"],
    additionalProperties: false,
  },
  async execute(_ctx, input) {
    const cfg = getConfig();
    if (!cfg) return { output: "Google Ads is not configured (GOOGLE_ADS_* env unset).", summary: "google_ads: unconfigured" };
    const report = String(input.report ?? "overview");
    const days = Math.max(1, Math.min(365, Number(input.days) || 30));
    const fn = REPORTS[report] ?? accountOverview;
    try {
      const output = await fn(cfg, days);
      return { output, summary: `google_ads: ${report} (${days}d)` };
    } catch (err) {
      return { output: `Google Ads query failed: ${err instanceof Error ? err.message : String(err)}`, summary: "google_ads: error" };
    }
  },
};
