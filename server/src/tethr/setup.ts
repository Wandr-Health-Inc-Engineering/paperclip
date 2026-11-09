import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serialize, writeAtomic } from "./atomic.js";
import { PACE_LABEL, PACE_UPLIFT, type GrowthPace } from "./goal-pace.js";
import type { IdeasLevel } from "./pace.js";

// Tethr's setup (onboarding) state, phase 20: which steps are done, the goal
// areas Mark chose, his time zone, the working rhythm he picked, and the side
// chat the goals interview runs in. Instance-dir JSON per company (same
// pattern as integrations / overseers): human-owned local config.

export type RhythmKey = "plan" | "scorecard" | "brief";
export const RHYTHM_KEYS: RhythmKey[] = ["plan", "scorecard", "brief"];

export interface RhythmChoice {
  enabled: boolean;
  /** 5-field cron in the setup time zone. */
  cron: string;
  /** Also post the result to Slack #tethr. */
  slack: boolean;
  /** The core routine this choice created (kept so later saves update it). */
  routineId?: string;
}

/** Phase 21: "company" (you and the company) and "focus" (areas + growth pace)
 * replace the old "basics" step (which asked for a typed mission). */
export type SetupStep = "company" | "focus" | "connect" | "interview" | "rhythm";
export const SETUP_STEPS: SetupStep[] = ["company", "focus", "connect", "interview", "rhythm"];

export interface IdeasSettings {
  /** Where the adaptive pace starts and stays within. */
  level: IdeasLevel;
  /** Adapt to how people respond (on), or keep the level's fixed pace. */
  adaptive: boolean;
  /** Listen to Slack conversations tethr is invited into and chime in with ideas. */
  slackListen: boolean;
}

export interface SetupState {
  /** When each step was finished (ISO). */
  steps: Partial<Record<SetupStep, string>>;
  completedAt: string | null;
  areas: string[];
  timezone: string;
  rhythm: Record<RhythmKey, RhythmChoice>;
  /** The side chat the goals interview runs in. */
  interviewThreadId: string | null;
  /** How hard the goals push (the interview's uplift, and how targets adjust). */
  growthPace: GrowthPace;
  /** Let tethr move targets on its own to keep them realistic. */
  autoAdjust: boolean;
  ideas: IdeasSettings;
}

export const DEFAULT_AREAS = ["New customers", "Revenue", "Partnerships & distribution"];

export const DEFAULT_RHYTHM: Record<RhythmKey, RhythmChoice> = {
  plan: { enabled: false, cron: "0 8 * * 1", slack: false },
  scorecard: { enabled: false, cron: "0 15 * * 5", slack: false },
  brief: { enabled: false, cron: "30 7 * * 1-5", slack: false },
};

export function defaultSetup(): SetupState {
  return {
    steps: {},
    completedAt: null,
    areas: [...DEFAULT_AREAS],
    timezone: "America/New_York",
    rhythm: structuredClone(DEFAULT_RHYTHM),
    interviewThreadId: null,
    growthPace: "balanced",
    autoAdjust: true,
    ideas: { level: "normal", adaptive: true, slackListen: true },
  };
}

function filePath(): string {
  return process.env.TETHR_SETUP_FILE || path.resolve(resolvePaperclipInstanceRoot(), "tethr-setup.json");
}

function readAll(): Record<string, Partial<SetupState>> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function getSetup(companyId: string): SetupState {
  const saved = readAll()[companyId] ?? {};
  const base = defaultSetup();
  return {
    ...base,
    ...saved,
    steps: { ...(saved.steps ?? {}) },
    rhythm: Object.fromEntries(RHYTHM_KEYS.map((k) => [k, { ...base.rhythm[k], ...(saved.rhythm?.[k] ?? {}) }])) as SetupState["rhythm"],
    areas: Array.isArray(saved.areas) && saved.areas.length ? saved.areas : base.areas,
    ideas: { ...base.ideas, ...(saved.ideas ?? {}) },
  };
}

/** Serialized read-modify-write; returns the new state. */
export async function updateSetup(companyId: string, change: (s: SetupState) => SetupState): Promise<SetupState> {
  const file = filePath();
  return serialize(file, async () => {
    const all = readAll();
    const next = change(getSetup(companyId));
    all[companyId] = next;
    await writeAtomic(file, JSON.stringify(all, null, 2));
    return next;
  });
}

/** Drop companies from the store (the fresh-start wipe). */
export async function forgetSetup(companyIds: string[]): Promise<void> {
  const file = filePath();
  await serialize(file, async () => {
    const all = readAll();
    let changed = false;
    for (const id of companyIds) {
      if (id in all) {
        delete all[id];
        changed = true;
      }
    }
    if (changed) await writeAtomic(file, JSON.stringify(all, null, 2));
  });
}

/** The first message of the goals interview (a system turn in its own side chat).
 * Its first line is what the chat shows; the rest is tethr's brief. */
export function interviewBrief(
  areas: string[],
  opts: { person?: string | null; company?: string | null; pace?: GrowthPace } = {},
): string {
  const list = areas.length ? areas.join(", ") : DEFAULT_AREAS.join(", ");
  const person = opts.person?.trim() || "the person you're working with";
  const company = opts.company?.trim() || "the company";
  const pace = opts.pace ?? "balanced";
  const uplift = `${Math.round(PACE_UPLIFT[pace] * 100)}%`;
  return `Setup: goals interview
[Setup brief for tethr] You're setting up ${company}'s goals with ${person}, one area at a time: ${list}. This is a conversation: ask one or two questions at a time and wait for the answers. Think out loud, briefly and in plain words, so ${person} can follow your reasoning and push back.

For each area:
1. Ask where things stand and what good would look like, by a date that matters.
2. Before proposing numbers, pull a starting point from the connected tools: aggregate counts and revenue for the last 90 days (Stripe), traffic and conversion (PostHog), ad spend and cost per customer (Google Ads), whichever fits. Before you pull, say in a line what you'll look at and why. After, show what you found: the numbers, the period, and anything odd in them (a spike, a gap, a wave of refunds).
3. Use the connectors' own summaries and analytics for this (for Stripe, its analytics and list calls). Don't download export files or open links to them. If you truly need one, say why first: opening it asks ${person} for approval.
4. Make every target realistic: take the recent trend, project it to the date, then add the growth pace they chose, ${PACE_LABEL[pace]} (about ${uplift} on top of the trend). Show that math in one line.
5. Explain each proposal: why this measure (what it shows that the others don't), why this target (the math, and what would have to be true to hit it), and an easier and a harder option beside it. Ask which they want, or what they'd set instead. If something can only be counted by hand (often true for partnerships), say so and make it a manual metric.
6. Propose 1 to 3 metrics, each with a starting point, a target, a date and exactly how it will be measured every week (source and method). When they agree, save it: save_goal for the area if it isn't saved yet, then save_metric. Never save numbers they haven't agreed to.
7. Say once that tethr will ease or raise targets on its own as real numbers come in, so they stay realistic.

Along the way, fill in Memory.md's sections (The company, Products & prices, Who buys, Channels & partners, Voice & constraints, How the team works) with what you learn. Facts only.

The areas are already saved as goals: call goals_list first. Then greet ${person} in one line, say how this will go (one area at a time, real numbers first, nothing saved without a yes) and start with ${areas[0] ?? DEFAULT_AREAS[0]}.
Aggregates only: never write down a customer's name, email or health details. Don't send, post or spend anything during setup.`;
}

const CRON_FIELD = /^[\d*,/-]+$/;
/** A plain 5-field cron (digits, *, comma, dash, slash). */
export function validCron(cron: unknown): cron is string {
  if (typeof cron !== "string") return false;
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => CRON_FIELD.test(p));
}

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
