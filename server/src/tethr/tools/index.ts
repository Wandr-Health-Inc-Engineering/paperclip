import type { tethrSubagents } from "@paperclipai/db";
import {
  driveListTool,
  driveReadTool,
  driveWriteTool,
  escalateTool,
  notifyTool,
  recallMemoryTool,
  stageOrgChangeTool,
} from "./internal.js";
import { googleAdsReportTool } from "./google-ads.js";
import { keywordIdeasTool } from "./keyword-planner.js";
import { advanceTrackerTool, readTrackerTool } from "./trackers.js";
import { cdcScanTool, redditScanTool, webFetchTool } from "./web.js";
import type { TethrTool } from "./types.js";

export type { TethrTool, TethrToolContext, TethrToolResult } from "./types.js";
export { liveFetchEnabled } from "./types.js";

const ALL_TOOLS: Record<string, TethrTool> = Object.fromEntries(
  [
    webFetchTool,
    redditScanTool,
    cdcScanTool,
    driveListTool,
    driveReadTool,
    driveWriteTool,
    recallMemoryTool,
    escalateTool,
    notifyTool,
    readTrackerTool,
    advanceTrackerTool,
    googleAdsReportTool,
    keywordIdeasTool,
    stageOrgChangeTool,
  ].map((t) => [t.name, t]),
);

// Per-subagent allowlists, derived from each spec's `reads`. Baseline for
// everyone: read the Drive + recall memory. Web reach and tracker writes are
// granted only where the spec calls for them. Nothing here can publish —
// publishing only happens through the gating service.
// Every agent can read the Drive, recall memory, and raise a hand to its human
// overseer. Escalation is universal — that's the point of the overseer model.
const BASELINE = ["drive_list", "drive_read", "recall_memory", "escalate"];

const ALLOWLIST: Record<string, string[]> = {
  // Tethr — the coordinator (Phase 11 clean slate). Chat answers directly and
  // may pull read-only reports; Plan drafts internal docs. Neither can publish.
  "tethr.chat": ["web_fetch", "google_ads_report"],
  "tethr.plan": ["web_fetch", "drive_write", "keyword_ideas"],
  // Tinkr — the org mechanic (Phase 12). The ONLY subagent that can stage
  // agent modifications; nothing applies without a human approval in the Queue.
  "tinkr.change": ["stage_org_change"],
  // Sonar — the scout
  "sonar.leads": ["reddit_scan", "web_fetch", "notify"],
  "sonar.reply": ["reddit_scan"],
  "sonar.news": ["cdc_scan", "web_fetch"],
  // Atlas — content
  "atlas.blog": ["read_tracker", "advance_tracker", "web_fetch", "drive_write", "keyword_ideas"],
  "atlas.geo": ["drive_write"],
  "atlas.keywords": ["read_tracker", "advance_tracker", "web_fetch", "keyword_ideas"],
  // Compass — briefs
  "compass.brief": ["read_tracker", "advance_tracker", "web_fetch", "cdc_scan", "drive_write"],
  // Voyager — itineraries
  "voyager.draft": ["read_tracker", "advance_tracker", "web_fetch", "drive_write"],
  "voyager.health": ["cdc_scan", "web_fetch"],
  // Tailwind — ads (READ-ONLY Google Ads analysis; changes stay human-approved)
  "tailwind.analyze": ["google_ads_report"],
  "tailwind.bids": ["google_ads_report"],
  "tailwind.copy": [],
  "tailwind.negatives": ["google_ads_report"],
  // Ledger — analytics (Google Ads + PostHog read)
  "ledger.guardrails": ["google_ads_report"],
  "ledger.modeler": ["google_ads_report"],
  "ledger.reporter": ["drive_write", "notify", "google_ads_report"],
  // Herald — PR
  "herald.press": ["read_tracker", "web_fetch", "drive_write"],
  "herald.pickup": ["web_fetch"],
  "herald.announce": [],
  // Beacon — strategy
  "beacon.icp": ["web_fetch", "keyword_ideas"],
  "beacon.messaging": ["web_fetch", "keyword_ideas"],
  "beacon.brand": [],
};

export function toolsetForSubagent(
  subagent: Pick<typeof tethrSubagents.$inferSelect, "tag" | "tools">,
): TethrTool[] {
  const key = subagent.tag.replace(/^@/, "");
  // An explicit DB grant (factory-born agents) is authoritative; a null grant
  // falls back to the static allowlist (the original hand-built agents). This is
  // what lets the CEO's tool choices actually reach a created agent at run time —
  // previously every factory agent got baseline-only and couldn't fetch a thing.
  const extra = subagent.tools ?? ALLOWLIST[key] ?? [];
  const names = [...BASELINE, ...extra];
  // Dedupe + hard-filter to the registry (an unknown/typo'd tool name is dropped,
  // never invented).
  const seen = new Set<string>();
  return names
    .filter((n) => !seen.has(n) && seen.add(n))
    .map((n) => ALL_TOOLS[n])
    .filter((t): t is TethrTool => Boolean(t));
}

export function getToolByName(name: string): TethrTool | null {
  return ALL_TOOLS[name] ?? null;
}
