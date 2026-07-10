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

// The tethr_llm server adapter. Registering through the adapter seam means
// heartbeats, cron routines, "run now", run logs, and cost events all flow
// through unmodified Paperclip machinery — a Tethr agent is a first-class
// Paperclip employee whose execute() runs the classify → route → do loop
// against the LLM provider instead of spawning a CLI process.

let adapterDb: Db | null = null;

async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
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
  // Only live (Claude) runs cost money; the mock provider stays $0. Core reads
  // `resultJson.costUsd` and converts to cents (heartbeat.normalizeBilledCostCents).
  const costUsd =
    provider.id === "claude" ? priceUsd(provider.model, result.usage) : 0;

  if (result.status === "failed") {
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: result.resultText,
      provider: provider.id,
      model: provider.model,
      billingType: provider.id === "claude" ? "api" : "fixed",
      usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
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
