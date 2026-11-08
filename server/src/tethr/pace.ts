import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serialize, writeAtomic } from "./atomic.js";
import { DAY } from "./time.js";

// How often tethr offers ideas on its own (phase 21). The point is to keep
// people working with tethr without overwhelming them into abandoning it, so
// the pace ADAPTS: ideas that get used or answered earn more; "not now" and
// silence earn fewer. A level set during onboarding (Light / Normal / Busy)
// bounds it, and ideas only go out in working hours. Mechanically it's a token
// bucket: the allowance (ideas per day) refills the bank; an idea spends one.

export type IdeasLevel = "light" | "normal" | "busy";
export const IDEAS_LEVELS_ORDER: IdeasLevel[] = ["light", "normal", "busy"];

export const IDEAS_LEVELS: Record<
  IdeasLevel,
  { label: string; blurb: string; perDay: number; min: number; max: number; weekends: boolean; quietDays: number }
> = {
  light: { label: "Light", blurb: "about 3 a week", perDay: 3 / 7, min: 1 / 7, max: 1, weekends: false, quietDays: 5 },
  normal: { label: "Normal", blurb: "about 1 a day", perDay: 1, min: 2 / 7, max: 2, weekends: false, quietDays: 3 },
  busy: { label: "Busy", blurb: "about 3 a day", perDay: 3, min: 1, max: 5, weekends: true, quietDays: 2 },
};

export type IdeaOutcome = "useful" | "answered" | "not_now" | "ignored";
export const OUTCOME_FACTOR: Record<IdeaOutcome, number> = { useful: 1.25, answered: 1.25, not_now: 0.7, ignored: 0.8 };

/** Working hours in the team's time zone: ideas outside them are dropped, not queued. */
export const HOURS = { start: 8, end: 19 };

export interface PaceState {
  /** Ideas per day right now (moves with the outcomes, inside the level's range). */
  allowance: number;
  /** Ideas available to spend (0..max(1, allowance)). */
  bank: number;
  refilledAt: string;
  /** Ignored ideas in a row (two or more doubles conversation cooldowns). */
  ignoredStreak: number;
  recent: Array<{ at: string; outcome: IdeaOutcome }>;
}

export interface PaceSettings {
  level: IdeasLevel;
  adaptive: boolean;
}

export function initialPace(level: IdeasLevel, now: Date = new Date()): PaceState {
  return { allowance: IDEAS_LEVELS[level].perDay, bank: 1, refilledAt: now.toISOString(), ignoredStreak: 0, recent: [] };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Keep the state inside the current level (a level change re-bounds it), then refill the bank for the time passed. */
export function refill(state: PaceState, settings: PaceSettings, now: Date = new Date()): PaceState {
  const lv = IDEAS_LEVELS[settings.level];
  const allowance = settings.adaptive ? clamp(state.allowance, lv.min, lv.max) : lv.perDay;
  const days = Math.max(0, (now.getTime() - Date.parse(state.refilledAt)) / DAY);
  const cap = Math.max(1, allowance);
  return { ...state, allowance, bank: clamp(state.bank + allowance * days, 0, cap), refilledAt: now.toISOString() };
}

export const canSpend = (state: PaceState) => state.bank >= 1;
export const spend = (state: PaceState): PaceState => ({ ...state, bank: Math.max(0, state.bank - 1) });
/** An idea check that found nothing to say gives its token back. */
export const refund = (state: PaceState): PaceState => ({ ...state, bank: Math.min(Math.max(1, state.allowance), state.bank + 1) });

export function applyOutcome(state: PaceState, settings: PaceSettings, outcome: IdeaOutcome, now: Date = new Date()): PaceState {
  const lv = IDEAS_LEVELS[settings.level];
  return {
    ...state,
    allowance: settings.adaptive ? clamp(state.allowance * OUTCOME_FACTOR[outcome], lv.min, lv.max) : lv.perDay,
    ignoredStreak: outcome === "ignored" ? state.ignoredStreak + 1 : 0,
    recent: [...state.recent, { at: now.toISOString(), outcome }].slice(-20),
  };
}

/** Two or more ideas ignored in a row: wait twice as long before speaking up in a conversation again. */
export const cooldownFactor = (state: PaceState) => (state.ignoredStreak >= 2 ? 2 : 1);

/** Inside working hours in the team's time zone (weekends only at Busy). */
export function withinHours(now: Date, timeZone: string, level: IdeasLevel): boolean {
  let hour = now.getUTCHours();
  let weekday = now.getUTCDay();
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(now);
    hour = Number(parts.find((p) => p.type === "hour")?.value ?? hour);
    const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
    weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
  } catch {
    // unknown zone: judge in UTC
  }
  if ((weekday === 0 || weekday === 6) && !IDEAS_LEVELS[level].weekends) return false;
  return hour >= HOURS.start && hour < HOURS.end;
}

/** "About 1 a day right now", for the setup page. */
export function describeAllowance(allowance: number): string {
  if (allowance >= 1.5) return `about ${Math.round(allowance)} a day`;
  if (allowance >= 0.75) return "about 1 a day";
  const perWeek = Math.max(1, Math.round(allowance * 7));
  return `about ${perWeek} a week`;
}

// ---- the store (instance dir, one entry per company) ------------------------------

function filePath(): string {
  return process.env.TETHR_PACE_FILE || path.resolve(resolvePaperclipInstanceRoot(), "tethr-pace.json");
}

function readAll(): Record<string, PaceState> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getPace(companyId: string, settings: PaceSettings, now: Date = new Date()): PaceState {
  return refill(readAll()[companyId] ?? initialPace(settings.level, now), settings, now);
}

/** Serialized read-modify-write of one company's pace. */
export async function updatePace(
  companyId: string,
  settings: PaceSettings,
  change: (s: PaceState) => PaceState,
  now: Date = new Date(),
): Promise<PaceState> {
  const file = filePath();
  return serialize(file, async () => {
    const all = readAll();
    const next = change(refill(all[companyId] ?? initialPace(settings.level, now), settings, now));
    all[companyId] = next;
    await writeAtomic(file, JSON.stringify(all, null, 2));
    return next;
  });
}
