import { DAY } from "../time.js";
import {
  AREA_LINKS,
  DATA_LABEL,
  GROWTH_AREAS,
  isAreaId,
  LEVEL_NAMES,
  LIT_LINK_LEVEL,
  UNLOCK_LABEL,
  UNLOCKS,
  type AreaId,
  type AreaSchedule,
  type DataSource,
  type GrowthArea,
  type UnlockKey,
} from "./areas.js";
import { sortIntoArea } from "./sort.js";
import type { AreaAudit, CompanyMapState } from "./store.js";

// The growth map worked out from evidence (phase 26.9). Pure: the caller
// gathers what exists (evidence.ts) and this decides each area's six unlocks.
// Nothing here can be set by hand, by tethr or anyone: a level is only ever
// what the evidence shows, so it drops when the evidence does (a number falls
// behind, a tool is disconnected, an agent is paused).

export const INFORMED_AT = 3;
export const PROVEN_AUDIT_RISE = 10;
/** A rise only counts between audits at least this many days apart (two in one sitting prove nothing). */
export const PROVEN_AUDIT_DAYS = 7;
/** A number proves an area when its last this-many measurements were each on track, and it has moved. */
export const PROVEN_MEASUREMENTS = 2;
/** The focus is the week's; it fades a day after the week is out. */
export const FOCUS_DAYS = 8;

export type PlacedBy = "tethr" | "keywords";

export interface NoteEvidence {
  text: string;
  area?: string;
  savedBy?: string;
  savedAt?: string;
}

export interface MetricEvidence {
  id: string;
  name: string;
  goalTitle: string;
  unit: string;
  baseline: number | null;
  baselineAt: Date | null;
  target: number | null;
  targetDate: Date | null;
  current: number | null;
  /** Its measurements, oldest first (tethr_goal_metrics.history). */
  history: Array<{ at: string; value: number }>;
}

export interface AgentEvidence {
  tag: string;
  name: string;
  title: string;
  mission: string;
  paused: boolean;
  running: boolean;
}

export interface MapEvidence {
  companyName: string;
  /** The company's time zone (setup), for the dates the map shows. */
  timezone?: string;
  state: CompanyMapState;
  notes: NoteEvidence[];
  skills: Array<{ name: string; description: string }>;
  metrics: MetricEvidence[];
  agents: AgentEvidence[];
  data: Record<DataSource, { connected: boolean; detail: string; fix: string }>;
  schedulesOn: AreaSchedule[];
  /** Playbook (skill) names installed on this machine. */
  installedPlaybooks: Set<string>;
}

export type MetricState = "no_target" | "not_measured" | "target_hit" | "on_track" | "behind" | "in_progress";

export const METRIC_STATE_LABEL: Record<MetricState, string> = {
  no_target: "no target yet",
  not_measured: "not measured yet",
  target_hit: "target hit",
  on_track: "on track",
  behind: "behind",
  in_progress: "in progress",
};

export interface UnlockView {
  key: UnlockKey;
  label: string;
  earned: boolean;
  /** Earned: what earned it. Not earned: what would. */
  detail: string;
}

export interface AreaView {
  id: AreaId;
  name: string;
  short: string;
  blurb: string;
  arm: 0 | 1;
  step: number;
  level: number;
  levelName: string;
  unlocks: UnlockView[];
  /** The first unlock not yet earned. */
  next: UnlockView | null;
  hidden: boolean;
  focus: boolean;
  /** An agent is working here right now. */
  active: boolean;
  knowledge: {
    notes: Array<{ text: string; savedBy?: string; savedAt?: string; placedBy: PlacedBy }>;
    skills: Array<{ name: string; description: string; placedBy: PlacedBy }>;
  };
  metrics: Array<{ id: string; name: string; goalTitle: string; unit: string; current: number | null; target: number | null; state: MetricState; placedBy: PlacedBy }>;
  agents: Array<{ tag: string; name: string; paused: boolean; running: boolean; placedBy: PlacedBy }>;
  schedules: string[];
  playbooks: string[];
  data: Array<{ source: DataSource; label: string; connected: boolean; detail: string }>;
  dataNote: string;
  blindSpots: string[];
  lastAudit: AreaAudit | null;
  /** The latest audit's score minus the first one's (null with fewer than two). */
  scoreChange: number | null;
  audits: Array<{ score: number; at: string }>;
}

export interface GrowthMapView {
  company: { name: string; level: number; max: number; timezone?: string };
  focus: { area: AreaId; name: string; at: string; why?: string } | null;
  areas: AreaView[];
  links: Array<{ from: AreaId; to: AreaId; lit: boolean }>;
}

const SCHEDULE_LABEL: Record<AreaSchedule, string> = { scorecard: "the Friday scorecard" };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
/** "Nov 9", in the company's time zone (UTC when it has none or it's not a real zone). */
export function shortDate(iso: string, timeZone?: string): string {
  const when = new Date(iso);
  try {
    return when.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timeZone || "UTC" });
  } catch {
    return when.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  }
}

type LineMetric = Pick<MetricEvidence, "baseline" | "baselineAt" | "target" | "targetDate">;

/** How far from baseline to target a value is (0..1); the scorecard's progressOf. */
function progressOf(m: LineMetric & { target: number }, value: number): number {
  const base = m.baseline ?? 0;
  const span = m.target - base;
  return span === 0 ? (value === m.target ? 1 : 0) : clamp01((value - base) / span);
}

/** The scorecard's rule (ui Scorecard.tsx metricState): where the number stands against its line. */
export function metricState(m: MetricEvidence, now: number): MetricState {
  if (m.target === null) return "no_target";
  if (m.current === null) return "not_measured";
  return stateAt({ ...m, target: m.target }, m.current, now);
}

/** Where a value measured at `ms` stood against the start-to-target line. */
function stateAt(m: LineMetric & { target: number }, value: number, ms: number): Exclude<MetricState, "no_target" | "not_measured"> {
  const progress = progressOf(m, value);
  if (progress >= 1) return "target_hit";
  if (!m.baselineAt || !m.targetDate) return "in_progress";
  const start = m.baselineAt.getTime();
  const end = m.targetDate.getTime();
  if (!(end > start)) return "in_progress";
  const expected = clamp01((ms - start) / (end - start));
  return progress >= expected - 0.1 ? "on_track" : "behind";
}

/**
 * Does this number prove its area? Its last PROVEN_MEASUREMENTS measurements
 * were each on track (or at the target) when they were taken, and the latest has
 * moved off the baseline: a flat number early in its period is "on track" by
 * the line but proves nothing.
 */
export function numberProves(m: MetricEvidence): boolean {
  if (m.target === null) return false;
  const line = { ...m, target: m.target };
  const last = [...m.history].sort((a, b) => a.at.localeCompare(b.at)).slice(-PROVEN_MEASUREMENTS);
  if (last.length < PROVEN_MEASUREMENTS || progressOf(line, last.at(-1)!.value) <= 0) return false;
  return last.every((p) => {
    const state = stateAt(line, p.value, Date.parse(p.at));
    return state === "on_track" || state === "target_hit";
  });
}

/** Each thing's area: the one tethr gave it, else the keyword rules' pick. */
function place<T>(items: T[], explicit: (item: T) => AreaId | null, text: (item: T) => string): Map<AreaId, Array<{ item: T; placedBy: PlacedBy }>> {
  const out = new Map<AreaId, Array<{ item: T; placedBy: PlacedBy }>>();
  for (const item of items) {
    const given = explicit(item);
    const area = given ?? sortIntoArea(text(item));
    if (!area) continue;
    const list = out.get(area) ?? [];
    list.push({ item, placedBy: given ? "tethr" : "keywords" });
    out.set(area, list);
  }
  return out;
}

/** Metrics and agents tethr linked with map_area stay in those areas only; the rest are sorted by keywords. */
function placeLinked<T>(items: T[], idOf: (item: T) => string, linksOf: (area: AreaId) => string[], text: (item: T) => string) {
  const linked = new Map<string, AreaId[]>();
  for (const area of GROWTH_AREAS) {
    for (const id of linksOf(area.id)) linked.set(id, [...(linked.get(id) ?? []), area.id]);
  }
  const out = new Map<AreaId, Array<{ item: T; placedBy: PlacedBy }>>();
  const add = (area: AreaId, item: T, placedBy: PlacedBy) => out.set(area, [...(out.get(area) ?? []), { item, placedBy }]);
  for (const item of items) {
    const areas = linked.get(idOf(item));
    if (areas) for (const area of areas) add(area, item, "tethr");
    else {
      const area = sortIntoArea(text(item));
      if (area) add(area, item, "keywords");
    }
  }
  return out;
}

function audited(record: { audits?: AreaAudit[] } | undefined): { last: AreaAudit | null; change: number | null; apartDays: number } {
  const audits = record?.audits ?? [];
  const last = audits.at(-1) ?? null;
  const first = audits[0];
  return {
    last,
    change: audits.length >= 2 && last ? last.score - first.score : null,
    apartDays: audits.length >= 2 && last ? (Date.parse(last.at) - Date.parse(first.at)) / DAY : 0,
  };
}

interface AreaFacts {
  area: GrowthArea;
  timezone?: string;
  knows: number;
  last: AreaAudit | null;
  change: number | null;
  /** Days between the first and latest audits. */
  apartDays: number;
  data: AreaView["data"];
  dataFix: string;
  metrics: AreaView["metrics"];
  agents: AreaView["agents"];
  schedules: string[];
  provenMetric: AreaView["metrics"][number] | null;
}

function unlockOf(key: UnlockKey, f: AreaFacts): UnlockView {
  const make = (earned: boolean, detail: string): UnlockView => ({ key, label: UNLOCK_LABEL[key], earned, detail });
  switch (key) {
    case "mapped":
      return f.last
        ? make(true, `Audited ${shortDate(f.last.at, f.timezone)}: ${f.last.score} out of 100.`)
        : make(false, "Explore it with tethr: an audit scores it out of 100.");
    case "equipped": {
      const on = f.data.filter((d) => d.connected);
      return on.length ? make(true, on.map((d) => d.detail).join(" ")) : make(false, f.dataFix);
    }
    case "informed":
      return f.knows >= INFORMED_AT
        ? make(true, `tethr knows ${f.knows} things here.`)
        : make(false, `tethr knows ${f.knows} of the ${INFORMED_AT} things it takes: notes or skills about this area.`);
    case "aimed":
      return f.metrics.length
        ? make(true, `Measured by ${f.metrics.map((m) => `“${m.name}”`).join(", ")}.`)
        : make(false, "Tie a goal number to it: ask tethr to measure it, and it links the metric here.");
    case "staffed": {
      const working = f.agents.filter((a) => !a.paused);
      if (working.length) return make(true, `${working.map((a) => a.tag).join(", ")} ${working.length === 1 ? "works" : "work"} it.`);
      if (f.schedules.length) return make(true, `${f.schedules.join(" and ")} covers it.`);
      const paused = f.agents.length ? ` (${f.agents.map((a) => a.tag).join(", ")} is paused)` : "";
      return make(false, `Give it an owner: an agent, or a schedule that's switched on${paused}.`);
    }
    case "proven":
      if (f.provenMetric) return make(true, `“${f.provenMetric.name}” is ${METRIC_STATE_LABEL[f.provenMetric.state]}.`);
      if (f.change !== null && f.change >= PROVEN_AUDIT_RISE && f.apartDays >= PROVEN_AUDIT_DAYS) {
        return make(true, `Its audit score rose ${f.change} points.`);
      }
      if (f.change !== null && f.change >= PROVEN_AUDIT_RISE) {
        return make(false, `Its audit score rose ${f.change} points within a week; it counts once the audits are a week or more apart.`);
      }
      return make(
        false,
        f.metrics.length
          ? `Its number moving and on track at its last ${PROVEN_MEASUREMENTS} measurements, or its audit score up ${PROVEN_AUDIT_RISE} points over a week or more.`
          : `Its audit score up ${PROVEN_AUDIT_RISE} points over a week or more, or a goal number on track.`,
      );
  }
}

export function computeGrowthMap(ev: MapEvidence, now: Date = new Date()): GrowthMapView {
  const ms = now.getTime();
  const state = ev.state;
  const hidden = new Set((state.hidden ?? []).filter(isAreaId));
  const focus = state.focus && isAreaId(state.focus.area) && ms - Date.parse(state.focus.at) < FOCUS_DAYS * DAY ? state.focus : null;

  const notes = place(ev.notes, (n) => (isAreaId(n.area) ? n.area : null), (n) => n.text);
  const skills = place(
    ev.skills,
    (s) => {
      const a = state.skillAreas?.[s.name];
      return isAreaId(a) ? a : null;
    },
    (s) => `${s.name.replace(/[-_.]/g, " ")} ${s.description}`,
  );
  const metrics = placeLinked(ev.metrics, (m) => m.id, (a) => state.areas?.[a]?.metricIds ?? [], (m) => `${m.name} ${m.goalTitle}`);
  const agents = placeLinked(ev.agents, (a) => a.tag, (a) => state.areas?.[a]?.agentTags ?? [], (a) => `${a.title} ${a.mission}`);

  const areas: AreaView[] = GROWTH_AREAS.map((area) => {
    const { last, change, apartDays } = audited(state.areas?.[area.id]);
    const areaNotes = (notes.get(area.id) ?? []).map(({ item, placedBy }) => ({ text: item.text, savedBy: item.savedBy, savedAt: item.savedAt, placedBy }));
    const areaSkills = (skills.get(area.id) ?? []).map(({ item, placedBy }) => ({ ...item, placedBy }));
    const areaMetrics = (metrics.get(area.id) ?? []).map(({ item, placedBy }) => ({
      id: item.id,
      name: item.name,
      goalTitle: item.goalTitle,
      unit: item.unit,
      current: item.current,
      target: item.target,
      state: metricState(item, ms),
      placedBy,
      proves: numberProves(item),
    }));
    const areaAgents = (agents.get(area.id) ?? []).map(({ item, placedBy }) => ({ tag: item.tag, name: item.name, paused: item.paused, running: item.running, placedBy }));
    const data = area.data.map((source) => ({ source, label: DATA_LABEL[source], connected: ev.data[source].connected, detail: ev.data[source].detail }));
    const facts: AreaFacts = {
      area,
      timezone: ev.timezone,
      knows: areaNotes.length + areaSkills.length,
      last,
      change,
      apartDays,
      data,
      dataFix: area.data.map((s) => ev.data[s].fix).join(" Or: "),
      metrics: areaMetrics.map(({ proves: _p, ...m }) => m),
      agents: areaAgents,
      schedules: (area.schedules ?? []).filter((s) => ev.schedulesOn.includes(s)).map((s) => SCHEDULE_LABEL[s]),
      provenMetric: areaMetrics.find((m) => m.proves) ?? null,
    };
    const unlocks = UNLOCKS.map((key) => unlockOf(key, facts));
    const level = unlocks.filter((u) => u.earned).length;
    return {
      id: area.id,
      name: area.name,
      short: area.short,
      blurb: area.blurb,
      arm: area.arm,
      step: area.step,
      level,
      levelName: LEVEL_NAMES[level],
      unlocks,
      next: unlocks.find((u) => !u.earned) ?? null,
      hidden: hidden.has(area.id),
      focus: focus?.area === area.id,
      active: areaAgents.some((a) => a.running),
      knowledge: { notes: areaNotes, skills: areaSkills },
      metrics: facts.metrics,
      agents: areaAgents,
      schedules: facts.schedules,
      playbooks: area.playbooks.filter((p) => ev.installedPlaybooks.has(p)),
      data,
      dataNote: area.dataNote,
      blindSpots: area.blindSpots,
      lastAudit: last,
      scoreChange: change,
      audits: (state.areas?.[area.id]?.audits ?? []).map((a) => ({ score: a.score, at: a.at })),
    };
  });

  const visible = areas.filter((a) => !a.hidden);
  const levelOf = new Map(areas.map((a) => [a.id, a.level]));
  return {
    company: {
      name: ev.companyName,
      level: visible.reduce((n, a) => n + a.level, 0),
      max: visible.length * UNLOCKS.length,
      ...(ev.timezone ? { timezone: ev.timezone } : {}),
    },
    focus: focus ? { area: focus.area, name: areas.find((a) => a.id === focus.area)!.name, at: focus.at, ...(focus.why ? { why: focus.why } : {}) } : null,
    areas,
    links: AREA_LINKS.filter(([a, b]) => !hidden.has(a) && !hidden.has(b)).map(([from, to]) => ({
      from,
      to,
      lit: (levelOf.get(from) ?? 0) >= LIT_LINK_LEVEL && (levelOf.get(to) ?? 0) >= LIT_LINK_LEVEL,
    })),
  };
}

