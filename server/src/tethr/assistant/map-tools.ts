import fsp from "node:fs/promises";
import { goalsService, oneLine } from "../goals.js";
import { areaById, AREA_IDS, isAreaId, type AreaId } from "../growth-map/areas.js";
import { growthMap } from "../growth-map/evidence.js";
import { AUDITS_KEPT, getMapState, linkToArea, updateAreaRecord, updateMapState, type AreaAudit } from "../growth-map/store.js";
import { growthMapToolText } from "../growth-map/text.js";
import { HEALTH_REFUSAL, injectionReason, personalHealthReason } from "../screen.js";
import { teamService } from "../team.js";
import { resolveInFiles } from "./files.js";
import { FILES_DIR } from "./workspace.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// Phase 26.9: the growth map's tools on the "tethr" MCP server.
// - growth_map (read): the whole map, or one area in full.
// - map_area (internal, no card): record an audit of one area (score, summary,
//   next steps, the write-up) and which goal metrics and agents belong to it;
//   tethr's own chats also set the week's focus. It never sets a level: the
//   server works the unlocks out from the evidence.
// A private turn (the watcher's idea check) can read the map but not write it:
// the tools endpoint refuses anything that isn't a read there.

export const MAP_TOOL_NAMES = ["growth_map", "map_area"] as const;
export const MAP_TOOL_SET = new Set<string>(MAP_TOOL_NAMES);

export const MAP_LIMITS = { summary: 400, steps: 5, step: 200, why: 200, links: 6 } as const;

export const MAP_TOOL_DEFS: McpToolDef[] = [
  {
    name: "growth_map",
    description:
      "The company's growth map: every growth area with its level (0-6, worked out by Tethr from evidence), its six unlocks and what would earn the next one, its last audit, numbers, owners, playbooks and blind spots. Pass `area` for one area in full, with what tethr knows there.",
    inputSchema: { type: "object", properties: { area: { type: "string", enum: [...AREA_IDS] } } },
  },
  {
    name: "map_area",
    description:
      "Record what you found in one growth area. After auditing it: `score` (0-100, against its playbooks' checklists), `summary` (two sentences: where it stands and why), `next_steps` (up to five, most important first) and `file` (the write-up in ./files/). tethr's own chats also link what belongs to it: `metric_ids` (goal metrics that measure it, from goals_list) and `agent_tags` (team agents that work it); each list replaces the area's earlier links, and a metric or agent belongs to one area only, so linking it here unlinks it elsewhere. They also set this week's `focus` (with `focus_reason`). An agent records audits only for the area it works. Levels aren't set here: Tethr works them out. Aggregates only, never a customer's details or anyone's health information.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", enum: [...AREA_IDS] },
        score: { type: "integer", minimum: 0, maximum: 100 },
        summary: { type: "string", description: `At most ${MAP_LIMITS.summary} characters.` },
        next_steps: { type: "array", items: { type: "string" }, maxItems: MAP_LIMITS.steps },
        file: { type: "string", description: "The audit write-up, e.g. files/growth-map/seo 2026-11-09.md." },
        metric_ids: { type: "array", items: { type: "string" }, maxItems: MAP_LIMITS.links },
        agent_tags: { type: "array", items: { type: "string" }, maxItems: MAP_LIMITS.links },
        focus: { type: "boolean", description: "Make this area the focus this week." },
        focus_reason: { type: "string", description: "Why it's the focus, in a sentence." },
      },
      required: ["area"],
    },
  },
];

export class MapInputError extends Error {}

function screened(text: string, what: string): string {
  if (personalHealthReason(text)) throw new MapInputError(HEALTH_REFUSAL);
  const injected = injectionReason(text);
  if (injected) throw new MapInputError(`The ${what} reads like an instruction, not a finding (${injected}). Reword it as a plain finding.`);
  return text;
}

function stringList(v: unknown, name: string, max: number): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) throw new MapInputError(`${name} must be a list of strings.`);
  if (v.length > max) throw new MapInputError(`${name}: at most ${max}.`);
  return [...new Set(v.map((s) => String(s).trim()).filter(Boolean))];
}

export interface MapAreaInput {
  area: AreaId;
  audit?: Omit<AreaAudit, "at" | "by" | "threadId" | "runId">;
  metricIds?: string[];
  agentTags?: string[];
  focus?: { why?: string };
}

/** Who's calling map_area: tethr's own chats, or an agent (with the areas it works). */
export type MapCaller = { agent: null } | { agent: string; worksIn: AreaId[] };

/** Check map_area's input; throws MapInputError with a plain message. */
export async function parseMapArea(a: Record<string, unknown>, ctx: TethrToolContext, caller: MapCaller): Promise<MapAreaInput> {
  if (!isAreaId(a.area)) throw new MapInputError(`area must be one of: ${AREA_IDS.join(", ")}.`);
  const out: MapAreaInput = { area: a.area };
  // Agents run unattended and read the open web: they audit their own area and nothing else.
  if (caller.agent) {
    if (a.metric_ids !== undefined || a.agent_tags !== undefined || a.focus !== undefined) {
      throw new MapInputError("Only tethr's own chats link numbers and agents or set the week's focus; suggest it in your report.");
    }
    if (!caller.worksIn.includes(a.area)) {
      const where = caller.worksIn.length ? `the area you work (${caller.worksIn.join(", ")})` : "the area you work, and you aren't placed in one yet";
      throw new MapInputError(`${caller.agent} records audits only for ${where}. Say what you found about ${a.area} in your report.`);
    }
  }
  if (a.score !== undefined) {
    const score = a.score;
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) throw new MapInputError("score must be a whole number from 0 to 100.");
    const summary = screened(oneLine(a.summary, MAP_LIMITS.summary), "summary");
    if (!summary) throw new MapInputError("An audit needs a summary: two sentences on where the area stands and why.");
    const steps = (stringList(a.next_steps, "next_steps", MAP_LIMITS.steps) ?? []).map((s) => screened(oneLine(s, MAP_LIMITS.step), "next step"));
    let file: string | undefined;
    if (typeof a.file === "string" && a.file.trim()) {
      const resolved = resolveInFiles(ctx.workspaceDir, a.file, "file");
      if ("error" in resolved) throw new MapInputError(resolved.error);
      const exists = await fsp.stat(resolved.abs).then((s) => s.isFile(), () => false);
      if (!exists) throw new MapInputError(`There's no file ${FILES_DIR}/${resolved.rel}. Write the audit there first.`);
      file = `${FILES_DIR}/${resolved.rel}`;
    }
    out.audit = { score, summary, nextSteps: steps, ...(file ? { file } : {}) };
  } else if (a.summary !== undefined || a.next_steps !== undefined) {
    throw new MapInputError("A summary or next steps come with a score: record the audit's score too.");
  }
  const metricIds = stringList(a.metric_ids, "metric_ids", MAP_LIMITS.links);
  if (metricIds?.length && ctx.db && ctx.companyId) {
    const known = new Set((await goalsService(ctx.db).list(ctx.companyId)).goals.flatMap((g) => g.metrics.map((m) => m.id)));
    const missing = metricIds.filter((id) => !known.has(id));
    if (missing.length) throw new MapInputError(`No goal metric ${missing.join(", ")} (check goals_list).`);
  }
  if (metricIds) out.metricIds = metricIds;
  const agentTags = stringList(a.agent_tags, "agent_tags", MAP_LIMITS.links)?.map((t) => (t.startsWith("@") ? t : `@${t}`));
  if (agentTags?.length && ctx.db && ctx.companyId) {
    const known = new Set((await teamService(ctx.db).list(ctx.companyId)).map((m) => m.tag));
    const missing = agentTags.filter((t) => !known.has(t));
    if (missing.length) throw new MapInputError(`No agent ${missing.join(", ")} on the team (check team_list).`);
  }
  if (agentTags) out.agentTags = agentTags;
  if (a.focus === true) {
    if ((getMapState(ctx.companyId ?? "").hidden ?? []).includes(a.area)) throw new MapInputError("That area is hidden on the growth map; it can't be the focus.");
    const why = screened(oneLine(a.focus_reason, MAP_LIMITS.why), "focus reason");
    out.focus = why ? { why } : {};
  }
  if (!out.audit && !out.metricIds && !out.agentTags && !out.focus) {
    throw new MapInputError("Give a score (with a summary), links (metric_ids, agent_tags) or focus.");
  }
  return out;
}

export async function recordMapArea(companyId: string, input: MapAreaInput, who: { by: string; threadId?: string; runId?: string }, now = new Date()): Promise<void> {
  const at = now.toISOString();
  if (input.audit) {
    await updateAreaRecord(companyId, input.area, (r) => ({ ...r, audits: [...(r.audits ?? []), { ...input.audit!, at, ...who }].slice(-AUDITS_KEPT) }));
  }
  if (input.metricIds || input.agentTags) {
    await linkToArea(companyId, input.area, { metricIds: input.metricIds, agentTags: input.agentTags });
  }
  if (input.focus) {
    await updateMapState(companyId, (s) => ({ ...s, focus: { area: input.area, at, by: who.by, ...(input.focus!.why ? { why: input.focus!.why } : {}) } }));
  }
}

export async function runMapTool(name: string, a: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId) return { text: `${name}: the growth map isn't available here.`, isError: true };
  const { db, companyId } = ctx;
  if (name === "growth_map") {
    const area = typeof a.area === "string" && a.area ? a.area : undefined;
    const view = await growthMap(db, companyId, ctx.now?.());
    return { text: growthMapToolText(view, area), meta: { level: view.company.level, ...(area ? { area } : {}) } };
  }
  // Whose chat this is decides what's allowed; if that can't be looked up the call fails.
  const member = ctx.threadId ? await teamService(db).byThread(companyId, ctx.threadId) : null;
  try {
    const caller: MapCaller = member
      ? { agent: member.tag, worksIn: (await growthMap(db, companyId, ctx.now?.())).areas.filter((x) => x.agents.some((g) => g.tag === member.tag)).map((x) => x.id) }
      : { agent: null };
    const input = await parseMapArea(a, ctx, caller);
    await recordMapArea(
      companyId,
      input,
      { by: member?.tag ?? "@tethr", ...(ctx.threadId ? { threadId: ctx.threadId } : {}), ...(ctx.runId ? { runId: ctx.runId } : {}) },
      ctx.now?.(),
    );
    const view = await growthMap(db, companyId, ctx.now?.());
    const area = view.areas.find((x) => x.id === input.area)!;
    const did = [
      input.audit ? `the audit (${input.audit.score}/100)` : null,
      input.metricIds ? `${input.metricIds.length} metric link${input.metricIds.length === 1 ? "" : "s"}` : null,
      input.agentTags ? `${input.agentTags.length} agent link${input.agentTags.length === 1 ? "" : "s"}` : null,
      input.focus ? "this week's focus" : null,
    ].filter(Boolean);
    const next = area.next ? ` Next unlock: ${area.next.label} (${area.next.detail})` : " All six unlocked.";
    return {
      text: `Recorded ${did.join(", ")} for ${areaById(input.area).name}. It's level ${area.level} ${area.levelName}; the company is at ${view.company.level} of ${view.company.max}.${next}`,
      meta: { area: input.area, level: area.level, ...(input.audit ? { score: input.audit.score } : {}) },
    };
  } catch (err) {
    if (err instanceof MapInputError) return { text: `map_area: ${err.message}`, isError: true };
    throw err;
  }
}
