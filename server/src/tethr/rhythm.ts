import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, routines, routineTriggers, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { getDefaultCompanyGoal } from "../services/goals.js";
import { routineService } from "../services/routines.js";
import * as chats from "./chats.js";
import { orgService } from "./org.js";
import { getSetup, RHYTHM_KEYS, type RhythmChoice, type RhythmKey, updateSetup } from "./setup.js";
import { chunkSlackText, postSlackMessage, slackChannel, slackConfigured, toSlackMrkdwn } from "./slack.js";

// tethr's working rhythm (phase 20.3): the Monday plan, the Friday scorecard
// and the daily brief Mark picks during setup. Each is a core routine assigned
// to @tethr (so the Routines page, history, pause/resume and time zones all
// come from core); when one fires, the task runs as a turn of the chat's
// Claude session in a fixed "Operations" side chat, with Mark's connectors and
// the goals in its instructions, instead of the old multi-agent engine.

const SAFETY = "Aggregates only: never write down a customer's name, email or health details. Don't send, post, share or spend anything as part of this; anything outward waits for Mark's approval.";

export const RHYTHMS: Record<RhythmKey, { title: string; label: string; playbook: string }> = {
  plan: {
    title: "Weekly plan",
    label: "Monday plan",
    playbook: `Plan Wandr's week around the goals.
1. Call goals_list for the goals and their latest numbers.
2. Look at last week: the newest scorecard in files/scorecards/ (if any), what's waiting in the Queue, and what moved in the connected tools (Stripe, PostHog, Google Ads).
3. Propose 3 to 5 moves for this week. For each: the goal and metric it moves, exactly what to do, who does it (tethr or Mark), and how we'll know it worked.
4. Save the plan as files/plans/<YYYY-MM-DD> plan.md, then reply with a short summary that leads with the single most important move.
${SAFETY}`,
  },
  scorecard: {
    title: "Weekly scorecard",
    label: "Friday scorecard",
    playbook: `Measure Wandr's goals.
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
    playbook: `Write Mark's morning brief, under 150 words.
- What changed since yesterday that matters for the goals (new customers, revenue, partner conversations), as numbers.
- What's waiting on Mark: approvals in the Queue, emails or Slack threads that need him.
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
  if (!setup.rhythm[key].routineId) {
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
  status: "done" | "failed";
  text: string;
  runId: string | null;
  outputs: Array<{ outputId: string; title: string; status: string; gated: boolean }>;
}

const WAIT_MS = 16 * 60 * 1000;
const TERMINAL = new Set(["done", "failed", "stopped"]);

/** Run a scheduled task as a turn in the company's Operations chat and wait for it. */
export async function runTaskInOperationsChat(
  db: Db,
  input: { companyId: string; issue: typeof issues.$inferSelect; now?: () => Date; pollMs?: number },
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

  const deadline = Date.now() + WAIT_MS;
  let row: typeof tethrRouteRuns.$inferSelect | undefined;
  for (;;) {
    [row] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, routeRunId));
    if (!row || TERMINAL.has(row.status) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, input.pollMs ?? 2000));
  }
  const outputs = await db
    .select({ id: tethrOutputs.id, title: tethrOutputs.title, status: tethrOutputs.status })
    .from(tethrOutputs)
    .where(eq(tethrOutputs.routeRunId, routeRunId));
  const done = row?.status === "done";
  const result: ChatTaskResult = {
    status: done ? "done" : "failed",
    text: done ? row?.resultText || "Done." : row?.error || (row && !TERMINAL.has(row.status) ? "Still running after 16 minutes; see the Operations chat." : "The scheduled turn didn't finish."),
    runId: routeRunId,
    outputs: outputs.map((o) => ({ outputId: o.id, title: o.title, status: o.status, gated: o.status === "gated" || o.status === "changes_requested" })),
  };

  // Slack #tethr, only for the rhythm items Mark chose to post.
  const key = RHYTHM_KEYS.find((k) => getSetup(companyId).rhythm[k].routineId === issue.originId);
  if (done && key && getSetup(companyId).rhythm[key].slack && slackConfigured()) {
    const body = toSlackMrkdwn(`*${RHYTHMS[key].label}*\n${result.text}`);
    for (const chunk of chunkSlackText(body)) {
      const res = await postSlackMessage({ channel: slackChannel(), text: chunk }).catch((err) => ({ ok: false, error: String(err) }));
      if (!res.ok) {
        logger.warn({ companyId, key, error: (res as { error?: string }).error }, "[tethr] rhythm Slack post failed");
        break;
      }
    }
  }
  return result;
}
