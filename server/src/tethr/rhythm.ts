import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routines, routineTriggers, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getDefaultCompanyGoal } from "../services/goals.js";
import { goalsService, metricSummaryLines } from "./goals.js";
import { routineService } from "../services/routines.js";
import * as chats from "./chats.js";
import { orgService } from "./org.js";
import { getSetup, RHYTHM_KEYS, type RhythmChoice, type RhythmKey, updateSetup } from "./setup.js";
import { postSlackMessage, slackChannel, slackConfigured } from "./slack.js";

// tethr's working rhythm (phase 20.3): the Monday plan, the Friday scorecard
// and the daily brief Mark picks during setup. Each is a core routine assigned
// to @tethr (so the Routines page, history, pause/resume and time zones all
// come from core); when one fires, the task runs as a turn of the chat's
// Claude session in a fixed "Operations" side chat, with Mark's connectors and
// the goals in its instructions, instead of the old multi-agent engine.

const SAFETY = "Aggregates only: never write down a customer's name, email or health details. Don't send, post, share or spend anything as part of this; anything outward waits for approval in tethr.";

export const RHYTHMS: Record<RhythmKey, { title: string; label: string; playbook: string }> = {
  plan: {
    title: "Weekly plan",
    label: "Monday plan",
    playbook: `Plan the team's week around the goals.
1. Call goals_list for the goals and their latest numbers.
2. Look at last week: the newest scorecard in files/scorecards/ (if any), what's waiting in the Queue, and what moved in the connected tools (Stripe, PostHog, Google Ads).
3. Propose 3 to 5 moves for this week. For each: the goal and metric it moves, exactly what to do, who does it (tethr, or which person on the team, by position), and how we'll know it worked.
4. Save the plan as files/plans/<YYYY-MM-DD> plan.md, then reply with a short summary that leads with the single most important move.
${SAFETY}`,
  },
  scorecard: {
    title: "Weekly scorecard",
    label: "Friday scorecard",
    playbook: `Measure the company's goals.
1. Call goals_list.
2. Measure every metric exactly the way its method says, for the period it describes, with the connected tools.
3. Record each value with record_metric, noting the window you measured.
4. Write files/scorecards/<YYYY-MM-DD>.md: a table of each metric (baseline, last value, now, target and date, on or off track), what moved and the likely reason, and the 1-3 things most worth doing next week.
5. Reply with a short summary that leads with anything off track. If a metric couldn't be measured, say why and what's needed to measure it.
${SAFETY}`,
  },
  brief: {
    title: "Morning brief",
    label: "Daily brief",
    playbook: `Write the admin's morning brief, under 150 words.
- What changed since yesterday that matters for the goals (new customers, revenue, partner conversations), as numbers.
- What's waiting on them: approvals in the Queue, emails or Slack threads that need a reply.
- Today's single most useful focus, tied to a goal.
No file needed unless something is worth keeping.
${SAFETY}`,
  },
};

/** The fixed "Operations" side chat where scheduled work runs (a stable uuid per company). */
export function operationsThreadId(companyId: string): string {
  const h = crypto.createHash("sha256").update(`tethr-operations:${companyId}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Actor = { userId?: string | null; agentId?: string | null };

async function findRoutine(db: Db, companyId: string, key: RhythmKey, choice: RhythmChoice) {
  if (choice.routineId) {
    const [byId] = await db.select().from(routines).where(and(eq(routines.id, choice.routineId), eq(routines.companyId, companyId)));
    if (byId) return byId;
  }
  const [byTitle] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.companyId, companyId), eq(routines.title, RHYTHMS[key].title)));
  return byTitle ?? null;
}

async function scheduleTrigger(db: Db, routineId: string) {
  const [t] = await db
    .select()
    .from(routineTriggers)
    .where(and(eq(routineTriggers.routineId, routineId), eq(routineTriggers.kind, "schedule")));
  return t ?? null;
}

/** Make the core routines match Mark's choices: create or update the chosen
 * ones (on, with his time and zone), pause the rest. Returns the choices with
 * their routine ids. */
export async function applyRhythm(
  db: Db,
  companyId: string,
  choices: Record<RhythmKey, RhythmChoice>,
  timezone: string,
  actor: Actor,
  /** Create these even if they're off (paused), e.g. to run one once. */
  ensure: RhythmKey[] = [],
): Promise<Record<RhythmKey, RhythmChoice>> {
  const router = await orgService(db).getRouterProfile(companyId);
  if (!router) throw new Error("No @tethr agent in this company");
  const goal = await getDefaultCompanyGoal(db, companyId);
  const svc = routineService(db);
  const out = { ...choices };
  for (const key of RHYTHM_KEYS) {
    const choice = choices[key];
    const def = RHYTHMS[key];
    let routine = await findRoutine(db, companyId, key, choice);
    if (!routine && !choice.enabled && !ensure.includes(key)) {
      out[key] = { ...choice, routineId: undefined };
      continue;
    }
    if (!routine) {
      routine = await svc.create(
        companyId,
        {
          title: def.title,
          description: def.playbook,
          assigneeAgentId: router.agent.id,
          goalId: goal?.id ?? null,
          priority: "high",
          status: choice.enabled ? "active" : "paused",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
          variables: [],
        },
        actor,
      );
    } else {
      routine =
        (await svc.update(
          routine.id,
          { description: def.playbook, assigneeAgentId: router.agent.id, status: choice.enabled ? "active" : "paused", goalId: goal?.id ?? null },
          actor,
        )) ?? routine;
    }
    const trigger = await scheduleTrigger(db, routine.id);
    if (trigger) {
      await svc.updateTrigger(trigger.id, { cronExpression: choice.cron, timezone, enabled: choice.enabled, label: def.label }, actor);
    } else {
      await svc.createTrigger(
        routine.id,
        { kind: "schedule", cronExpression: choice.cron, timezone, enabled: choice.enabled, label: def.label } as never,
        actor,
      );
    }
    out[key] = { ...choice, routineId: routine.id };
  }
  return out;
}

/** Run one rhythm item now (e.g. "Measure now"), creating its routine paused if needed. */
export async function runRhythmNow(db: Db, companyId: string, key: RhythmKey, actor: Actor): Promise<{ issueId: string | null }> {
  let setup = getSetup(companyId);
  const savedId = setup.rhythm[key].routineId;
  const exists = savedId
    ? (await db.select({ id: routines.id }).from(routines).where(and(eq(routines.id, savedId), eq(routines.companyId, companyId)))).length > 0
    : false;
  // Not created yet, or deleted on the Routines page since: (re)create it, paused.
  if (!exists) {
    const rhythm = await applyRhythm(db, companyId, setup.rhythm, setup.timezone, actor, [key]);
    setup = await updateSetup(companyId, (s) => ({ ...s, rhythm }));
  }
  const routineId = setup.rhythm[key].routineId!;
  const run = (await routineService(db).runRoutine(routineId, { source: "manual" } as never, actor)) as { linkedIssueId?: string | null } | null;
  return { issueId: run?.linkedIssueId ?? null };
}

/** Is this task one the setup rhythm created (its routine is a rhythm routine)? */
export async function isRhythmTask(db: Db, companyId: string, issueId: string): Promise<boolean> {
  const ids = RHYTHM_KEYS.map((k) => getSetup(companyId).rhythm[k].routineId).filter((id): id is string => !!id);
  if (!ids.length) return false;
  const [row] = await db
    .select({ originKind: issues.originKind, originId: issues.originId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  return !!row && row.originKind === "routine_execution" && !!row.originId && ids.includes(row.originId);
}

export interface ChatTaskResult {
  /** skipped = agents were paused when the turn's time came; nothing ran. */
  status: "done" | "failed" | "skipped";
  text: string;
  runId: string | null;
  outputs: Array<{ outputId: string; title: string; status: string; gated: boolean }>;
}

/** The longest a scheduled turn may take, queue included. Past it the turn is
 * STOPPED (not left running), so the task's result and the chat agree. */
const WAIT_MS = 20 * 60 * 1000;
const STOP_GRACE_MS = 30 * 1000;
const TERMINAL = new Set(["done", "failed", "stopped"]);

/** Run a scheduled task as a turn in the company's Operations chat and wait for it. */
export async function runTaskInOperationsChat(
  db: Db,
  input: { companyId: string; issue: typeof issues.$inferSelect; now?: () => Date; pollMs?: number; waitMs?: number },
): Promise<ChatTaskResult> {
  const { companyId, issue } = input;
  const threadId = operationsThreadId(companyId);
  await chats.addSideChat(companyId, threadId, "Operations");
  const when = (input.now?.() ?? new Date()).toLocaleString("en-US", {
    timeZone: getSetup(companyId).timezone,
    weekday: "long",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const text = `Scheduled: ${issue.title}${issue.identifier ? ` (${issue.identifier})` : ""}, ${when}.\n\n${issue.description ?? ""}`.trim();
  const { getAssistantRunner } = await import("./assistant/runner.js");
  const { routeRunId } = await getAssistantRunner(db).send({ companyId, threadId, text, kind: "system" });

  const runner = getAssistantRunner(db);
  const poll = () => new Promise((r) => setTimeout(r, input.pollMs ?? 2000));
  const read = async () => (await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, routeRunId)))[0];
  let row = await read();
  const deadline = Date.now() + (input.waitMs ?? WAIT_MS);
  while (row && !TERMINAL.has(row.status) && Date.now() < deadline) {
    await poll();
    row = await read();
  }
  let timedOut = false;
  if (row && !TERMINAL.has(row.status)) {
    timedOut = true;
    await runner.stop(routeRunId).catch(() => false);
    const grace = Date.now() + STOP_GRACE_MS;
    while (row && !TERMINAL.has(row.status) && Date.now() < grace) {
      await poll();
      row = await read();
    }
  }
  const outputs = await db
    .select({ id: tethrOutputs.id, title: tethrOutputs.title, status: tethrOutputs.status })
    .from(tethrOutputs)
    .where(eq(tethrOutputs.routeRunId, routeRunId));
  const minutes = Math.max(1, Math.round((input.waitMs ?? WAIT_MS) / 60000));
  // The usage throttle answers a turn with a canned "paused" reply marked done:
  // that's a skipped run, not a finished one.
  const paused = row?.status === "done" && row.llmProvider === "throttle";
  const done = row?.status === "done" && !paused;
  const result: ChatTaskResult = {
    status: paused ? "skipped" : done ? "done" : "failed",
    text: paused
      ? "Skipped: agents were paused when this was due."
      : done
        ? row?.resultText || "Done."
        : timedOut
          ? `Took longer than ${minutes} minutes, so it was stopped. What it did so far is in the Operations chat.`
          : row?.error || "The scheduled turn didn't finish.",
    runId: routeRunId,
    outputs: outputs.map((o) => ({ outputId: o.id, title: o.title, status: o.status, gated: o.status === "gated" || o.status === "changes_requested" })),
  };

  // Slack #tethr, only for the rhythm items Mark chose to post. The post is a
  // heads-up, never the write-up itself: that is model-written from Gmail and
  // Slack and could carry a customer's name or health details, and nothing
  // outward skips the approval gate. The scorecard adds its numbers straight
  // from the goals store (aggregates Mark agreed to).
  const key = RHYTHM_KEYS.find((k) => getSetup(companyId).rhythm[k].routineId === issue.originId);
  if (done && key && getSetup(companyId).rhythm[key].slack && slackConfigured()) {
    const text = await rhythmSlackText(db, companyId, key);
    const res = await postSlackMessage({ channel: slackChannel(), text }).catch((err) => ({ ok: false, error: String(err) }));
    if (!res.ok) logger.warn({ companyId, key, error: (res as { error?: string }).error }, "[tethr] rhythm Slack post failed");
  }
  return result;
}

/** The Slack heads-up for a finished rhythm item: what's ready and where, plus
 * the scorecard's numbers from the goals store. Never the chat's own words. */
export async function rhythmSlackText(db: Db, companyId: string, key: RhythmKey): Promise<string> {
  const base = (process.env.PAPERCLIP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const where = base ? `<${base}/chat?chat=${operationsThreadId(companyId)}|Operations chat>` : "Operations chat";
  const lines = [`*${RHYTHMS[key].label}* is ready in tethr's ${where}.`];
  if (key === "scorecard") {
    const numbers = metricSummaryLines(await goalsService(db).list(companyId));
    if (numbers.length) lines.push("", ...numbers.map((l) => `• ${l}`));
  }
  return lines.join("\n");
}
