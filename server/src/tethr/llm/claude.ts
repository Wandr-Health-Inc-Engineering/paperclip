import type {
  ClassifyInput,
  ClassifyResult,
  GenerateInput,
  GenerateResult,
  LLMProvider,
  LLMUsage,
} from "./types.js";

// Live provider. Uses the Claude API directly over fetch so the server gains
// no SDK dependency. Selected automatically when ANTHROPIC_API_KEY is set.

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export class ClaudeProvider implements LLMProvider {
  readonly id = "claude" as const;
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, model = process.env.TETHR_CLAUDE_MODEL || DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
  }

  private async call(system: string, prompt: string, maxTokens: number): Promise<{ text: string; usage: LLMUsage }> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
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
