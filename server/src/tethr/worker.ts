import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, tethrSubagents, type TethrRouteHop } from "@paperclipai/db";
import type { TethrOutputKind, TethrSensitivity } from "@paperclipai/shared";
import { getTethrLLMProvider } from "./llm/index.js";
import type { LLMUsage } from "./llm/types.js";
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
}

export interface SubagentJobResult {
  outputId: string;
  title: string;
  status: string;
  sensitivity: TethrSensitivity;
  kind: TethrOutputKind;
  gated: boolean;
  summary: string;
  usage: LLMUsage;
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
      meta: { request: input.request.slice(0, 500), provider: provider.id },
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

    return {
      outputId: output.id,
      title: output.title,
      status: output.status,
      sensitivity,
      kind,
      gated,
      summary: gated
        ? `${output.title} — staged in the Queue for human review (${sensitivity}-sensitive).`
        : `${output.title} — published to the Drive.`,
      usage: generated.usage,
    };
  }

  return { runSubagentJob };
}

export type WorkerService = ReturnType<typeof workerService>;
