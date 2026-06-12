import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns, type TethrRouteHop } from "@paperclipai/db";
import type { TethrRouteInvocationSource } from "@paperclipai/shared";
import { logActivity } from "../services/activity-log.js";
import { getTethrLLMProvider } from "./llm/index.js";
import type { LLMUsage } from "./llm/types.js";
import { orgService } from "./org.js";
import { workerService } from "./worker.js";

// The routing engine — ROUTING-MODEL.md as code.
//
//   request → @helm (classify: which agent) → @agent (classify: which
//   subagent) → @agent.subagent (do the work, or stage for approval).
//
// Every hop is recorded on the route run AND in the core activity log, so a
// request's full path is reconstructable (governance requirement).

export interface RouteRequestInput {
  companyId: string;
  requestText: string;
  invocationSource?: TethrRouteInvocationSource;
  requestedByUserId?: string | null;
  heartbeatRunId?: string | null;
  /** Skip Helm and start at a specific agent tag (heartbeats). */
  startAtAgentTag?: string;
  /** Skip classification entirely and run an explicit subagent chain. */
  subagentChain?: string[];
}

export interface RouteRequestResult {
  routeRunId: string;
  status: string;
  hops: TethrRouteHop[];
  resultText: string;
  outputs: Array<{
    outputId: string;
    title: string;
    status: string;
    gated: boolean;
  }>;
  usage: LLMUsage;
  llmProvider: string;
  durationMs: number;
}

function sumUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function routingService(db: Db) {
  const org = orgService(db);
  const worker = workerService(db);

  async function routeRequest(input: RouteRequestInput): Promise<RouteRequestResult> {
    const startedAt = Date.now();
    const provider = getTethrLLMProvider();
    const hops: TethrRouteHop[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    const [run] = await db
      .insert(tethrRouteRuns)
      .values({
        companyId: input.companyId,
        requestText: input.requestText,
        requestedByUserId: input.requestedByUserId ?? null,
        invocationSource: input.invocationSource ?? "console",
        heartbeatRunId: input.heartbeatRunId ?? null,
        status: "routing",
        llmProvider: provider.id,
      })
      .returning();

    const recordHop = async (hop: TethrRouteHop) => {
      hops.push(hop);
      await db
        .update(tethrRouteRuns)
        .set({ hops, updatedAt: new Date() })
        .where(eq(tethrRouteRuns.id, run.id));
      await logActivity(db, {
        companyId: input.companyId,
        actorType: "agent",
        actorId: hop.actorTag,
        action: "tethr_route_hop",
        entityType: "tethr_route_run",
        entityId: run.id,
        details: {
          layer: hop.layer,
          decision: hop.decision,
          reason: hop.reason,
          request: input.requestText.slice(0, 200),
        },
      });
    };

    const fail = async (error: string): Promise<RouteRequestResult> => {
      await db
        .update(tethrRouteRuns)
        .set({ status: "failed", error, updatedAt: new Date() })
        .where(eq(tethrRouteRuns.id, run.id));
      return {
        routeRunId: run.id,
        status: "failed",
        hops,
        resultText: error,
        outputs: [],
        usage,
        llmProvider: provider.id,
        durationMs: Date.now() - startedAt,
      };
    };

    try {
      // --- Layer 1: Helm classifies which agent owns the request -----------
      const helm = await org.getProfileByTag(input.companyId, "@helm");
      if (!helm) return await fail("Helm is not seeded for this company.");

      let agentTag = input.startAtAgentTag ?? null;
      if (!agentTag) {
        const options = helm.profile.routingTable.map((r) => ({
          tag: r.to,
          description: r.description ?? "",
          when: r.when,
        }));
        if (options.length === 0) return await fail("Helm has no routing table.");
        const classified = await provider.classify({
          layer: "helm",
          actorTag: "@helm",
          request: input.requestText,
          options,
        });
        usage = sumUsage(usage, classified.usage);
        agentTag = classified.choiceTag;
        await recordHop({
          layer: "helm",
          actorTag: "@helm",
          decision: `route → ${agentTag}`,
          reason: classified.reason,
          at: new Date().toISOString(),
        });
      } else {
        await recordHop({
          layer: "helm",
          actorTag: "@helm",
          decision: `route → ${agentTag}`,
          reason:
            input.invocationSource === "heartbeat"
              ? "Scheduled heartbeat — standing assignment."
              : "Caller addressed the agent directly.",
          at: new Date().toISOString(),
        });
      }

      const agentRow = await org.getProfileByTag(input.companyId, agentTag);
      if (!agentRow) return await fail(`No agent found for tag ${agentTag}.`);
      const { profile, agent } = agentRow;

      await db
        .update(tethrRouteRuns)
        .set({ agentId: agent.id, updatedAt: new Date() })
        .where(eq(tethrRouteRuns.id, run.id));

      // --- Layer 2: the agent classifies which subagent does the task ------
      const subagents = await org.listSubagents(input.companyId, agent.id);
      if (subagents.length === 0) {
        return await fail(`${agentTag} has no subagents seeded.`);
      }

      let chain: typeof subagents = [];
      if (input.subagentChain?.length) {
        chain = input.subagentChain
          .map((key) => subagents.find((s) => s.key === key))
          .filter((s): s is (typeof subagents)[number] => Boolean(s));
        for (const sub of chain) {
          await recordHop({
            layer: "agent",
            actorTag: agentTag,
            decision: `route → ${sub.tag}`,
            reason: "Standing heartbeat chain.",
            at: new Date().toISOString(),
          });
        }
      } else {
        const classified = await provider.classify({
          layer: "agent",
          actorTag: agentTag,
          request: input.requestText,
          options: subagents.map((s) => ({
            tag: s.tag,
            description: s.job,
            when: s.routeWhen,
          })),
        });
        usage = sumUsage(usage, classified.usage);
        const chosen =
          subagents.find((s) => s.tag === classified.choiceTag) ?? subagents[0];
        chain = [chosen];
        await recordHop({
          layer: "agent",
          actorTag: agentTag,
          decision: `route → ${chosen.tag}`,
          reason: classified.reason,
          at: new Date().toISOString(),
        });
      }

      // --- Layer 3: subagent(s) do the work --------------------------------
      await db
        .update(tethrRouteRuns)
        .set({ status: "working", subagentId: chain[0]?.id ?? null, updatedAt: new Date() })
        .where(eq(tethrRouteRuns.id, run.id));

      const outputs: RouteRequestResult["outputs"] = [];
      const summaries: string[] = [];
      for (const sub of chain) {
        await recordHop({
          layer: "subagent",
          actorTag: sub.tag,
          decision: "do the work",
          reason: sub.job,
          at: new Date().toISOString(),
        });
        const result = await worker.runSubagentJob({
          companyId: input.companyId,
          agentId: agent.id,
          agentTag,
          subagent: sub,
          request: input.requestText,
          standingRules: profile.standingRules,
          routeRunId: run.id,
          heartbeatRunId: input.heartbeatRunId ?? null,
        });
        usage = sumUsage(usage, result.usage);
        outputs.push({
          outputId: result.outputId,
          title: result.title,
          status: result.status,
          gated: result.gated,
        });
        summaries.push(result.summary);
      }

      const anyGated = outputs.some((o) => o.gated);
      const status = anyGated ? "gated" : "done";
      const resultText = summaries.join("\n");
      const durationMs = Date.now() - startedAt;

      await db
        .update(tethrRouteRuns)
        .set({ status, resultText, durationMs, updatedAt: new Date() })
        .where(eq(tethrRouteRuns.id, run.id));

      return {
        routeRunId: run.id,
        status,
        hops,
        resultText,
        outputs,
        usage,
        llmProvider: provider.id,
        durationMs,
      };
    } catch (err) {
      return await fail(err instanceof Error ? err.message : String(err));
    }
  }

  async function getRouteRun(companyId: string, id: string) {
    const [run] = await db
      .select()
      .from(tethrRouteRuns)
      .where(
        and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.id, id)),
      )
      .limit(1);
    return run ?? null;
  }

  async function listRouteRuns(companyId: string, limit = 50) {
    return db
      .select()
      .from(tethrRouteRuns)
      .where(eq(tethrRouteRuns.companyId, companyId))
      .orderBy(desc(tethrRouteRuns.createdAt))
      .limit(limit);
  }

  return { routeRequest, getRouteRun, listRouteRuns };
}

export type RoutingService = ReturnType<typeof routingService>;
