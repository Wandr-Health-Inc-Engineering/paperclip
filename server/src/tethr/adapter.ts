import type { Db } from "@paperclipai/db";
import { TETHR_ADAPTER_TYPE } from "@paperclipai/shared";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  ServerAdapterModule,
} from "../adapters/index.js";
import { registerServerAdapter } from "../adapters/index.js";
import { getTethrLLMProvider } from "./llm/index.js";
import { priceUsd } from "./llm/pricing.js";
import { orgService } from "./org.js";
import { routingService } from "./routing.js";
import { isAgentsPaused } from "./throttle.js";
import { getIntegrations } from "./integrations.js";
import { getSetup } from "./setup.js";
import { scheduleWords } from "./team-spec.js";

// The tethr_llm server adapter. Registering through the adapter seam means
// heartbeats, cron routines, "run now", run logs, and cost events all flow
// through unmodified Paperclip machinery — a Tethr agent is a first-class
// Paperclip employee whose execute() runs the classify → route → do loop
// against the LLM provider instead of spawning a CLI process.

let adapterDb: Db | null = null;

/**
 * Entry point. A wake that carries a Paperclip task id (an assignment, a
 * delegated sub-task, a roll-up after children finish, a routine's task) is
 * worked as that task; everything else is the standing heartbeat.
 */
/** What a run with no task did, for the run page: an agent on tethr's team works tasks only. */
export function idleRunSummary(name: string, companyId: string, config: Record<string, unknown>): string {
  const schedule = config.schedule as { cron?: unknown } | null | undefined;
  const cron = typeof schedule?.cron === "string" ? schedule.cron : null;
  const next = cron ? ` Its scheduled runs are ${scheduleWords(cron, getSetup(companyId).timezone)}.` : " It has no schedule; give it a task from tethr's chat.";
  return `${name} had no task for this run, so nothing ran and nothing was spent. It works in its own chat in tethr; the workspace folder named above isn't used.${next}`;
}

async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const taskIssueId =
    typeof ctx.context?.issueId === "string" && ctx.context.issueId.trim() ? ctx.context.issueId.trim() : null;
  const config = (ctx.agent.adapterConfig ?? {}) as Record<string, unknown>;
  // Phase 23: an agent on tethr's team only works tasks (its schedule is a
  // routine, which opens a task); it has no standing heartbeat.
  if (!taskIssueId && config.engine === "session") {
    // The run page shows only Paperclip's own "no workspace" line otherwise, which
    // reads like an error. Say what happened: nothing ran, nothing was spent.
    const summary = idleRunSummary(ctx.agent.name, ctx.agent.companyId, config);
    await ctx.onLog("stdout", `[tethr] ${summary}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: "claude-code",
      model: getIntegrations(ctx.agent.companyId).assistant.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      summary,
    };
  }
  if (!taskIssueId) return executeHeartbeat(ctx);

  const specialMode =
    config.heartbeatMode === "digest" || config.heartbeatMode === "site_audit" || config.heartbeatMode === "pulse_audit";
  // The rhythm Mark chose in setup (phase 20) always runs as a task, even for
  // @tethr, whose standing heartbeat is the old digest.
  if (specialMode && adapterDb) {
    const { isRhythmTask } = await import("./rhythm.js");
    if (await isRhythmTask(adapterDb, ctx.agent.companyId, taskIssueId)) return executeTask(ctx, taskIssueId);
  }
  if (specialMode) {
    // Deterministic routine modes run as before, then close their routine task.
    const result = await executeHeartbeat(ctx);
    const db = adapterDb;
    if (db && result.exitCode === 0) {
      const { taskService } = await import("./tasks.js");
      const tasks = taskService(db);
      const issue = await tasks.load(taskIssueId);
      if (issue && !["done", "cancelled"].includes(issue.issue.status)) {
        await tasks.finish({
          issueId: taskIssueId,
          agentId: ctx.agent.id,
          agentTag: String(config.heartbeatMode),
          runId: ctx.runId,
          run: { status: "done", resultText: result.summary ?? "", outputs: [] },
          delegated: [],
        });
      }
    }
    return result;
  }
  return executeTask(ctx, taskIssueId);
}

/** Work one Paperclip task as this agent: claim → run → comment → move it. */
async function executeTask(ctx: AdapterExecutionContext, issueId: string): Promise<AdapterExecutionResult> {
  const db = adapterDb;
  if (!db) throw new Error("tethr_llm adapter not initialized (initTethr was not called)");
  const provider = getTethrLLMProvider();
  const org = orgService(db);
  const companyId = ctx.agent.companyId;
  const config = (ctx.agent.adapterConfig ?? {}) as Record<string, unknown>;
  const profileRow = await org.getProfileByAgentId(companyId, ctx.agent.id);
  if (!profileRow) throw new Error(`Agent ${ctx.agent.name} has no Tethr profile`);
  const tag = profileRow.profile.tag;
  const skipped = (summary: string): AdapterExecutionResult => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: provider.id,
    model: provider.model,
    billingType: "fixed",
    usage: { inputTokens: 0, outputTokens: 0 },
    summary,
  });

  if (isAgentsPaused(companyId)) {
    await ctx.onLog("stdout", `[tethr] ${tag} task skipped — agents paused (usage throttle)\n`);
    return skipped(`${tag} task skipped — agents paused (usage throttle).`);
  }

  const { buildTaskRequest, newTaskRunState, taskService } = await import("./tasks.js");
  const tasks = taskService(db);
  const task = await tasks.load(issueId);
  if (!task) return skipped(`Task ${issueId} not found — nothing to do.`);
  if (["done", "cancelled"].includes(task.issue.status)) {
    return skipped(`${task.issue.identifier ?? "Task"} is already ${task.issue.status}.`);
  }
  if (!(await tasks.start(issueId, ctx.agent.id, ctx.runId))) {
    return skipped(`${task.issue.identifier ?? "Task"} is locked by another run — skipped.`);
  }

  // Phase 23: an agent on tethr's team works the task in its own chat.
  if (config.engine === "session") {
    const { executeTeamTask } = await import("./team-run.js");
    return executeTeamTask(db, { ctx, issueId, issue: task.issue, tasks, agentTag: tag });
  }

  const wakeReason = typeof ctx.context?.wakeReason === "string" ? ctx.context.wakeReason : null;
  const fromRoutine = task.issue.originKind === "routine_execution";

  // Phase 20.3: @tethr's scheduled work (the rhythm Mark chose in setup) runs as
  // a turn of the chat's Claude session in the Operations chat, not through the
  // old routing engine.
  if (fromRoutine && tag === "@tethr" && getIntegrations(companyId).assistant.engine === "session") {
    const { runTaskInOperationsChat } = await import("./rhythm.js");
    await ctx.onLog("stdout", `[tethr] ${task.issue.identifier ?? issueId}: running in the Operations chat\n`);
    const out = await runTaskInOperationsChat(db, { companyId, issue: task.issue });
    let taskStatus = await tasks.finish({
      issueId,
      agentId: ctx.agent.id,
      agentTag: tag,
      runId: ctx.runId,
      run: { status: out.status === "skipped" ? "failed" : out.status, resultText: out.text, outputs: out.outputs },
      delegated: [],
    });
    // Paused when it was due: nothing ran, so it's a missed run (the routines
    // skip missed runs too), not a failure to retry.
    if (out.status === "skipped") {
      await tasks.setStatus(issueId, "cancelled", { agentId: ctx.agent.id });
      taskStatus = "cancelled";
    }
    return {
      exitCode: out.status === "failed" ? 1 : 0,
      signal: null,
      timedOut: false,
      ...(out.status === "failed" ? { errorMessage: out.text } : {}),
      provider: "claude-code",
      model: getIntegrations(companyId).assistant.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      resultJson: { chatRunId: out.runId, taskIssueId: issueId, taskStatus },
      summary: out.text.slice(0, 500),
    };
  }
  const standing =
    fromRoutine && typeof config.heartbeatRequest === "string" ? config.heartbeatRequest : null;
  const requestText = buildTaskRequest(task, { agentTag: tag, wakeReason, standingInstructions: standing });
  const state = newTaskRunState({
    issueId,
    allowDelegation: wakeReason !== "issue_children_completed",
    requestText: task.issue.title,
  });
  await ctx.onLog(
    "stdout",
    `[tethr] ${tag} working ${task.issue.identifier ?? issueId}: ${task.issue.title}${wakeReason ? ` (${wakeReason})` : ""}\n`,
  );

  const ownSubagents = await org.listSubagents(companyId, ctx.agent.id);
  const isRouterOnly = ownSubagents.length === 0 && profileRow.profile.routingTable.length > 0;
  const subagentChain =
    fromRoutine && Array.isArray(config.subagentChain) ? (config.subagentChain as string[]) : undefined;
  const result = await routingService(db).routeRequest({
    companyId,
    requestText,
    invocationSource: "task",
    heartbeatRunId: ctx.runId,
    task: state,
    ...(isRouterOnly ? {} : { startAtAgentTag: tag, subagentChain }),
  });
  for (const hop of result.hops) {
    await ctx.onLog("stdout", `[route] ${hop.layer.padEnd(8)} ${hop.actorTag} → ${hop.decision} (${hop.reason})\n`);
  }
  const taskStatus = await tasks.finish({
    issueId,
    agentId: ctx.agent.id,
    agentTag: tag,
    runId: ctx.runId,
    run: result,
    delegated: state.delegated,
  });
  await ctx.onLog("stdout", `[task] ${task.issue.identifier ?? issueId} → ${taskStatus ?? "unchanged"}\n`);

  const costUsd = provider.id === "claude" ? priceUsd(provider.model, result.usage) : 0;
  const failed = result.status === "failed";
  return {
    exitCode: failed ? 1 : 0,
    signal: null,
    timedOut: false,
    ...(failed ? { errorMessage: result.resultText } : {}),
    provider: provider.id,
    model: provider.model,
    billingType: provider.id === "claude" ? "api" : "fixed",
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    // Core bills the TOP-LEVEL costUsd (heartbeat.updateRuntimeState); the copy in
    // resultJson stays for run detail views.
    costUsd,
    resultJson: {
      routeRunId: result.routeRunId,
      status: result.status,
      taskIssueId: issueId,
      taskStatus,
      delegated: state.delegated,
      outputs: result.outputs,
      costUsd,
    },
    summary: result.resultText.slice(0, 500),
  };
}

/** The standing heartbeat (no task in hand): the agent's scheduled request. */
async function executeHeartbeat(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const db = adapterDb;
  if (!db) {
    throw new Error("tethr_llm adapter not initialized (initTethr was not called)");
  }
  const provider = getTethrLLMProvider();
  const routing = routingService(db);
  const org = orgService(db);
  const companyId = ctx.agent.companyId;

  const config = (ctx.agent.adapterConfig ?? {}) as Record<string, unknown>;
  const profileRow = await org.getProfileByAgentId(companyId, ctx.agent.id);
  if (!profileRow) {
    throw new Error(`Agent ${ctx.agent.name} has no Tethr profile`);
  }
  const tag = profileRow.profile.tag;

  // Usage throttle: when agents are paused, no heartbeat does any LLM work.
  if (isAgentsPaused(companyId)) {
    await ctx.onLog("stdout", `[tethr] ${tag} heartbeat skipped — agents paused (usage throttle)\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: provider.id,
      model: provider.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      summary: `${tag} heartbeat skipped — agents paused (usage throttle).`,
    };
  }

  const heartbeatRequest =
    typeof config.heartbeatRequest === "string" && config.heartbeatRequest.trim()
      ? config.heartbeatRequest
      : `Run the standing heartbeat for ${tag}: wake, read assigned work, and produce the scheduled output.`;
  const subagentChain = Array.isArray(config.subagentChain)
    ? (config.subagentChain as string[])
    : undefined;

  await ctx.onLog("stdout", `[tethr] ${tag} heartbeat — provider: ${provider.id}\n`);
  await ctx.onLog("stdout", `[tethr] request: ${heartbeatRequest}\n`);

  // Digest mode: Helm's scheduled "what needs you" summary.
  if (config.heartbeatMode === "digest") {
    const { digestService } = await import("./digest.js");
    const digest = await digestService(db).generateDigest(companyId);
    await ctx.onLog("stdout", `[tethr] digest produced: ${digest.title}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: provider.id,
      model: provider.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      summary: `${digest.title} — ${digest.pendingCount} queue item(s).`,
    };
  }

  // Site-audit mode: Sentry's deterministic public-site audit (Phase 4). Posts
  // recommendations to #scout via the Notifier (Slack only fires with a token);
  // set TETHR_SENTRY_DRY_RUN=true to compute findings without posting/recording.
  if (config.heartbeatMode === "site_audit") {
    const { runSentryAudit } = await import("./checks/sentry.js");
    const dryRun = process.env.TETHR_SENTRY_DRY_RUN === "true";
    const audit = await runSentryAudit(db, companyId, ctx.agent.id, { dryRun });
    await ctx.onLog(
      "stdout",
      `[tethr] sentry: scanned ${audit.scanned} pages, ${audit.findings} findings, ${audit.posted} posted${dryRun ? " (dry run)" : ""}\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: provider.id,
      model: provider.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      resultJson: { sentry: audit },
      summary: `Sentry audit: ${audit.posted}/${audit.findings} finding(s) posted${dryRun ? " (dry run)" : ""}.`,
    };
  }

  // Pulse mode: the PostHog analytics auditor (Phase 8) — same #scout loop as
  // Sentry. Inert until POSTHOG_API_KEY is set and pulse-events.json is filled.
  if (config.heartbeatMode === "pulse_audit") {
    const { runPulseAudit } = await import("./checks/pulse.js");
    const dryRun = process.env.TETHR_PULSE_DRY_RUN === "true";
    const audit = await runPulseAudit(db, companyId, ctx.agent.id, { dryRun });
    await ctx.onLog(
      "stdout",
      `[tethr] pulse: ${audit.configured ? "" : "no POSTHOG_API_KEY; "}${audit.ready ? "" : "config not filled; "}${audit.findings} findings, ${audit.posted} posted${dryRun ? " (dry run)" : ""}\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: provider.id,
      model: provider.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      resultJson: { pulse: audit },
      summary: `Pulse: ${audit.posted}/${audit.findings} finding(s) posted${dryRun ? " (dry run)" : ""}.`,
    };
  }

  // Division heads (Helm) have a routing table but no subagents of their own:
  // their heartbeat routes across the whole org instead of within one agent.
  const ownSubagents = await org.listSubagents(companyId, ctx.agent.id);
  const isRouterOnly =
    ownSubagents.length === 0 && profileRow.profile.routingTable.length > 0;

  // Placeholder slots (the CEO) have neither subagents nor a routing table:
  // their heartbeat is a graceful no-op, never an error.
  if (ownSubagents.length === 0 && profileRow.profile.routingTable.length === 0) {
    await ctx.onLog("stdout", `[tethr] ${tag} is a placeholder slot — nothing to run.\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: provider.id,
      model: provider.model,
      billingType: "fixed",
      usage: { inputTokens: 0, outputTokens: 0 },
      summary: `${tag} is a placeholder slot — no standing work.`,
    };
  }

  const result = await routing.routeRequest({
    companyId,
    requestText: heartbeatRequest,
    invocationSource: "heartbeat",
    heartbeatRunId: ctx.runId,
    ...(isRouterOnly ? {} : { startAtAgentTag: tag, subagentChain }),
  });

  for (const hop of result.hops) {
    await ctx.onLog(
      "stdout",
      `[route] ${hop.layer.padEnd(8)} ${hop.actorTag} → ${hop.decision} (${hop.reason})\n`,
    );
  }
  for (const output of result.outputs) {
    await ctx.onLog(
      "stdout",
      `[output] ${output.gated ? "GATED " : "PUBLISHED"} ${output.title}\n`,
    );
  }

  // Price the run so real spend accrues into core cost_events / budget_policies.
  // Only live (Claude) runs cost money; the mock provider stays $0. Core bills the
  // TOP-LEVEL `costUsd` (heartbeat.updateRuntimeState → normalizeBilledCostCents →
  // cost_events); `resultJson.costUsd` is kept for the run detail views.
  const costUsd =
    provider.id === "claude" ? priceUsd(provider.model, result.usage) : 0;

  if (result.status === "failed") {
    // Phase 9: surface heartbeat failures to #scout within minutes (throttled).
    const { reportServerError } = await import("./observability.js");
    await reportServerError(db, companyId, {
      errorClass: `heartbeat:${tag}`,
      message: `${tag} heartbeat failed: ${result.resultText.slice(0, 300)}`,
      agentTag: tag,
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: result.resultText,
      provider: provider.id,
      model: provider.model,
      billingType: provider.id === "claude" ? "api" : "fixed",
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
      costUsd,
      resultJson: { status: result.status, costUsd },
      summary: `Heartbeat failed: ${result.resultText.slice(0, 200)}`,
    };
  }

  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    provider: provider.id,
    model: provider.model,
    billingType: provider.id === "claude" ? "api" : "fixed",
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
    costUsd,
    resultJson: {
      routeRunId: result.routeRunId,
      status: result.status,
      hops: result.hops,
      outputs: result.outputs,
      costUsd,
    },
    summary: result.resultText.slice(0, 500),
  };
}

export const tethrLlmAdapter: ServerAdapterModule = {
  type: TETHR_ADAPTER_TYPE,
  execute,
  testEnvironment: async () => ({
    adapterType: TETHR_ADAPTER_TYPE,
    status: "pass",
    testedAt: new Date().toISOString(),
    checks: [
      {
        code: "tethr_llm_provider",
        level: "info",
        message: process.env.ANTHROPIC_API_KEY
          ? "Live Claude API key present"
          : "Deterministic mock provider (set ANTHROPIC_API_KEY for live calls)",
      },
    ],
  }),
  models: [{ id: "tethr-routed", label: "Tethr routed (mock or Claude by env)" }],
  supportsLocalAgentJwt: false,
  supportsInstructionsBundle: false,
  requiresMaterializedRuntimeSkills: false,
  agentConfigurationDoc:
    "Tethr LLM adapter. Config keys: heartbeatRequest (string), subagentChain (string[] of subagent keys). The agent's routing table and subagent specs live in its Tethr profile.",
};

/** Called once from app startup. Registers the adapter with its Db handle. */
export function initTethrAdapter(db: Db): void {
  adapterDb = db;
  registerServerAdapter(tethrLlmAdapter);
}
