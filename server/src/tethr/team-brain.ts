import fs from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serialize, writeAtomic } from "./atomic.js";
import { logFailure } from "./best-effort.js";
import * as chats from "./chats.js";
import { getIntegrations, type TeamAutonomy } from "./integrations.js";
import { getSetup } from "./setup.js";
import { isAgentsPaused } from "./throttle.js";
import { MINUTE } from "./time.js";

// Phase 24: tethr is the brain. Besides answering the person, it can act on its
// own, in the main chat (the one place they look), when they've switched it on
// in Integrations → Team (all off by default):
// - Check-in: when agents' reports come in, a few quiet minutes later tethr
//   runs ONE turn to decide what happens next (follow-ups, adjust an agent,
//   propose an agent or sub-team, or flag what needs the person).
// - Daily review: once a day at the chosen time, tethr checks goals against
//   pace and the team, and decides the day's moves.
// Both are bounded by a cap on self-started turns a day and stop while agents
// are paused (the usage throttle). State lives in the instance dir.

/** How long reports must sit quiet before the check-in (they often arrive together). */
export const CHECK_IN_QUIET_MS = 3 * MINUTE;
/** A daily review that's this late (minutes past its time) waits for tomorrow instead. */
export const REVIEW_WINDOW_MINUTES = 180;
const PENDING_MAX = 20;

export interface PendingReport {
  tag: string;
  title: string;
  outcome: string;
  /** ISO time it arrived. */
  at: string;
}

interface CompanyBrain {
  pending: PendingReport[];
  /** The local day `selfTurns` counts for. */
  day: string | null;
  selfTurns: number;
  lastReviewDay: string | null;
}

type BrainFile = Record<string, CompanyBrain>;

const EMPTY: CompanyBrain = { pending: [], day: null, selfTurns: 0, lastReviewDay: null };

function filePath(): string {
  return process.env.TETHR_BRAIN_FILE || path.resolve(resolvePaperclipInstanceRoot(), "tethr-brain.json");
}

function readFile(): BrainFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as BrainFile) : {};
  } catch {
    return {};
  }
}

function getBrain(companyId: string): CompanyBrain {
  return { ...EMPTY, ...(readFile()[companyId] ?? {}) };
}

function updateBrain(companyId: string, change: (b: CompanyBrain) => CompanyBrain): Promise<CompanyBrain> {
  const file = filePath();
  return serialize(file, async () => {
    const data = readFile();
    const next = change({ ...EMPTY, ...(data[companyId] ?? {}) });
    data[companyId] = next;
    await writeAtomic(file, JSON.stringify(data, null, 2));
    return next;
  });
}

/** A report reached the main chat. Remembered only while check-ins are on. */
export async function noteReport(companyId: string, report: Omit<PendingReport, "at">, now: Date = new Date()): Promise<void> {
  if (!getIntegrations(companyId).team.autonomy.actOnReports) return;
  await updateBrain(companyId, (b) => ({ ...b, pending: [...b.pending, { ...report, at: now.toISOString() }].slice(-PENDING_MAX) }));
}

/** The local day (YYYY-MM-DD), minutes since midnight and weekday (0 = Sunday) in a time zone. */
export function localClock(now: Date, timeZone: string): { day: string; minutes: number; weekday: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "");
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Is it time for today's review? (After its time, within the window, on an allowed day, not done today.) */
export function reviewDue(review: TeamAutonomy["dailyReview"], clock: ReturnType<typeof localClock>, lastReviewDay: string | null): boolean {
  if (!review.enabled || lastReviewDay === clock.day) return false;
  if (review.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) return false;
  const late = clock.minutes - minutesOf(review.time);
  return late >= 0 && late <= REVIEW_WINDOW_MINUTES;
}

/** The check-in turn. Its first line is what the chat shows. */
export function checkInBrief(pending: PendingReport[]): string {
  const tags = [...new Set(pending.map((p) => p.tag))];
  const n = pending.length;
  return [
    `Check-in: ${n === 1 ? "a report" : `${n} reports`} from ${tags.join(", ")}`,
    "[Brief for tethr] Reports just came in from your team (they're in your notes and as cards in this chat):",
    ...pending.map((p) => `- ${p.tag}: ${p.title} (${p.outcome})`),
    "As the team's lead, decide what happens next: hand out follow-up work (assign_task), adjust or pause an agent (update_agent), propose an agent or a sub-team for an effort that needs an owner (create_agent, with the goal it moves), or flag what needs the person. Act with your team tools, then tell the person in two to four lines what came back and what you did. If nothing needs doing, say so in one line.",
  ].join("\n");
}

/** The daily review turn. */
export function dailyReviewBrief(): string {
  return [
    "Daily review",
    "[Brief for tethr] Your daily review as the team's lead. Check the goals against their targets (goals_list), your team (team_list) and what came back since your last review.",
    "Decide today's moves: hand out tasks, adjust or pause agents, and propose an agent (with the goal it moves) for any effort that has no owner yet. Act with your team tools, then post a short list: what you did, and what needs the person (approvals waiting, decisions). Keep it brief; if nothing needs doing, say so in a line.",
  ].join("\n");
}

type SendFn = (input: { companyId: string; threadId: string; text: string; kind: "system" }) => Promise<unknown>;

export function brainService(db: Db, deps: { send?: SendFn } = {}) {
  async function send(companyId: string, text: string): Promise<void> {
    const fn: SendFn = deps.send ?? (async (input) => (await import("./assistant/runner.js")).getAssistantRunner(db).send(input));
    await fn({ companyId, threadId: chats.mainThreadId(companyId), text, kind: "system" });
  }

  /** One company: run a check-in or the daily review if one is due. */
  async function tickCompany(companyId: string, now: Date): Promise<"check-in" | "review" | null> {
    const autonomy = getIntegrations(companyId).team.autonomy;
    if (!autonomy.actOnReports && !autonomy.dailyReview.enabled) return null;
    if (isAgentsPaused(companyId)) return null;
    const clock = localClock(now, getSetup(companyId).timezone);
    const brain = getBrain(companyId);
    const used = brain.day === clock.day ? brain.selfTurns : 0;
    if (used >= autonomy.maxSelfTurnsPerDay) return null;

    if (autonomy.actOnReports && brain.pending.length) {
      const latest = Math.max(...brain.pending.map((p) => Date.parse(p.at)));
      if (now.getTime() - latest >= CHECK_IN_QUIET_MS) {
        await updateBrain(companyId, (b) => ({ ...b, pending: [], day: clock.day, selfTurns: used + 1 }));
        await send(companyId, checkInBrief(brain.pending));
        return "check-in";
      }
    }
    if (reviewDue(autonomy.dailyReview, clock, brain.lastReviewDay)) {
      await updateBrain(companyId, (b) => ({ ...b, lastReviewDay: clock.day, day: clock.day, selfTurns: used + 1 }));
      await send(companyId, dailyReviewBrief());
      return "review";
    }
    return null;
  }

  /** Every company, once (the boot loop calls this each minute). */
  async function tick(now: Date = new Date()): Promise<Record<string, "check-in" | "review" | null>> {
    const rows = await db.select({ id: companies.id }).from(companies);
    const out: Record<string, "check-in" | "review" | null> = {};
    for (const { id } of rows) {
      out[id] = await tickCompany(id, now).catch((err) => {
        logFailure("brain tick", { companyId: id })(err);
        return null;
      });
    }
    return out;
  }

  return { tick, tickCompany };
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Server boot: tick once a minute. Never under tests. */
export function startBrain(db: Db): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test" || timer) return;
  const brain = brainService(db);
  timer = setInterval(() => void brain.tick().catch(() => {}), MINUTE);
  timer.unref?.();
}
