import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, tethrSubagents, type TethrRouteHop } from "@paperclipai/db";
import type { TethrOutputKind, TethrSensitivity } from "@paperclipai/shared";
import { getTethrLLMProvider } from "./llm/index.js";
import type { LLMImageAttachment, LLMUsage } from "./llm/types.js";
import { gatingService } from "./gating.js";
import { memoryService } from "./memory.js";
import { toolsetForSubagent, type TethrToolContext } from "./tools/index.js";

// The "do" step of classify → route → do. Renders the subagent's fine-tuned
// spec as the system prompt, generates the work product, and hands it to the
// gating service (which decides hard-gate vs immediate publish).

const KIND_BY_SUBAGENT_KEY: Record<string, TethrOutputKind> = {
  blog: "blog_draft",
  geo: "document",
  keywords: "document",
  brief: "brief",
  draft: "itinerary",
  health: "itinerary",
  leads: "lead_digest",
  reply: "reply_draft",
  news: "news_digest",
  analyze: "analytics_report",
  bids: "ads_recommendation",
  copy: "ads_recommendation",
  negatives: "ads_recommendation",
  guardrails: "analytics_report",
  modeler: "analytics_report",
  reporter: "analytics_report",
  press: "press_release",
  pickup: "press_release",
  announce: "press_release",
  icp: "icp_profile",
  messaging: "messaging",
  brand: "document",
  // @tethr, the coordinator (Phase 12): chat answers inline into the
  // conversation; plans are internal briefs that gate to the Queue.
  chat: "answer",
  plan: "brief",
};

// Per-subagent agentic turn budget. Chat stays snappy; plan gets room to
// research before writing. Everything else keeps the provider default.
const MAX_TURNS_BY_SUBAGENT_KEY: Record<string, number> = {
  chat: 8,
  plan: 12,
};

export interface SubagentJobInput {
  companyId: string;
  agentId: string;
  agentTag: string;
  subagent: typeof tethrSubagents.$inferSelect;
  request: string;
  standingRules: string[];
  routeRunId?: string | null;
  heartbeatRunId?: string | null;
  /** Records tool hops on the route run as they happen. */
  onHop?: (hop: TethrRouteHop) => Promise<void>;
  /** Extra system-prompt context (revision notes, prior sequence results). */
  extraContext?: string;
  /** Images shared with the request (e.g. Slack screenshots) for the model. */
  attachments?: LLMImageAttachment[];
  /** Revision lineage when re-running after "request changes". */
  revisionOfId?: string | null;
  revisionNumber?: number;
}

export interface SubagentJobResult {
  outputId: string;
  title: string;
  status: string;
  sensitivity: TethrSensitivity;
  kind: TethrOutputKind;
  gated: boolean;
  summary: string;
  /** The full generated body — lets routing inline chat answers (kind "answer"). */
  body: string;
  /** Set when the agent called `escalate` — a question for its human overseer. */
  escalation?: { note: string; urgency: string };
  usage: LLMUsage;
}

export interface ReviseOutputInput {
  companyId: string;
  outputId: string;
  /** Reviewer note; falls back to the approval's decision note. */
  note?: string;
}

export function buildSubagentSystemPrompt(
  subagent: typeof tethrSubagents.$inferSelect,
  standingRules: string[],
  memories: string[],
): string {
  const lines = [
    `You are ${subagent.tag} (${subagent.name}), a specialist subagent at Wandr Health.`,
    `Job: ${subagent.job}`,
  ];
  if (subagent.reads.length) lines.push(`You read: ${subagent.reads.join("; ")}`);
  if (subagent.steps.length)
    lines.push(`Workflow:\n${subagent.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`);
  if (subagent.output) lines.push(`Output contract: ${subagent.output}`);
  if (subagent.guardrails.length)
    lines.push(`Guardrails (hard rules):\n- ${subagent.guardrails.join("\n- ")}`);
  if (standingRules.length)
    lines.push(`Company standing rules:\n- ${standingRules.join("\n- ")}`);
  if (memories.length) lines.push(`Recall:\n- ${memories.join("\n- ")}`);
  if (subagent.doneWhen) lines.push(`Done when: ${subagent.doneWhen}`);
  return lines.join("\n\n");
}

export function workerService(db: Db) {
  const gating = gatingService(db);
  const memory = memoryService(db);

  async function runSubagentJob(input: SubagentJobInput): Promise<SubagentJobResult> {
    const provider = getTethrLLMProvider();
    const recalled = await memory.recall(input.companyId, input.agentId, undefined, 6);
    let system = buildSubagentSystemPrompt(
      input.subagent,
      input.standingRules,
      recalled.map((m) => m.content),
    );
    if (input.extraContext) {
      system += `\n\nAdditional context for this run:\n${input.extraContext}`;
    }
    const kind = KIND_BY_SUBAGENT_KEY[input.subagent.key] ?? "document";

    // The subagent's hands: its allowlisted tools, every call recorded as a
    // hop so the Console shows the work, not just the result.
    const toolCtx: TethrToolContext = {
      db,
      companyId: input.companyId,
      agentId: input.agentId,
      agentTag: input.agentTag,
      subagentTag: input.subagent.tag,
    };
    const tools = toolsetForSubagent(input.subagent);
    const toolByName = new Map(tools.map((t) => [t.name, t]));

    const generated = await provider.runAgentic({
      system,
      prompt: input.request,
      kind,
      maxTurns: MAX_TURNS_BY_SUBAGENT_KEY[input.subagent.key],
      attachments: input.attachments,
      context: { agentTag: input.agentTag, subagentTag: input.subagent.tag },
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      callTool: async (name, args) => {
        const tool = toolByName.get(name);
        if (!tool) {
          return {
            output: `Unknown or disallowed tool: ${name}. Available: ${tools.map((t) => t.name).join(", ")}`,
            summary: `blocked: ${name}`,
          };
        }
        return tool.execute(toolCtx, args);
      },
      onToolEvent: async (event) => {
        await input.onHop?.({
          layer: "tool",
          actorTag: input.subagent.tag,
          decision: event.name,
          reason: event.summary,
          at: new Date().toISOString(),
        });
      },
    });

    // Did the agent raise a hand? The escalate tool-call carries the question;
    // routing/Slack tag the overseer in the originating thread.
    const escalateCall = generated.toolCalls.find((t) => t.name === "escalate");
    const escalation = escalateCall
      ? {
          note: String((escalateCall.input as Record<string, unknown>)?.question ?? "").slice(0, 500),
          urgency: String((escalateCall.input as Record<string, unknown>)?.urgency ?? "normal"),
        }
      : undefined;

    const sensitivity = input.subagent.sensitivity as TethrSensitivity;
    const output = await gating.createOutput({
      companyId: input.companyId,
      agentId: input.agentId,
      agentTag: input.agentTag,
      subagentId: input.subagent.id,
      routeRunId: input.routeRunId ?? null,
      heartbeatRunId: input.heartbeatRunId ?? null,
      kind,
      title: generated.title,
      body: generated.body,
      sensitivity,
      meta: {
        request: input.request.slice(0, 500),
        provider: provider.id,
        toolCalls: generated.toolCalls.map((t) => t.summary),
      },
      revisionOfId: input.revisionOfId ?? null,
      revisionNumber: input.revisionNumber ?? 1,
    });
    if (!output) throw new Error("Output creation failed");

    const now = new Date();
    await db
      .update(tethrSubagents)
      .set({ lastRunAt: now, updatedAt: now })
      .where(eq(tethrSubagents.id, input.subagent.id));
    await db
      .update(agents)
      .set({ lastHeartbeatAt: now, updatedAt: now })
      .where(eq(agents.id, input.agentId));

    const gated = output.status === "gated";
    // Chat answers are ephemeral conversation, not org history — recording them
    // would make recent chatter bleed into future recall (recency-ordered).
    // They're already audit-logged to the Drive chat-log; skip the memory.
    if (kind !== "answer") {
      const memoryNote = gated
        ? `${input.subagent.tag} staged "${output.title}" for human review (${sensitivity}).`
        : `${input.subagent.tag} produced "${output.title}".`;
      await memory.record({
        companyId: input.companyId,
        agentId: input.agentId,
        kind: "history",
        content: memoryNote,
        source: input.subagent.tag,
      });
    }

    return {
      outputId: output.id,
      title: output.title,
      status: output.status,
      sensitivity,
      kind,
      gated,
      summary: gated
        ? `${output.title} — staged in the Queue for human review (${sensitivity}-sensitive).`
        : kind === "answer"
          ? `${input.subagent.tag} answered.`
          : `${output.title} — published to the Drive.`,
      body: output.body,
      escalation,
      usage: generated.usage,
    };
  }

  /**
   * The revision loop: after "request changes", re-run the producing
   * subagent with the original draft + the reviewer's note, producing v(n+1)
   * linked to the original through the same gate.
   */
  async function reviseOutput(input: ReviseOutputInput): Promise<SubagentJobResult> {
    const original = await gating.getOutput(input.companyId, input.outputId);
    if (!original) throw new Error("Output not found");
    if (!original.subagentId) throw new Error("Output has no producing subagent");
    const [subagent] = await db
      .select()
      .from(tethrSubagents)
      .where(eq(tethrSubagents.id, original.subagentId));
    if (!subagent) throw new Error("Producing subagent not found");

    let note = input.note ?? null;
    if (!note && original.approvalId) {
      const { approvals } = await import("@paperclipai/db");
      const [approval] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, original.approvalId));
      note = approval?.decisionNote ?? null;
    }

    const meta = original.meta as Record<string, unknown>;
    const agentTag = String(meta.agentTag ?? subagent.tag.split(".")[0]);
    const originalRequest = String(meta.request ?? original.title);

    return runSubagentJob({
      companyId: input.companyId,
      agentId: original.agentId,
      agentTag,
      subagent,
      request: `Revise your previous draft per the reviewer's note. Original request: ${originalRequest}`,
      standingRules: [],
      revisionOfId: original.id,
      revisionNumber: (original.revisionNumber ?? 1) + 1,
      extraContext: [
        `You are revising a draft a human reviewer sent back.`,
        `Reviewer's note: ${note ?? "(no note recorded — tighten and improve the draft)"}`,
        `Your previous draft (v${original.revisionNumber ?? 1}):\n---\n${original.body.slice(0, 4000)}\n---`,
        `Address the note directly. Keep what was right.`,
      ].join("\n\n"),
    });
  }

  return { runSubagentJob, reviseOutput };
}

export type WorkerService = ReturnType<typeof workerService>;
