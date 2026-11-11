import { and, eq, gte, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { chatTaskResult, turnOutputs, waitForTurn, type ChatTaskResult } from "./assistant/turns.js";
import { openQuestions } from "./assistant/questions.js";
import { getIntegrations } from "./integrations.js";
import { deliverAgentReport, type ReportOutcome } from "./team-report.js";
import { agentRollupText, agentTaskText, type AgentIdentity, type ChildResult } from "./team-spec.js";
import { teamService, type TeamAgent } from "./team.js";
import type { TaskService } from "./tasks.js";
import type { SlackPoster } from "./watch.js";
import { MINUTE, SECOND } from "./time.js";

// Phase 23-24: an agent on tethr's team works a task (an assignment, or its
// routine's scheduled run) as a system turn in its own chat thread, with its
// instructions in the turn. tethr waits for the turn (≤ 20 minutes, then stops
// it), comments the result on the task, moves the task, and the agent reports
// back (team-report.ts).
//
// A LEAD may hand parts of its task to its sub-team (assign_task from its chat
// makes them sub-tasks: core child issues of this task). Then the task waits
// (`blocked`) with no report; when the last sub-task closes, core wakes the
// lead (issue_children_completed) and it runs a roll-up turn with the sub-team's
// results, and that turn's report is the one that goes to tethr.

const AGENT_TURN_MAX_MS = 20 * MINUTE;
const CLOSED = ["done", "cancelled"];

type IssueRow = typeof issues.$inferSelect;

/** The task each running agent turn is working, so a lead's assign_task can
 * make a sub-task of it. In memory: a turn runs in this process. */
const issueByRun = new Map<string, string>();

export function taskIssueForRun(runId: string): string | null {
  return issueByRun.get(runId) ?? null;
}

export interface AgentTaskResult extends Omit<ChatTaskResult, "status"> {
  /** capped = over its daily runs, nothing ran; delegated = waiting on its sub-team. */
  status: ChatTaskResult["status"] | "capped" | "delegated";
}

async function openChildren(db: Db, issueId: string): Promise<number> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.parentId, issueId), notInArray(issues.status, CLOSED)));
  return rows.length;
}

/** Sub-tasks created since `since` (a lead handed work out during this turn), whatever their status. */
async function childrenSince(db: Db, issueId: string, since: Date): Promise<number> {
  const rows = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.parentId, issueId), gte(issues.createdAt, since)));
  return rows.length;
}

/** Run one task (or, with `rollup`, the roll-up of its sub-tasks) in the agent's chat, and report the result. */
export async function runTaskInAgentChat(
  db: Db,
  input: {
    companyId: string;
    agent: TeamAgent;
    issue: IssueRow;
    /** The sub-team's results: this turn is the roll-up. */
    rollup?: ChildResult[] | null;
    waitMs?: number;
    pollMs?: number;
    post?: SlackPoster;
  },
): Promise<AgentTaskResult> {
  const { companyId, agent, issue } = input;
  const team = teamService(db);
  const report = (outcome: ReportOutcome, text: string, runId: string | null) =>
    deliverAgentReport(
      db,
      { companyId, agent, title: issue.title, identifier: issue.identifier, outcome, text, runId, partOfLeadTask: !!issue.parentId },
      { post: input.post },
    );

  // The learner's scheduled run starts a study: it looks at what's been happening and
  // picks what to learn (or nothing). Its study cards report it, not a task report.
  if (agent.sandbox) {
    const { startStudy, StudyError } = await import("./learn/study.js");
    try {
      const study = await startStudy(db, companyId, { trigger: "observed", by: agent.tag });
      return { status: "done", text: `${agent.tag} is looking at what's been happening; its card in its chat shows what it picks.`, runId: study.cardRunId, outputs: [] };
    } catch (err) {
      if (err instanceof StudyError) return { status: "skipped", text: `Didn't run: ${err.message}`, runId: null, outputs: [] };
      throw err;
    }
  }

  // The roll-up closes work already started, so it isn't held back by the cap.
  if (!input.rollup && (await team.runsToday(agent.agentId)) >= agent.maxRunsPerDay) {
    const text = `Didn't run: ${agent.tag} has used its ${agent.maxRunsPerDay} runs for today. Assign it again tomorrow, or raise its limit.`;
    await report("capped", text, null);
    return { status: "capped", text, runId: null, outputs: [] };
  }

  const identity: AgentIdentity = { ...agent, subTeam: agent.lead ? (await team.subTeam(companyId, agent.tag)).map((a) => a.tag) : [] };
  const text = input.rollup
    ? agentRollupText(identity, { identifier: issue.identifier, title: issue.title }, input.rollup)
    : agentTaskText(identity, {
        identifier: issue.identifier,
        title: issue.title,
        brief: issue.description,
      });
  const { getAssistantRunner } = await import("./assistant/runner.js");
  const turnStart = new Date(Date.now() - 1_000);
  const { routeRunId } = await getAssistantRunner(db).send({ companyId, threadId: agent.threadId, text, kind: "system", task: true });
  issueByRun.set(routeRunId, issue.id);
  const waitMs = input.waitMs ?? AGENT_TURN_MAX_MS;
  let result: ChatTaskResult;
  try {
    const { row, timedOut } = await waitForTurn(db, routeRunId, { waitMs, pollMs: input.pollMs ?? 2 * SECOND });
    result = chatTaskResult(row, { runId: routeRunId, timedOut, waitMs, outputs: await turnOutputs(db, routeRunId), chatName: `${agent.tag}'s chat` });
  } finally {
    issueByRun.delete(routeRunId);
  }
  // Handed parts to its sub-team: the report comes with the roll-up (even if
  // the sub-team was quick and has already finished).
  if (result.status === "done" && !input.rollup && (await childrenSince(db, issue.id, turnStart)) > 0) {
    return { ...result, status: "delegated" };
  }
  const outcome: ReportOutcome = result.status === "done" && result.outputs.some((o) => o.gated) ? "waiting" : result.status;
  await report(outcome, result.text, routeRunId);
  return result;
}

/** The tethr_llm adapter's path for a team agent's task (adapter.ts executeTask). */
export async function executeTeamTask(
  db: Db,
  input: { ctx: AdapterExecutionContext; issueId: string; issue: IssueRow; tasks: TaskService; agentTag: string },
): Promise<AdapterExecutionResult> {
  const { ctx, issueId, issue, tasks } = input;
  const companyId = ctx.agent.companyId;
  const agent = await teamService(db).byAgentId(companyId, ctx.agent.id);
  const model = getIntegrations(companyId).assistant.model;
  const base = { signal: null, timedOut: false, provider: "claude-code", model, billingType: "fixed" as const, usage: { inputTokens: 0, outputTokens: 0 } };
  if (!agent) return { ...base, exitCode: 0, summary: `${input.agentTag} isn't on tethr's team any more; nothing to do.` };
  if (agent.paused) {
    await tasks.setStatus(issueId, "cancelled", { agentId: ctx.agent.id });
    return { ...base, exitCode: 0, summary: `${agent.tag} is paused; ${issue.identifier ?? "the task"} was cancelled.` };
  }

  // Phase 27: a scheduled run waits while the agent has a question nobody has
  // answered. It asked because it couldn't go on; running the schedule anyway
  // spends a turn to say so again. Work a person or tethr hands it still runs.
  const waitingOn = issue.originKind === "routine_execution" ? openQuestions(companyId, { agentTag: agent.tag })[0] : undefined;
  if (waitingOn) {
    const why = `${agent.tag} didn't run its scheduled job: it's waiting for an answer to "${waitingOn.question}". Answer it in tethr (Needs you) and the next scheduled run goes ahead.`;
    await ctx.onLog("stdout", `[tethr] ${why}\n`);
    await tasks.comment(issueId, why, { agentId: ctx.agent.id }).catch(() => {});
    await tasks.setStatus(issueId, "cancelled", { agentId: ctx.agent.id });
    return { ...base, exitCode: 0, summary: why };
  }

  // A task that has sub-tasks is past its first turn, whatever woke it (the
  // sub-team finishing, or core handing an open task back): never work it again
  // from the top, which would hand the same work out twice.
  // - sub-tasks still open → it waits (blocked) for them;
  // - all closed → the roll-up. (A task already rolled up is done, and core
  //   doesn't wake a done task, so the roll-up happens once.)
  let rollup: ChildResult[] | null = null;
  const children = (await tasks.load(issueId))?.children ?? [];
  if (children.length) {
    if (children.some((c) => !CLOSED.includes(c.status))) {
      await tasks.setStatus(issueId, "blocked", { agentId: ctx.agent.id });
      return { ...base, exitCode: 0, summary: `${agent.tag}: ${issue.identifier ?? "the task"} is waiting on its sub-team.` };
    }
    rollup = children;
  }

  // Phase 27: a job that depends on a connection that's missing doesn't run, so it
  // spends nothing, until a person connects it or says to carry on without it. A
  // roll-up closes work already done, so it isn't held.
  const unmet = rollup ? [] : await teamService(db).unmetNeeds(companyId, agent);
  if (unmet.length) {
    const { holdTaskForNeeds } = await import("./team-needs.js");
    const why = await holdTaskForNeeds(db, { companyId, agent, issueId, issue, unmet, tasks, ctx });
    return { ...base, exitCode: 0, summary: why };
  }

  await ctx.onLog("stdout", `[tethr] ${agent.tag} ${rollup ? "rolling up" : "working"} ${issue.identifier ?? issueId} in its chat\n`);
  let out = await runTaskInAgentChat(db, { companyId, agent, issue, rollup });
  // Its sub-team already finished while it was still on its turn: roll up now
  // (the task would otherwise close as done with no roll-up).
  if (out.status === "delegated" && (await openChildren(db, issueId)) === 0) {
    const children = (await tasks.load(issueId))?.children ?? [];
    out = await runTaskInAgentChat(db, { companyId, agent, issue, rollup: children });
  }
  // finish() moves the task: done, or blocked while sub-tasks are open. Cards the
  // turn left for the person (a proposed agent, an outward action) are their
  // own decisions, followed up in the agent's chat; they don't hold the task
  // open (nothing would close it when they're decided).
  await tasks.finish({
    issueId,
    agentId: ctx.agent.id,
    agentTag: agent.tag,
    runId: ctx.runId,
    run: {
      status: out.status === "done" || out.status === "delegated" ? "done" : "failed",
      resultText: out.text,
      outputs: out.outputs.map((o) => ({ ...o, gated: false })),
    },
    delegated: [],
  });
  // A failed or capped run waits for a person (no automatic retries that burn
  // runs); a run skipped while agents were paused is simply missed.
  if (out.status === "failed" || out.status === "capped") await tasks.setStatus(issueId, "blocked", { agentId: ctx.agent.id });
  if (out.status === "skipped") await tasks.setStatus(issueId, "cancelled", { agentId: ctx.agent.id });
  return {
    ...base,
    exitCode: out.status === "failed" ? 1 : 0,
    ...(out.status === "failed" ? { errorMessage: out.text } : {}),
    resultJson: { chatRunId: out.runId, taskIssueId: issueId, outcome: out.status },
    summary: out.text.slice(0, 500),
  };
}
