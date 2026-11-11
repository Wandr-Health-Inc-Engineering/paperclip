// The learner's sealed rooms (phase 26.6, rebuilt 2026-11-10). Every turn of a
// sandboxed agent (the learner, @sage) runs in one room: its own folder outside
// the shared Drive, its own CLAUDE.md, its own tool list. The rule that keeps it
// safe: private data and the web are never in the same room.
// - desk: a person talks to Sage. It knows its studies and skills; no web.
// - plan: what's been happening in tethr, goals, skills, memory; no web. It
//   picks what to study and writes the research questions.
// - research: the web, and only the topic and questions (screened). Nothing private.
// - apply: the findings next to what tethr already knows; no web. It saves skills.
// The runner's tool list and deny rules, the hook gate and the tools endpoint all
// read the same table.

export const SANDBOX_ROOMS = ["desk", "plan", "research", "apply"] as const;
export type SandboxRoom = (typeof SANDBOX_ROOMS)[number];
export type StudyDepth = "quick" | "deep";

interface RoomSpec {
  /** Claude Code's own tools the room gets (--tools). */
  builtins: readonly string[];
  /** Tethr tools (mcp__tethr__*) the room gets. */
  tools: readonly string[];
  /** The adapter's limits for one turn. */
  limits: Record<StudyDepth, { timeoutSec: number; maxTurns: number }>;
  /** Whether the room sees the company's private data (never together with the web). */
  privateData: boolean;
}

const LOCAL = ["Read", "Glob", "Grep", "ToolSearch"] as const;
const same = (timeoutSec: number, maxTurns: number) => ({ quick: { timeoutSec, maxTurns }, deep: { timeoutSec, maxTurns } });

export const ROOM_SPECS: Record<SandboxRoom, RoomSpec> = {
  desk: { builtins: LOCAL, tools: ["start_study", "skill_view"], limits: same(600, 30), privateData: true },
  plan: { builtins: LOCAL, tools: ["plan_study", "skip_study"], limits: same(300, 20), privateData: true },
  research: {
    builtins: ["WebSearch", "WebFetch", "ToolSearch", "TodoWrite"],
    tools: ["submit_findings"],
    limits: { quick: { timeoutSec: 900, maxTurns: 40 }, deep: { timeoutSec: 2700, maxTurns: 150 } },
    privateData: false,
  },
  apply: { builtins: LOCAL, tools: ["apply_skill", "finish_study"], limits: same(600, 30), privateData: true },
};

/** Every tethr tool that exists only for the learner's rooms (nobody else lists or calls them). */
export const STUDY_TOOL_NAMES = ["start_study", "plan_study", "skip_study", "submit_findings", "apply_skill", "finish_study"] as const;
export const STUDY_TOOL_SET = new Set<string>(STUDY_TOOL_NAMES);

/** Claude Code tools no room ever gets (on top of whatever --tools leaves out). */
const NEVER = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Skill", "Task"];

export function isRoom(value: unknown): value is SandboxRoom {
  return typeof value === "string" && (SANDBOX_ROOMS as readonly string[]).includes(value);
}

/** The tethr tools a room lists and runs. */
export function roomTools(room: SandboxRoom): Set<string> {
  return new Set(ROOM_SPECS[room].tools);
}

/** Deny rules for a room's settings file: every Claude Code tool it doesn't get, and every other tethr tool. */
export function roomDenyRules(room: SandboxRoom, allTethrTools: readonly string[]): string[] {
  const spec = ROOM_SPECS[room];
  const builtins = ["WebSearch", "WebFetch", "TodoWrite", ...NEVER].filter((t) => !spec.builtins.includes(t));
  const tethr = allTethrTools.filter((name) => !spec.tools.includes(name)).map((name) => `mcp__tethr__${name}`);
  return [...builtins, ...tethr];
}

/** Why the gate refuses a sandboxed agent this call in this room, or null. */
export function sandboxRefusal(tag: string, toolName: string, room: SandboxRoom): string | null {
  const spec = ROOM_SPECS[room];
  if (spec.builtins.includes(toolName)) return null;
  if (toolName.startsWith("mcp__tethr__") && spec.tools.includes(toolName.slice("mcp__tethr__".length))) return null;
  const web = toolName === "WebSearch" || toolName === "WebFetch";
  return web && spec.privateData
    ? `Tethr approval gate: blocked. ${tag} can't use the web in a room that holds the company's own data.`
    : `Tethr approval gate: blocked. ${tag}'s ${room} room can't use ${toolName}.`;
}
