import type { StudyDepth } from "../assistant/sandbox.js";

// How often the learner watches and how much it studies on its own (Mark,
// 2026-11-10: "I should be able to get sage to run however often I want based on
// how aggressive learning"). A preset, or Custom. The pace becomes the learner's
// routine schedule (cron, in the setup time zone) and its daily cap. Studies a
// person asks for don't count against the pace's cap, only against the ceiling.

export const PACE_PRESETS = ["light", "steady", "aggressive", "custom"] as const;
export type PacePreset = (typeof PACE_PRESETS)[number];
export const CUSTOM_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
/** Studies a day, whatever the pace (asked-for ones included). */
export const STUDY_CEILING = 10;

export interface LearningPace {
  preset: PacePreset;
  /** Custom only. */
  everyHours?: number;
  days?: "weekdays" | "every";
  cap?: number;
  depth?: StudyDepth;
  eager?: boolean;
}

/** When it may pick a deep study on its own. */
export type DeepRule = "never" | "weekly" | "big_gap" | "always";

export interface PaceSchedule {
  cron: string;
  /** Studies a day it starts on its own. */
  cap: number;
  deep: DeepRule;
  /** Eager: study something unless there's truly nothing. Picky: only a clear gap. */
  eager: boolean;
  /** "every weekday morning", for the settings and the switches text. */
  words: string;
}

export const DEFAULT_PACE: LearningPace = { preset: "steady" };

export function paceSchedule(pace: LearningPace = DEFAULT_PACE): PaceSchedule {
  switch (pace.preset) {
    case "light":
      return { cron: "0 9 * * 1,4", cap: 1, deep: "never", eager: false, words: "Monday and Thursday mornings" };
    case "aggressive":
      return { cron: "0 8-18/2 * * 1-5", cap: 6, deep: "big_gap", eager: true, words: "every 2 hours, 8am to 6pm, on weekdays" };
    case "custom": {
      const hours = (CUSTOM_HOURS as readonly number[]).includes(pace.everyHours ?? 0) ? pace.everyHours! : 24;
      const days = pace.days === "every" ? "*" : "1-5";
      const cron = hours === 24 ? `0 9 * * ${days}` : hours === 1 ? `0 * * * ${days}` : `0 */${hours} * * ${days}`;
      const cap = Math.min(STUDY_CEILING, Math.max(1, Math.round(pace.cap ?? 2)));
      const dayWords = pace.days === "every" ? "every day" : "on weekdays";
      const words = hours === 24 ? `every morning ${dayWords}` : `every ${hours === 1 ? "hour" : `${hours} hours`} ${dayWords}`;
      return { cron, cap, deep: pace.depth === "deep" ? "always" : "never", eager: pace.eager ?? false, words };
    }
    default:
      return { cron: "0 9 * * 1-5", cap: 2, deep: "weekly", eager: false, words: "every weekday morning" };
  }
}

/** A pace from a settings form (anything unknown falls back to Steady). */
export function parsePace(raw: unknown): LearningPace {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const preset = (PACE_PRESETS as readonly string[]).includes(String(r.preset)) ? (r.preset as PacePreset) : "steady";
  if (preset !== "custom") return { preset };
  const everyHours = Number(r.everyHours);
  return {
    preset,
    everyHours: (CUSTOM_HOURS as readonly number[]).includes(everyHours) ? everyHours : 24,
    days: r.days === "every" ? "every" : "weekdays",
    cap: Math.min(STUDY_CEILING, Math.max(1, Math.round(Number(r.cap) || 2))),
    depth: r.depth === "deep" ? "deep" : "quick",
    eager: r.eager === true,
  };
}
