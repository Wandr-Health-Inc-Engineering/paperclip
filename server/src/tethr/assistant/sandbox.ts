// Phase 26.6: the sealed room a sandboxed agent (the learner) works in. Its
// own folder outside the shared Drive, no memory, no connectors, no team tools,
// no skills, no shell: web search, public pages, its own files, and the one
// tethr tool it needs. The runner's deny rules, the hook gate and the tools
// endpoint all apply the same list.

import { SANDBOX_TOOLS } from "./learn-tools.js";

/** Claude Code's own tools a sandboxed agent gets. */
export const SANDBOX_BUILTINS = ["Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "ToolSearch", "WebSearch", "WebFetch"] as const;

const ALLOWED = new Set<string>([...SANDBOX_BUILTINS, ...[...SANDBOX_TOOLS].map((t) => `mcp__tethr__${t}`)]);

/** Why the gate refuses a sandboxed agent this call, or null. */
export function sandboxRefusal(tag: string, toolName: string): string | null {
  return ALLOWED.has(toolName)
    ? null
    : `Tethr approval gate: blocked. ${tag} works in a sealed folder: web search, public pages, its own files and propose_lesson only.`;
}
