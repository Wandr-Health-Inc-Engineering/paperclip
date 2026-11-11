// Google Keyword Planner — real search volume/competition/CPC for content + SEO
// agents (Atlas, Beacon). Ported from scout-wandr-app. READ-ONLY (the idea
// service never changes the account). Reuses the Google Ads auth context.
//
// NOTE: Keyword Planner requires a Basic/Standard Google Ads developer token —
// an Explorer/test token returns DEVELOPER_TOKEN_NOT_APPROVED (surfaced clearly).

import { adsRequestContext, googleAdsConfigured, microsToAmount } from "./google-ads.js";
import type { TethrTool } from "./types.js";

export interface KeywordIdea {
  text: string;
  monthlySearchVolume: number;
  competition: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  averageCpc: number;
  lowTopOfPageCpc: number;
  highTopOfPageCpc: number;
}

export class KeywordPlannerAccessError extends Error {
  code = "DEVELOPER_TOKEN_NOT_APPROVED";
}

/** Parse the Keyword Planner response into typed ideas (pure — unit-tested). */
export function parseKeywordIdeas(results: Array<Record<string, unknown>>): KeywordIdea[] {
  return results.map((row) => {
    const m = (row.keywordIdeaMetrics ?? {}) as Record<string, unknown>;
    return {
      text: String(row.text ?? ""),
      monthlySearchVolume: parseInt(String(m.avgMonthlySearches ?? "0"), 10) || 0,
      competition: ((m.competition as KeywordIdea["competition"]) ?? "UNKNOWN") || "UNKNOWN",
      averageCpc: microsToAmount(parseInt(String(m.averageCpcMicros ?? "0"), 10) || 0),
      lowTopOfPageCpc: microsToAmount(parseInt(String(m.lowTopOfPageBidMicros ?? "0"), 10) || 0),
      highTopOfPageCpc: microsToAmount(parseInt(String(m.highTopOfPageBidMicros ?? "0"), 10) || 0),
    };
  });
}

/** US geo default (2840); English (languageConstants/1000). */
export async function generateKeywordIdeas(
  seedKeywords: string[],
  geoTargetIds: string[] = ["2840"],
): Promise<KeywordIdea[]> {
  const seeds = seedKeywords.map((s) => s.trim()).filter(Boolean).slice(0, 20);
  if (seeds.length === 0) return [];
  const ctx = await adsRequestContext();
  if (!ctx) return [];
  const res = await fetch(
    `https://googleads.googleapis.com/${ctx.version}/customers/${ctx.customerId}:generateKeywordIdeas`,
    {
      method: "POST",
      headers: ctx.headers,
      body: JSON.stringify({
        keywordSeed: { keywords: seeds },
        language: "languageConstants/1000",
        geoTargetConstants: geoTargetIds.map((id) => `geoTargetConstants/${id}`),
        keywordPlanNetwork: "GOOGLE_SEARCH",
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (body.includes("DEVELOPER_TOKEN_NOT_APPROVED") || body.includes("not allowed for use with explorer access")) {
      throw new KeywordPlannerAccessError(
        "Keyword Planner needs a Basic/Standard Google Ads developer token (not Explorer).",
      );
    }
    return []; // other errors: swallowed, return empty
  }
  const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
  return parseKeywordIdeas(data.results ?? []);
}

export const keywordIdeasTool: TethrTool = {
  name: "keyword_ideas",
  description:
    "Real Google search volume, competition, and CPC for seed keywords (Keyword Planner). seeds = up to 20 phrases; geoTargetIds optional (default US 2840). Use for SEO/content topic selection and to avoid zero-volume ideas.",
  inputSchema: {
    type: "object",
    properties: {
      seeds: { type: "array", items: { type: "string" }, description: "seed keywords/phrases (max 20)" },
      geoTargetIds: { type: "array", items: { type: "string" }, description: "geo target ids (default ['2840'] = US)" },
    },
    required: ["seeds"],
    additionalProperties: false,
  },
  async execute(_ctx, input) {
    if (!googleAdsConfigured()) {
      return { output: "Keyword Planner unavailable (GOOGLE_ADS_* env unset).", summary: "keyword_ideas: unconfigured" };
    }
    const seeds = Array.isArray(input.seeds) ? (input.seeds as unknown[]).map(String) : [];
    const geo = Array.isArray(input.geoTargetIds) ? (input.geoTargetIds as unknown[]).map(String) : undefined;
    try {
      const ideas = await generateKeywordIdeas(seeds, geo);
      if (ideas.length === 0) return { output: "No keyword ideas returned.", summary: "keyword_ideas: 0" };
      const lines = ideas
        .sort((a, b) => b.monthlySearchVolume - a.monthlySearchVolume)
        .slice(0, 40)
        .map((k) => `- "${k.text}": ${k.monthlySearchVolume}/mo · ${k.competition} comp · CPC ~$${k.averageCpc.toFixed(2)}`);
      return { output: `Keyword ideas (top ${lines.length} by volume):\n${lines.join("\n")}`, summary: `keyword_ideas: ${ideas.length}` };
    } catch (err) {
      const msg = err instanceof KeywordPlannerAccessError ? err.message : `Keyword Planner failed: ${String(err)}`;
      return { output: msg, summary: "keyword_ideas: error" };
    }
  },
};
