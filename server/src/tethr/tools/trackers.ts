import { trackerService, type TrackerName } from "../state.js";
import type { TethrTool } from "./types.js";

const TRACKER_NAMES: TrackerName[] = [
  "content-calendar",
  "destination-tracker",
  "itinerary-calendar",
];

function asTrackerName(value: unknown): TrackerName | null {
  return TRACKER_NAMES.includes(value as TrackerName) ? (value as TrackerName) : null;
}

export const readTrackerTool: TethrTool = {
  name: "read_tracker",
  description:
    "Read a working tracker (content-calendar | destination-tracker | itinerary-calendar) or the published log. Shows queued ideas, rows in review, and what's already published (for dedup).",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        enum: [...TRACKER_NAMES, "published-log"],
      },
    },
    required: ["name"],
  },
  async execute(ctx, input) {
    const trackers = trackerService(ctx.db);
    if (input.name === "published-log") {
      const entries = await trackers.listPublished(ctx.companyId);
      return {
        output: entries.length
          ? entries.map((e) => `- ${e.slug} (${e.kind}) — "${e.title}" @ ${e.publishedAt}`).join("\n")
          : "Nothing published yet.",
        summary: `published-log: ${entries.length} entries`,
      };
    }
    const name = asTrackerName(input.name);
    if (!name) return { output: "Unknown tracker.", summary: "read_tracker: unknown" };
    const tracker = await trackers.readTracker(ctx.companyId, name);
    const lines = tracker.rows.map(
      (r) => `- [${r.status}] ${r.topic} (slug: ${r.slug}${r.pillar ? `, pillar: ${r.pillar}` : ""})${r.claimedBy ? ` claimed by ${r.claimedBy}` : ""}`,
    );
    return {
      output: lines.length ? lines.join("\n") : "Tracker is empty.",
      summary: `${name}: ${tracker.rows.length} rows (${tracker.rows.filter((r) => r.status === "idea").length} ideas)`,
    };
  },
};

export const advanceTrackerTool: TethrTool = {
  name: "advance_tracker",
  description:
    "Advance a tracker atomically: claim_next (take the oldest idea and mark it in-review — do this before drafting) or append_idea (queue one new idea with topic + slug).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", enum: TRACKER_NAMES },
      action: { type: "string", enum: ["claim_next", "append_idea"] },
      topic: { type: "string", description: "For append_idea" },
      slug: { type: "string", description: "For append_idea (kebab-case)" },
      pillar: { type: "string" },
    },
    required: ["name", "action"],
  },
  async execute(ctx, input) {
    const trackers = trackerService(ctx.db);
    const name = asTrackerName(input.name);
    if (!name) return { output: "Unknown tracker.", summary: "advance_tracker: unknown" };

    if (input.action === "claim_next") {
      const row = await trackers.claimNext(ctx.companyId, name, ctx.subagentTag);
      if (!row) {
        return {
          output: "Queue is empty — no ideas to claim. Consider append_idea first.",
          summary: `${name}: queue empty`,
        };
      }
      return {
        output: `Claimed: "${row.topic}" (slug: ${row.slug}${row.pillar ? `, pillar: ${row.pillar}` : ""}). Draft this one.`,
        summary: `${name}: claimed "${row.topic}"`,
      };
    }

    if (input.action === "append_idea") {
      const topic = String(input.topic ?? "").trim();
      const slug = String(input.slug ?? "").trim();
      if (!topic || !slug) {
        return { output: "append_idea needs topic and slug.", summary: "append_idea: missing fields" };
      }
      await trackers.appendIdea(
        ctx.companyId,
        name,
        { topic, slug, pillar: input.pillar ? String(input.pillar) : undefined },
        ctx.subagentTag,
      );
      return { output: `Queued "${topic}" (${slug}).`, summary: `${name}: queued "${topic}"` };
    }

    return { output: "Unknown action.", summary: "advance_tracker: unknown action" };
  },
};
