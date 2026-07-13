import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrRouteRuns, type TethrRouteHop } from "@paperclipai/db";
import type { TethrRouteInvocationSource } from "@paperclipai/shared";
import { logActivity } from "../services/activity-log.js";
import { getTethrLLMProvider } from "./llm/index.js";
import type { LLMImageAttachment, LLMUsage } from "./llm/types.js";
import { notificationService } from "./notify.js";
import { orgService } from "./org.js";
import { isContentRequest, publishedDuplicateWarning } from "./published-memory.js";
import { workerService } from "./worker.js";

// The routing engine — ROUTING-MODEL.md as code.
//
//   request → router (classify, or plan a multi-agent sequence) → @agent
//   (classify) → @agent.subagent (do the work with tools, or stage for
//   approval).
//
// The router is @tethr (the clean-slate coordinator) or @helm (legacy org) —
// resolved per company via org.getRouterProfile.
//
// Every hop — including each tool call — is recorded on the route run AND in
// the core activity log, so a request's full path is reconstructable.

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
  /** Console conversations: share the first run's id. */
  threadId?: string | null;
  /** Origin key for cross-surface continuity (e.g. a Slack thread/DM). Stored
   * on the run so a later reply from the same origin can resume the thread. */
  sourceKey?: string | null;
  /** Images shared with the request (e.g. Slack screenshots) for the model. */
  attachments?: LLMImageAttachment[];
  /** Pace hops so the Console can stream them (console runs only). */
  hopDelayMs?: number;
  /** Fires as soon as the run row exists — lets callers return early and poll. */
  onStarted?: (ids: { routeRunId: string; threadId: string }) => void;
}

export interface RouteRequestResult {
  routeRunId: string;
  threadId: string;
  status: string;
  hops: TethrRouteHop[];
  resultText: string;
  outputs: Array<{
    outputId: string;
    title: string;
    status: string;
    gated: boolean;
    /** The agent that produced it — used to resolve the overseer to tag. */
    agentTag: string;
  }>;
  /** Agents that raised a hand this run — their overseer gets tagged in-thread. */
  escalations: Array<{ agentTag: string; note: string; urgency: string }>;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function routingService(db: Db) {
  const org = orgService(db);
  const worker = workerService(db);

  async function routeRequest(input: RouteRequestInput): Promise<RouteRequestResult> {
    const startedAt = Date.now();
    const provider = getTethrLLMProvider();
    const hops: TethrRouteHop[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
    const hopDelayMs = input.hopDelayMs ?? 0;

    const [run] = await db
      .insert(tethrRouteRuns)
      .values({
        companyId: input.companyId,
        requestText: input.requestText,
        requestedByUserId: input.requestedByUserId ?? null,
        invocationSource: input.invocationSource ?? "console",
        heartbeatRunId: input.heartbeatRunId ?? null,
        threadId: input.threadId ?? null,
        sourceKey: input.sourceKey ?? null,
        status: "routing",
        llmProvider: provider.id,
      })
      .returning();
    const threadId = input.threadId ?? run.id;
    if (!input.threadId) {
      await db
        .update(tethrRouteRuns)
        .set({ threadId })
        .where(eq(tethrRouteRuns.id, run.id));
    }
    input.onStarted?.({ routeRunId: run.id, threadId });

    // Phase 6: flag a duplicate content topic (advisory — never blocks routing).
    if (isContentRequest(input.requestText)) {
      const dupWarning = await publishedDuplicateWarning(
        db,
        input.companyId,
        input.requestText,
      );
      if (dupWarning) {
        await notificationService(db)
          .send({
            companyId: input.companyId,
            kind: "system",
            title: "Possible duplicate content topic",
            body: dupWarning,
          })
          .catch(() => {});
      }
    }

    // Conversation context for follow-ups in the same thread.
    let conversationContext = "";
    if (input.threadId) {
      const previous = await db
        .select()
        .from(tethrRouteRuns)
        .where(
          and(
            eq(tethrRouteRuns.companyId, input.companyId),
            eq(tethrRouteRuns.threadId, input.threadId),
            ne(tethrRouteRuns.id, run.id),
          ),
        )
        .orderBy(desc(tethrRouteRuns.createdAt))
        .limit(5);
      if (previous.length) {
        conversationContext = [
          "Earlier in this conversation (most recent first):",
          ...previous.map(
            (p) => `Q: ${p.requestText.slice(0, 300)}\nA: ${(p.resultText ?? "").slice(0, 600)}`,
          ),
        ].join("\n\n");
      }
    }

    const recordHop = async (hop: TethrRouteHop) => {
      if (hopDelayMs > 0) await sleep(hopDelayMs);
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
        threadId,
        status: "failed",
        hops,
        resultText: error,
        outputs: [],
        escalations: [],
        usage,
        llmProvider: provider.id,
        durationMs: Date.now() - startedAt,
      };
    };

    const outputs: RouteRequestResult["outputs"] = [];
    const summaries: string[] = [];
    const escalations: RouteRequestResult["escalations"] = [];
    // Track chat-answer bodies so a single ungated answer can be inlined as the
    // result (what the human actually reads in Slack/Console) instead of a stub.
    const answerBodies: string[] = [];

    /** Layer 2+3 for one agent: classify the subagent (or use a chain), do the work. */
    async function runAgentStep(
      agentTag: string,
      requestText: string,
      opts: { chainKeys?: string[]; chainReason?: string; extraContext?: string } = {},
    ): Promise<{ ok: boolean; error?: string }> {
      const agentRow = await org.getProfileByTag(input.companyId, agentTag);
      if (!agentRow) return { ok: false, error: `No agent found for tag ${agentTag}.` };
      const { profile, agent } = agentRow;
      if (!run.agentId) {
        await db
          .update(tethrRouteRuns)
          .set({ agentId: agent.id, updatedAt: new Date() })
          .where(eq(tethrRouteRuns.id, run.id));
        run.agentId = agent.id;
      }

      const subagents = await org.listSubagents(input.companyId, agent.id);
      if (subagents.length === 0) {
        return { ok: false, error: `${agentTag} has no subagents seeded.` };
      }

      let chain: typeof subagents = [];
      if (opts.chainKeys?.length) {
        chain = opts.chainKeys
          .map((key) => subagents.find((s) => s.key === key))
          .filter((s): s is (typeof subagents)[number] => Boolean(s));
        for (const sub of chain) {
          await recordHop({
            layer: "agent",
            actorTag: agentTag,
            decision: `route → ${sub.tag}`,
            reason: opts.chainReason ?? "Standing heartbeat chain.",
            at: new Date().toISOString(),
          });
        }
      } else {
        const classified = await provider.classify({
          layer: "agent",
          actorTag: agentTag,
          request: requestText,
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

      if (!run.subagentId && chain[0]) {
        await db
          .update(tethrRouteRuns)
          .set({ status: "working", subagentId: chain[0].id, updatedAt: new Date() })
          .where(eq(tethrRouteRuns.id, run.id));
        run.subagentId = chain[0].id;
      }

      for (const sub of chain) {
        await recordHop({
          layer: "subagent",
          actorTag: sub.tag,
          decision: "do the work",
          reason: sub.job,
          at: new Date().toISOString(),
        });
        const extraParts = [conversationContext, opts.extraContext].filter(Boolean);
        const result = await worker.runSubagentJob({
          companyId: input.companyId,
          agentId: agent.id,
          agentTag,
          subagent: sub,
          request: requestText,
          standingRules: profile.standingRules,
          routeRunId: run.id,
          heartbeatRunId: input.heartbeatRunId ?? null,
          onHop: recordHop,
          extraContext: extraParts.length ? extraParts.join("\n\n") : undefined,
          attachments: input.attachments,
        });
        usage = sumUsage(usage, result.usage);
        outputs.push({
          outputId: result.outputId,
          title: result.title,
          status: result.status,
          gated: result.gated,
          agentTag,
        });
        summaries.push(result.summary);
        if (result.kind === "answer" && !result.gated) answerBodies.push(result.body);
        if (result.escalation) {
          escalations.push({
            agentTag,
            note: result.escalation.note,
            urgency: result.escalation.urgency,
          });
        }
      }
      return { ok: true };
    }

    try {
      // The router: @tethr (clean-slate coordinator) or @helm (legacy org).
      const helm = await org.getRouterProfile(input.companyId);
      if (!helm) return await fail("No router agent (@tethr) is seeded for this company.");
      const routerTag = helm.profile.tag;
      const helmOptions = helm.profile.routingTable.map((r) => ({
        tag: r.to,
        description: r.description ?? "",
        when: r.when,
      }));

      if (input.startAtAgentTag) {
        // Heartbeats: standing assignment, no Helm classification.
        await recordHop({
          layer: "helm",
          actorTag: routerTag,
          decision: `route → ${input.startAtAgentTag}`,
          reason:
            input.invocationSource === "heartbeat"
              ? "Scheduled heartbeat — standing assignment."
              : "Caller addressed the agent directly.",
          at: new Date().toISOString(),
        });
        const step = await runAgentStep(input.startAtAgentTag, input.requestText, {
          chainKeys: input.subagentChain,
        });
        if (!step.ok) return await fail(step.error ?? "Routing failed.");
      } else {
        if (helmOptions.length === 0)
          return await fail(`${routerTag} has no routing table.`);

        // Cross-domain? Ask for a plan first. A plan is only usable when every
        // step's agent actually exists in this org's routing table — the mock
        // provider can suggest specialists a minimal org doesn't have.
        const knownTags = new Set(helmOptions.map((o) => o.tag));
        let plan = await provider.plan({
          request: input.requestText,
          agents: helmOptions,
        });
        if (plan) usage = sumUsage(usage, plan.usage);
        if (plan && !plan.steps.every((s) => knownTags.has(s.agentTag))) plan = null;

        if (plan && plan.steps.length >= 2) {
          await recordHop({
            layer: "helm",
            actorTag: routerTag,
            decision: `plan → ${plan.steps.length} steps (${plan.steps.map((s) => s.agentTag).join(" → ")})`,
            reason: plan.reason,
            at: new Date().toISOString(),
          });
          for (let i = 0; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            await recordHop({
              layer: "helm",
              actorTag: routerTag,
              decision: `step ${i + 1} → ${step.agentTag}`,
              reason: step.request.slice(0, 160),
              at: new Date().toISOString(),
            });
            const priorResults = summaries.length
              ? `Results from earlier steps in this plan:\n- ${summaries.join("\n- ")}`
              : undefined;
            const ran = await runAgentStep(step.agentTag, step.request, {
              extraContext: priorResults,
            });
            if (!ran.ok) {
              summaries.push(`Step ${i + 1} (${step.agentTag}) failed: ${ran.error}`);
            }
          }
        } else {
          const classified = await provider.classify({
            layer: "helm",
            actorTag: routerTag,
            request: input.requestText,
            options: helmOptions,
          });
          usage = sumUsage(usage, classified.usage);
          await recordHop({
            layer: "helm",
            actorTag: routerTag,
            decision: `route → ${classified.choiceTag}`,
            reason: classified.reason,
            at: new Date().toISOString(),
          });
          const step = await runAgentStep(classified.choiceTag, input.requestText);
          if (!step.ok) return await fail(step.error ?? "Routing failed.");
        }
      }

      if (outputs.length === 0) {
        return await fail(summaries.join("\n") || "No outputs produced.");
      }

      const anyGated = outputs.some((o) => o.gated);
      const status = anyGated ? "gated" : "done";
      // A single ungated chat answer IS the result — inline the body so the human
      // reads the actual answer. Anything else (plans, gated work, multi-step)
      // keeps the terse summary + Queue links.
      const resultText =
        outputs.length === 1 && answerBodies.length === 1
          ? answerBodies[0]
          : summaries.join("\n");
      const durationMs = Date.now() - startedAt;

      await db
        .update(tethrRouteRuns)
        .set({ status, resultText, durationMs, updatedAt: new Date() })
        .where(eq(tethrRouteRuns.id, run.id));

      return {
        routeRunId: run.id,
        threadId,
        status,
        hops,
        resultText,
        outputs,
        escalations,
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
