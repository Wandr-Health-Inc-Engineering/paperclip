import type {
  AgenticToolEvent,
  ClassifyInput,
  ClassifyResult,
  GenerateInput,
  GenerateResult,
  LLMProvider,
  LLMUsage,
  PlanInput,
  PlanResult,
  ProposeAgentInput,
  ProposeAgentResult,
  RunAgenticInput,
  RunAgenticResult,
} from "./types.js";

// Live provider. Uses the Claude API directly over fetch so the server gains
// no SDK dependency. Selected automatically when ANTHROPIC_API_KEY is set.

const API_URL = "https://api.anthropic.com/v1/messages";
// The "work" model does the actual thinking — chat answers, plans, drafts,
// vision. The "fast" model handles the cheap, high-frequency routing hops
// (classify, plan-vs-not) where a small model is plenty and ~1/3 the cost.
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_FAST_MODEL = "claude-haiku-4-5";

interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ClaudeResponse {
  content: ClaudeContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ClaudeProvider implements LLMProvider {
  readonly id = "claude" as const;
  readonly model: string;
  /** Cheap model for routing hops (classify/plan). */
  readonly fastModel: string;
  private readonly apiKey: string;

  constructor(
    apiKey: string,
    model = process.env.TETHR_CLAUDE_MODEL || DEFAULT_MODEL,
    fastModel = process.env.TETHR_CLAUDE_FAST_MODEL || DEFAULT_FAST_MODEL,
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.fastModel = fastModel;
  }

  private async call(
    system: string,
    prompt: string,
    maxTokens: number,
    model = this.model,
  ): Promise<{ text: string; usage: LLMUsage }> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as ClaudeResponse;
    const text = data.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n");
    return {
      text,
      usage: {
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      },
    };
  }

  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const system = [
      `You are ${input.actorTag}, the routing layer of an agent company.`,
      `Classify the request and pick exactly one destination tag.`,
      `Respond with JSON only: {"tag": "<tag>", "reason": "<one sentence>"}`,
    ].join("\n");
    const optionLines = input.options
      .map((o) => `- ${o.tag}: ${o.description} (route here when: ${o.when.join("; ")})`)
      .join("\n");
    const { text, usage } = await this.call(
      system,
      `Request: ${input.request}\n\nDestinations:\n${optionLines}`,
      300,
      this.fastModel, // routing is a cheap classification — small model
    );
    const parsed = safeJson(text);
    const tag = typeof parsed?.tag === "string" ? parsed.tag : input.options[0]?.tag ?? "";
    const known = input.options.find((o) => o.tag === tag);
    return {
      choiceTag: known ? tag : (input.options[0]?.tag ?? ""),
      reason:
        typeof parsed?.reason === "string"
          ? parsed.reason
          : `Routed to ${tag} by ${this.model}.`,
      usage,
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const { text, usage } = await this.call(
      input.system,
      `${input.prompt}\n\nReturn the work product as markdown. First line: a short title prefixed with "TITLE: ".`,
      2000,
    );
    const lines = text.split("\n");
    let title = `Output — ${input.kind}`;
    let body = text;
    const titleLine = lines.findIndex((l) => l.startsWith("TITLE:"));
    if (titleLine >= 0) {
      title = lines[titleLine].replace(/^TITLE:\s*/, "").trim() || title;
      body = lines.slice(titleLine + 1).join("\n").trim();
    }
    return { title, body, usage };
  }

  /** Ask the model whether the request needs a multi-agent sequence. */
  async plan(input: PlanInput): Promise<PlanResult | null> {
    const system = [
      "You are @helm, the Chief Growth Officer routing layer of an agent company.",
      "If the request genuinely spans multiple agents, return an ordered plan;",
      "if one agent can own it, return null steps.",
      'Respond with JSON only: {"steps": [{"agentTag": "@x", "request": "..."}] | null, "reason": "..."}',
      "Plans have 2-4 steps. Spend and clinical steps stay gated downstream regardless.",
    ].join("\n");
    const agentLines = input.agents
      .map((a) => `- ${a.tag}: ${a.description}`)
      .join("\n");
    const { text, usage } = await this.call(
      system,
      `Request: ${input.request}\n\nAgents:\n${agentLines}`,
      500,
      this.fastModel, // plan-or-not is a cheap decision — small model
    );
    const parsed = safeJson(text);
    const steps = parsed?.steps;
    if (!Array.isArray(steps) || steps.length < 2) return null;
    const valid = steps
      .filter(
        (s): s is { agentTag: string; request: string } =>
          typeof s === "object" &&
          s !== null &&
          typeof (s as Record<string, unknown>).agentTag === "string" &&
          typeof (s as Record<string, unknown>).request === "string" &&
          input.agents.some((a) => a.tag === (s as Record<string, unknown>).agentTag),
      )
      .slice(0, 4);
    if (valid.length < 2) return null;
    return {
      steps: valid,
      reason: typeof parsed?.reason === "string" ? parsed.reason : "Cross-domain plan.",
      usage,
    };
  }

  async proposeAgent(input: ProposeAgentInput): Promise<ProposeAgentResult> {
    const system = [
      "You are the CEO of an AI marketing/distribution org for a travel-health company.",
      "Propose ONE new specialist agent worth building. It must be buildable from the",
      "read-only tools listed — never invent capabilities, never propose anything that",
      "publishes, spends, or contacts people. Its work is internal briefs a human reviews.",
      `Available tools (choose a subset): ${input.availableTools.join(", ")}.`,
      `Do not duplicate existing agents: ${input.existingAgents.join(", ") || "none"}.`,
      `Budget must be an integer cents value ≤ ${input.maxBudgetCents}.`,
      "Respond with JSON only, no prose, matching exactly:",
      '{"codename":"Word","role":"short role","mission":"1-2 sentences","rationale":"why we need it (2-3 sentences)","tools":["web_fetch"],"budgetMonthlyCents":5000,"heartbeatCron":"0 9 * * 1","heartbeatNote":"weekly ...","subagents":[{"key":"scan","name":"...","job":"...","routeWhen":["..."],"steps":["..."],"output":"...","guardrails":["..."],"sensitivity":"internal"}]}',
      "1-4 subagents. codename is a single evocative word (letters only).",
    ].join("\n");
    const { text, usage } = await this.call(
      system,
      `Company mission: ${input.companyMission}\n\nPropose an agent for: ${input.brief}`,
      1500,
      this.model, // a real design decision — use the capable work model
    );
    return { spec: safeJson(text) ?? {}, usage };
  }

  /** Real Claude tool-use loop: call tools until end_turn or the turn cap. */
  async runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
    const maxTurns = input.maxTurns ?? 8;
    const toolCalls: AgenticToolEvent[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    const tools = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
    const promptText = `${input.prompt}\n\nUse your tools to ground the work before producing it. Return the final work product as markdown. First line: a short title prefixed with "TITLE: ".`;
    // Attach any shared images as vision blocks in the first user message.
    const images = (input.attachments ?? []).map((a) => ({
      type: "image",
      source: { type: "base64", media_type: a.mimeType, data: a.dataBase64 },
    }));
    const firstContent = images.length
      ? [
          ...images,
          {
            type: "text",
            text: `${promptText}\n\nThe user attached the image(s) above — examine them as part of the request.`,
          },
        ]
      : promptText;
    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
      { role: "user", content: firstContent },
    ];

    for (let turn = 0; turn < maxTurns; turn++) {
      const res = await fetch(API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 3000,
          system: input.system,
          tools,
          messages,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Claude API ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = (await res.json()) as ClaudeResponse;
      usage = {
        inputTokens: usage.inputTokens + (data.usage?.input_tokens ?? 0),
        outputTokens: usage.outputTokens + (data.usage?.output_tokens ?? 0),
      };

      const toolUses = data.content.filter((b) => b.type === "tool_use");
      if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = data.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("\n");
        const { title, body } = extractTitle(text, `Output — ${input.kind}`);
        return { title, body, usage, toolCalls };
      }

      messages.push({ role: "assistant", content: data.content });
      const results = [];
      for (const use of toolUses) {
        const args = (use.input ?? {}) as Record<string, unknown>;
        const result = await input.callTool(use.name ?? "", args);
        const event = { name: use.name ?? "", input: args, summary: result.summary };
        toolCalls.push(event);
        await input.onToolEvent?.(event);
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: result.output.slice(0, 8000),
        });
      }
      messages.push({ role: "user", content: results });
    }

    // Turn cap reached: force a final answer without tools.
    const { text, usage: lastUsage } = await this.call(
      input.system,
      `Tool budget exhausted. Based on the work so far (${toolCalls
        .map((t) => t.summary)
        .join("; ")}), produce the final work product now as markdown, first line TITLE: ...\n\nOriginal request: ${input.prompt}`,
      2000,
    );
    usage = {
      inputTokens: usage.inputTokens + lastUsage.inputTokens,
      outputTokens: usage.outputTokens + lastUsage.outputTokens,
    };
    const { title, body } = extractTitle(text, `Output — ${input.kind}`);
    return { title, body, usage, toolCalls };
  }
}

function extractTitle(text: string, fallback: string): { title: string; body: string } {
  const lines = text.split("\n");
  const titleLine = lines.findIndex((l) => l.startsWith("TITLE:"));
  if (titleLine >= 0) {
    return {
      title: lines[titleLine].replace(/^TITLE:\s*/, "").trim() || fallback,
      body: lines.slice(titleLine + 1).join("\n").trim(),
    };
  }
  return { title: fallback, body: text };
}

function safeJson(text: string): Record<string, unknown> | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
