import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serialize, writeAtomic } from "./atomic.js";

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

export type SetupStep = "basics" | "connect" | "interview" | "rhythm";
export const SETUP_STEPS: SetupStep[] = ["basics", "connect", "interview", "rhythm"];

export interface SetupState {
  /** When each step was finished (ISO). */
  steps: Partial<Record<SetupStep, string>>;
  completedAt: string | null;
  areas: string[];
  timezone: string;
  rhythm: Record<RhythmKey, RhythmChoice>;
  /** The side chat the goals interview runs in. */
  interviewThreadId: string | null;
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
export function interviewBrief(areas: string[]): string {
  const list = areas.length ? areas.join(", ") : DEFAULT_AREAS.join(", ");
  return `Setup: goals interview
[Setup brief for tethr] You're setting up Wandr's goals with Mark, one area at a time: ${list}. This is a conversation: ask one or two questions at a time and wait for his answers.

For each area:
1. Ask where things stand and what good would look like, by a date he cares about.
2. Before proposing numbers, pull a baseline from the connected tools: aggregate counts and revenue for the last 90 days (Stripe), traffic and conversion (PostHog), ad spend and cost per customer (Google Ads), whichever fits. Say what you measured and how.
3. Propose 1 to 3 metrics, each with a baseline, a target and a target date, and exactly how it will be measured every week (source and method). If something can only be counted by hand (often true for partnerships), say so and make it a manual metric.
4. When Mark agrees, save it: save_goal for the area if it isn't saved yet, then save_metric with the baseline, target, date and method. Never save numbers he hasn't agreed to.

Along the way, fill in Memory.md's sections (Products & prices, Who buys, Channels & partners, Voice & constraints, How Mark works) with what you learn. Facts only.

The mission and the areas are already saved as goals: call goals_list first. Then greet Mark in one line and start with ${areas[0] ?? DEFAULT_AREAS[0]}.
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
