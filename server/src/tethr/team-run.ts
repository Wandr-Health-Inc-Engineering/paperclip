import type { Db } from "@paperclipai/db";
import type { issues } from "@paperclipai/db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { chatTaskResult, turnOutputs, waitForTurn, type ChatTaskResult } from "./assistant/turns.js";
import { getIntegrations } from "./integrations.js";
import { deliverAgentReport, type ReportOutcome } from "./team-report.js";
import { agentTaskText } from "./team-spec.js";
import { teamService, type TeamAgent } from "./team.js";
import type { TaskService } from "./tasks.js";
import type { SlackPoster } from "./watch.js";
import { MINUTE, SECOND } from "./time.js";

// Phase 23: an agent on tethr's team works a task (an assignment from tethr, or
// its routine's scheduled run) as a system turn in its own chat thread, with
// its instructions in the turn. tethr waits for the turn (≤ 20 minutes, then
// stops it), comments the result on the task, moves the task, and the agent
// reports back (team-report.ts).

const AGENT_TURN_MAX_MS = 20 * MINUTE;

type IssueRow = typeof issues.$inferSelect;

export interface AgentTaskResult extends Omit<ChatTaskResult, "status"> {
  status: ChatTaskResult["status"] | "capped";
}

/** Run one task in the agent's chat and report the result. */
export async function runTaskInAgentChat(
  db: Db,
  input: { companyId: string; agent: TeamAgent; issue: IssueRow; waitMs?: number; pollMs?: number; post?: SlackPoster },
): Promise<AgentTaskResult> {
  const { companyId, agent, issue } = input;
  const team = teamService(db);
  const report = (outcome: ReportOutcome, text: string, runId: string | null) =>
    deliverAgentReport(db, { companyId, agent, title: issue.title, identifier: issue.identifier, outcome, text, runId }, { post: input.post });

  if ((await team.runsToday(agent.agentId)) >= agent.maxRunsPerDay) {
    const text = `Didn't run: ${agent.tag} has used its ${agent.maxRunsPerDay} runs for today. Assign it again tomorrow, or raise its limit.`;
    await report("capped", text, null);
    return { status: "capped", text, runId: null, outputs: [] };
  }

  const { getAssistantRunner } = await import("./assistant/runner.js");
  const { routeRunId } = await getAssistantRunner(db).send({
    companyId,
    threadId: agent.threadId,
    text: agentTaskText(agent, { identifier: issue.identifier, title: issue.title, brief: issue.description }),
    kind: "system",
    task: true,
  });
  const waitMs = input.waitMs ?? AGENT_TURN_MAX_MS;
  const { row, timedOut } = await waitForTurn(db, routeRunId, { waitMs, pollMs: input.pollMs ?? 2 * SECOND });
  const result = chatTaskResult(row, { runId: routeRunId, timedOut, waitMs, outputs: await turnOutputs(db, routeRunId), chatName: `${agent.tag}'s chat` });
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

  await ctx.onLog("stdout", `[tethr] ${agent.tag} working ${issue.identifier ?? issueId} in its chat\n`);
  const out = await runTaskInAgentChat(db, { companyId, agent, issue });
  await tasks.finish({
    issueId,
    agentId: ctx.agent.id,
    agentTag: agent.tag,
    runId: ctx.runId,
    run: { status: out.status === "done" ? "done" : "failed", resultText: out.text, outputs: out.outputs },
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
