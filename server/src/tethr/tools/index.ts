import type { tethrSubagents } from "@paperclipai/db";
import {
  driveListTool,
  driveReadTool,
  driveWriteTool,
  notifyTool,
  recallMemoryTool,
} from "./internal.js";
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
    notifyTool,
    readTrackerTool,
    advanceTrackerTool,
  ].map((t) => [t.name, t]),
);

// Per-subagent allowlists, derived from each spec's `reads`. Baseline for
// everyone: read the Drive + recall memory. Web reach and tracker writes are
// granted only where the spec calls for them. Nothing here can publish —
// publishing only happens through the gating service.
const BASELINE = ["drive_list", "drive_read", "recall_memory"];

const ALLOWLIST: Record<string, string[]> = {
  // Sonar — the scout
  "sonar.leads": ["reddit_scan", "web_fetch", "notify"],
  "sonar.reply": ["reddit_scan"],
  "sonar.news": ["cdc_scan", "web_fetch"],
  // Atlas — content
  "atlas.blog": ["read_tracker", "advance_tracker", "web_fetch", "drive_write"],
  "atlas.geo": ["drive_write"],
  "atlas.keywords": ["read_tracker", "advance_tracker", "web_fetch"],
  // Compass — briefs
  "compass.brief": ["read_tracker", "advance_tracker", "web_fetch", "cdc_scan", "drive_write"],
  // Voyager — itineraries
  "voyager.draft": ["read_tracker", "advance_tracker", "web_fetch", "drive_write"],
  "voyager.health": ["cdc_scan", "web_fetch"],
  // Tailwind — ads (read/analyze only; no web reach needed locally)
  "tailwind.analyze": [],
  "tailwind.bids": [],
  "tailwind.copy": [],
  "tailwind.negatives": [],
  // Ledger — analytics
  "ledger.guardrails": [],
  "ledger.modeler": [],
  "ledger.reporter": ["drive_write", "notify"],
  // Herald — PR
  "herald.press": ["read_tracker", "web_fetch", "drive_write"],
  "herald.pickup": ["web_fetch"],
  "herald.announce": [],
  // Beacon — strategy
  "beacon.icp": ["web_fetch"],
  "beacon.messaging": ["web_fetch"],
  "beacon.brand": [],
};

export function toolsetForSubagent(
  subagent: Pick<typeof tethrSubagents.$inferSelect, "tag">,
): TethrTool[] {
  const key = subagent.tag.replace(/^@/, "");
  const extra = ALLOWLIST[key] ?? [];
  const names = [...BASELINE, ...extra];
  return names.map((n) => ALL_TOOLS[n]).filter((t): t is TethrTool => Boolean(t));
}

export function getToolByName(name: string): TethrTool | null {
  return ALL_TOOLS[name] ?? null;
}
