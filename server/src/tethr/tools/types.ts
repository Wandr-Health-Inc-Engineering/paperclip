import type { Db } from "@paperclipai/db";

// The tool registry: agents' hands. Each subagent gets an allowlisted set of
// tools derived from its spec; the agentic loop (LLMProvider.runAgentic) calls
// them and every invocation is recorded as a "tool" hop on the route run.

export interface TethrToolContext {
  db: Db;
  companyId: string;
  agentId: string;
  agentTag: string;
  subagentTag: string;
}

export interface TethrToolResult {
  /** Text returned to the model. */
  output: string;
  /** Short human-readable summary for the hop trail. */
  summary: string;
}

export interface TethrTool {
  name: string;
  description: string;
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>;
  execute(ctx: TethrToolContext, input: Record<string, unknown>): Promise<TethrToolResult>;
}

export function liveFetchEnabled(): boolean {
  return process.env.TETHR_LIVE_FETCH === "true";
}
