import { spawn } from "node:child_process";
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

// Subscription-billed provider. Instead of the Anthropic API + an API key, this
// drives the local **Claude Code CLI** in headless print mode
// (`claude -p --output-format json`), which is authenticated with the operator's
// personal Claude Pro/Max subscription. So @tethr and the org run on the
// subscription, not per-token API billing. Selected when TETHR_LLM_BACKEND=claude-code.
//
// Tradeoffs (documented for the operator):
//  - Each call spawns a Claude Code process (~seconds of latency + a few thousand
//    tokens of Claude Code's own context overhead) — heavier than the API. Pair
//    this with the global throttle when you're near your subscription limits.
//  - Cost is subscription-metered, so there's no marginal dollar cost; token
//    usage is still reported so the Budgets/usage view can gauge how hard you're
//    hitting your plan. The CLI also reports total_cost_usd (API-equivalent),
//    surfaced for visibility.
//  - The CLI won't natively call Tethr's tools, so runAgentic uses a JSON
//    tool-call protocol: the model emits {"tool","input"}, Tethr executes it and
//    feeds the result back. Read-only tools only, same allowlist as the API path.

const WORK_MODEL = process.env.TETHR_CLAUDE_CODE_MODEL || "sonnet";
const FAST_MODEL = process.env.TETHR_CLAUDE_CODE_FAST_MODEL || "haiku";
const CLI_BIN = process.env.TETHR_CLAUDE_CODE_BIN || "claude";
// Per-CLI-call ceiling. Multi-step agentic runs (e.g. the CEO's planning
// heartbeat — read the Drive, plan, draft a brief) routinely exceed 2 minutes
// on the subscription backend, so 120s was too tight and timed them out
// (adapter_failed). 300s gives real headroom; override with the env var.
const CALL_TIMEOUT_MS = Number(process.env.TETHR_CLAUDE_CODE_TIMEOUT_MS) || 300_000;
// runAgentic re-sends the transcript each turn, so keep the loop short to bound
// subscription usage (the API path defaults to 8).
const DEFAULT_MAX_TURNS = Number(process.env.TETHR_CLAUDE_CODE_MAX_TURNS) || 5;

interface CliCall {
  text: string;
  usage: LLMUsage;
  costUsd: number;
}

/** Spawn `claude -p` headless, feed one prompt, parse the JSON result. */
function runClaude(system: string, prompt: string, model: string): Promise<CliCall> {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--system-prompt",
    system,
    // Pure text generator: no filesystem/bash/web tools of Claude Code's own —
    // Tethr drives all tool use through its own protocol.
    "--allowedTools",
    "",
    // Strip Claude Code's default dynamic context to cut per-call token overhead.
    "--exclude-dynamic-system-prompt-sections",
    // Load NO MCP servers: cuts ~16k tokens of MCP-tool context per call (verified)
    // AND isolates the Tethr provider from the operator's personal MCP config.
    "--strict-mcp-config",
    prompt,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(CLI_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Claude Code timed out after ${CALL_TIMEOUT_MS / 1000}s`));
    }, CALL_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(
        new Error(
          e.message.includes("ENOENT")
            ? `Claude Code CLI not found (looked for "${CLI_BIN}"). Install it and log in with your Claude subscription.`
            : `Claude Code failed to start: ${e.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude Code exited ${code}: ${err.slice(0, 300) || out.slice(0, 300)}`));
        return;
      }
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(out) as Record<string, unknown>;
      } catch {
        reject(new Error(`Claude Code returned non-JSON: ${out.slice(0, 200)}`));
        return;
      }
      if (json.is_error) {
        reject(new Error(`Claude Code error: ${String(json.result ?? "").slice(0, 300)}`));
        return;
      }
      const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      resolve({
        text: String(json.result ?? ""),
        usage: {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
        },
        costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : 0,
      });
    });
  });
}

export class ClaudeCodeProvider implements LLMProvider {
  // Reuse the "claude" id so the live-run cost/adapter plumbing treats it as a
  // real provider (not the mock). The model string names the subscription path.
  readonly id = "claude" as const;
  readonly model: string;
  readonly fastModel: string;
  private readonly workModel: string;

  constructor(workModel = WORK_MODEL, fastModel = FAST_MODEL) {
    this.workModel = workModel;
    this.model = `claude-code:${workModel}`;
    this.fastModel = fastModel;
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
    const { text, usage } = await runClaude(
      system,
      `Request: ${input.request}\n\nDestinations:\n${optionLines}`,
      this.fastModel,
    );
    const parsed = safeJson(text);
    const tag = typeof parsed?.tag === "string" ? parsed.tag : input.options[0]?.tag ?? "";
    const known = input.options.find((o) => o.tag === tag);
    return {
      choiceTag: known ? tag : input.options[0]?.tag ?? "",
      reason: typeof parsed?.reason === "string" ? parsed.reason : `Routed to ${tag}.`,
      usage,
    };
  }

  async generate(input: GenerateInput): Promise<GenerateResult> {
    const { text, usage } = await runClaude(
      input.system,
      `${input.prompt}\n\nReturn the work product as markdown. First line: a short title prefixed with "TITLE: ".`,
      this.workModel,
    );
    return { ...extractTitle(text, `Output — ${input.kind}`), usage };
  }

  async plan(input: PlanInput): Promise<PlanResult | null> {
    const system = [
      "You are @tethr, the routing layer of an agent company.",
      "If the request genuinely spans multiple agents, return an ordered plan;",
      "if one agent can own it, return null steps.",
      'Respond with JSON only: {"steps": [{"agentTag": "@x", "request": "..."}] | null, "reason": "..."}',
      "Plans have 2-4 steps. Spend and clinical steps stay gated downstream regardless.",
    ].join("\n");
    const agentLines = input.agents.map((a) => `- ${a.tag}: ${a.description}`).join("\n");
    const { text, usage } = await runClaude(
      system,
      `Request: ${input.request}\n\nAgents:\n${agentLines}`,
      this.fastModel,
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
      `Budget must be an integer cents value <= ${input.maxBudgetCents}.`,
      "Respond with JSON only, no prose, matching exactly:",
      '{"codename":"Word","role":"short role","mission":"1-2 sentences","rationale":"why we need it (2-3 sentences)","tools":["web_fetch"],"budgetMonthlyCents":5000,"heartbeatCron":"0 9 * * 1","heartbeatNote":"weekly ...","subagents":[{"key":"scan","name":"...","job":"...","routeWhen":["..."],"steps":["..."],"output":"...","guardrails":["..."],"sensitivity":"internal"}]}',
      "1-4 subagents. codename is a single evocative word (letters only).",
    ].join("\n");
    const { text, usage } = await runClaude(
      system,
      `Company mission: ${input.companyMission}\n\nPropose an agent for: ${input.brief}`,
      this.workModel,
    );
    return { spec: safeJson(text) ?? {}, usage };
  }

  /**
   * Tool-use loop over the CLI. The CLI can't call Tethr's tools natively, so we
   * use a JSON protocol: the model replies with either a tool call or the final
   * markdown. Tethr executes tools and feeds results back. Transcript is re-sent
   * each turn (stateless), so DEFAULT_MAX_TURNS is kept low to bound usage.
   */
  async runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
    const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
    const toolCalls: AgenticToolEvent[] = [];
    let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

    const actionLines = input.tools
      .map((t) => `- ${t.name} — ${t.description} (input JSON: ${JSON.stringify(t.inputSchema)})`)
      .join("\n");
    // We deliberately avoid the word "tool" and use a text-only ACTION protocol:
    // Claude Code's own tool machinery hijacks "tool" framing, so instead the
    // model just WRITES a line that we parse. This keeps it a pure text function.
    const system = [
      input.system,
      "",
      "You are running in a RESTRICTED, TEXT-ONLY mode. You have NO ability to run anything yourself — no code, no files, no web, no tools. Never claim you executed anything.",
      "",
      "To obtain external data, reply with EXACTLY one line and nothing else:",
      "ACTION <name> <json-input>",
      "Then stop. A controller runs it and replies with the result. Repeat as needed.",
      "",
      'When you have enough, reply with the FINAL work product as markdown whose first line is "TITLE: <short title>". Do not prefix the final answer with ACTION.',
      "",
      "Available actions:",
      actionLines || "(none — just write the final answer)",
    ].join("\n");

    let transcript = `${input.prompt}\n\nBegin: emit one ACTION line, or the final answer.`;
    if (input.attachments?.length) {
      transcript += `\n\n(Note: ${input.attachments.length} image attachment(s) were shared but can't be inspected in this mode.)`;
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      const { text, usage: u } = await runClaude(system, transcript, this.workModel);
      usage = { inputTokens: usage.inputTokens + u.inputTokens, outputTokens: usage.outputTokens + u.outputTokens };

      const call = parseAction(text, input.tools.map((t) => t.name));
      if (!call) {
        return { ...extractTitle(text, `Output — ${input.kind}`), usage, toolCalls };
      }

      const result = await input.callTool(call.tool, call.input);
      const event: AgenticToolEvent = { name: call.tool, input: call.input, summary: result.summary };
      toolCalls.push(event);
      await input.onToolEvent?.(event);
      transcript +=
        `\n\n> ACTION ${call.tool} ${JSON.stringify(call.input)}\n` +
        `Result:\n${result.output.slice(0, 6000)}\n\n` +
        `Emit another ACTION line, or the final answer now.`;
    }

    // Turn cap: force a final answer from what we gathered.
    const { text, usage: last } = await runClaude(
      input.system,
      `Based on the work so far (${toolCalls.map((t) => t.summary).join("; ") || "no tool results"}), produce the final work product now as markdown, first line "TITLE: ...".\n\nOriginal request: ${input.prompt}`,
      this.workModel,
    );
    usage = { inputTokens: usage.inputTokens + last.inputTokens, outputTokens: usage.outputTokens + last.outputTokens };
    return { ...extractTitle(text, `Output — ${input.kind}`), usage, toolCalls };
  }
}

/**
 * Extract an action request from the model's reply, or null if it's the final
 * answer. Accepts the primary `ACTION <name> {json}` line format, and falls back
 * to a `{"tool"|"action","input"}` JSON object for robustness.
 */
function parseAction(text: string, knownTools: string[]): { tool: string; input: Record<string, unknown> } | null {
  const s = String(text ?? "");
  // A final answer is anything that leads with a TITLE: — never treat as action.
  if (/^\s*TITLE:/m.test(s) && !/^\s*ACTION\s+/m.test(s)) return null;
  // Primary: an `ACTION <name> {json}` line.
  const line = s.split("\n").map((l) => l.trim()).find((l) => l.startsWith("ACTION "));
  if (line) {
    const rest = line.slice("ACTION ".length).trim();
    const sp = rest.search(/\s/);
    const name = (sp === -1 ? rest : rest.slice(0, sp)).trim();
    if (knownTools.includes(name)) {
      const jsonPart = sp === -1 ? "" : rest.slice(sp).trim();
      const parsed = jsonPart ? safeJson(jsonPart) : {};
      return { tool: name, input: parsed ?? {} };
    }
  }
  // Fallback: a JSON object with tool/action + input.
  const parsed = safeJson(s);
  const name = typeof parsed?.tool === "string" ? parsed.tool : typeof parsed?.action === "string" ? parsed.action : null;
  if (name && knownTools.includes(name)) {
    const input = parsed!.input && typeof parsed!.input === "object" ? (parsed!.input as Record<string, unknown>) : {};
    return { tool: name, input };
  }
  return null;
}

function extractTitle(text: string, fallback: string): { title: string; body: string } {
  const lines = String(text ?? "").split("\n");
  const titleLine = lines.findIndex((l) => l.startsWith("TITLE:"));
  if (titleLine >= 0) {
    return {
      title: lines[titleLine].replace(/^TITLE:\s*/, "").trim() || fallback,
      body: lines.slice(titleLine + 1).join("\n").trim(),
    };
  }
  return { title: fallback, body: String(text ?? "") };
}

function safeJson(text: string): Record<string, unknown> | null {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
