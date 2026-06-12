// Tethr LLM provider seam. Local builds run the deterministic mock; setting
// ANTHROPIC_API_KEY switches every agent to live Claude calls. Cloud swap is
// an env change, not a code change (see MIGRATION-NOTES.md).

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ClassifyOption {
  tag: string;
  description: string;
  when: string[];
}

export interface ClassifyInput {
  layer: "helm" | "agent";
  actorTag: string;
  request: string;
  options: ClassifyOption[];
}

export interface ClassifyResult {
  choiceTag: string;
  reason: string;
  usage: LLMUsage;
}

export interface GenerateInput {
  /** Subagent identity + guardrails, rendered as the system prompt. */
  system: string;
  /** The work request. */
  prompt: string;
  /** Output kind hint — lets the mock produce realistically-shaped content. */
  kind: string;
  /** Extra structured context (agent tag, steps, reads). */
  context?: Record<string, unknown>;
}

export interface GenerateResult {
  title: string;
  body: string;
  usage: LLMUsage;
}

export interface AgenticToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgenticToolEvent {
  name: string;
  input: Record<string, unknown>;
  summary: string;
}

export interface RunAgenticInput extends GenerateInput {
  tools: AgenticToolSpec[];
  /** Executes a tool; returns the text for the model + a hop summary. */
  callTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ output: string; summary: string }>;
  /** Fired after each tool call (drives the live hop trail). */
  onToolEvent?(event: AgenticToolEvent): Promise<void> | void;
  maxTurns?: number;
}

export interface RunAgenticResult extends GenerateResult {
  toolCalls: AgenticToolEvent[];
}

export interface LLMProvider {
  readonly id: "mock" | "claude";
  readonly model: string;
  classify(input: ClassifyInput): Promise<ClassifyResult>;
  generate(input: GenerateInput): Promise<GenerateResult>;
  /** Multi-turn tool-use loop. The subagent's hands. */
  runAgentic(input: RunAgenticInput): Promise<RunAgenticResult>;
}
