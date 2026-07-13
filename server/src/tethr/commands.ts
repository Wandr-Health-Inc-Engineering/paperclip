// Tethr's built-in command surface — the "/help" guide and friends.
//
// Design goal: EVER-GROWING with one edit. Add a row to TETHR_COMMANDS and it
// shows up in the guide, is recognized as a command, and (for meta commands)
// dispatches — no other file changes. Commands are handled deterministically in
// the Slack layer (like the reset flow): fast, free, never routed to the LLM.
//
// These are TEXT commands: "/help" and "help" both work, so they behave like
// slash commands without needing Slack's native slash-command registration.

export type TethrCommandKind = "help" | "agents" | "reset";

export interface TethrCommand {
  /** Canonical name (also the primary keyword). */
  name: string;
  /** Extra keywords that trigger the same command. */
  aliases: string[];
  /** Shown in the guide. */
  usage: string;
  /** One-line description in the guide. */
  summary: string;
  /** Dispatch tag. "reset" is documented here but handled by the wipe flow. */
  kind: TethrCommandKind;
}

// The registry. Order here is the order shown in /help.
export const TETHR_COMMANDS: TethrCommand[] = [
  {
    name: "help",
    aliases: ["guide", "commands", "menu", "?", "what can you do"],
    usage: "/help",
    summary: "Show what I can do and how to talk to me",
    kind: "help",
  },
  {
    name: "agents",
    aliases: ["team", "roster", "who", "org"],
    usage: "/agents",
    summary: "List the current agents and who oversees each one",
    kind: "agents",
  },
  {
    name: "reset",
    aliases: ["wipe", "clear", "cleanup", "clean up", "clean slate", "new topic", "forget"],
    usage: "/reset",
    summary: "Clear our current conversation — I confirm before wiping",
    kind: "reset",
  },
];

/**
 * Match a message (already stripped of a leading slash) to a META command that
 * gets a deterministic reply — help or agents. Reset is intentionally excluded:
 * it flows through the confirmation logic in the Slack layer, not here.
 *
 * A bare message must equal a command/alias exactly (so "who is our competitor?"
 * doesn't trip the "who" alias). First-word matching is allowed only when the
 * message was slash-prefixed ("/agents foo"), which signals command intent.
 */
export function matchMetaCommand(
  bareText: string,
  opts: { firstWord?: boolean } = {},
): Exclude<TethrCommandKind, "reset"> | null {
  const norm = bareText.trim().toLowerCase();
  const firstWord = norm.split(/\s+/)[0] ?? "";
  for (const cmd of TETHR_COMMANDS) {
    if (cmd.kind === "reset") continue;
    const keys = [cmd.name, ...cmd.aliases];
    if (keys.includes(norm)) return cmd.kind;
    if (opts.firstWord && keys.includes(firstWord)) return cmd.kind;
  }
  return null;
}

/** The `/help` guide, generated from the registry so it never goes stale. */
export function renderHelpMessage(): string {
  const commandLines = TETHR_COMMANDS.map(
    (c) => `• \`${c.usage}\` — ${c.summary}`,
  ).join("\n");
  return [
    "*Tethr — your coordinator*",
    "Ask me anything in plain language and I'll answer, draft a plan for the Drive, or (as specialists come online) route it to the right agent. Tag me in a channel or just DM me.",
    "",
    "*Commands*",
    commandLines,
    "",
    "*Good to know*",
    "• I remember our conversation in this thread — follow-ups have context. Say `/reset` to start fresh.",
    "• If something needs a human decision, I'll tag your overseer right here in the thread.",
    "• Nothing goes out externally without a human approving it first.",
  ].join("\n");
}
