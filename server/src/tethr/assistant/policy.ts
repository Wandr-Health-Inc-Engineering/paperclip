import path from "node:path";

// The approval gate's policy (phase 18). Every tool call the chat's Claude
// session makes passes through the PreToolUse hook → POST /tethr/hooks/pre →
// classify() + decide() here. Pure functions: no I/O, fully unit-tested.
//
// Classes: read (look only) · draft (prepared, not sent) · write (changes
// something) · public (reaches someone outside Wandr) · money · medical ·
// builtin (Claude's own safe tools) · workspace (file write inside Tethr's
// workspace) · shell · blocked (anything else).
//
// Modes per connector: off · read · ask (approval required) · auto. Money,
// public and medical always ask, even in auto (Mark's always-ask list).

export type ToolClass =
  | "read"
  | "draft"
  | "write"
  | "public"
  | "money"
  | "medical"
  | "builtin"
  | "workspace"
  | "shell"
  | "blocked";

export type ConnectorMode = "off" | "read" | "ask" | "auto";

export interface Classified {
  tool: string;
  /** Human label of the connector ("Gmail", "Google Calendar"), null for built-ins. */
  connector: string | null;
  /** MCP server segment ("claude_ai_Gmail"), null for built-ins. */
  server: string | null;
  cls: ToolClass;
  /** One line for activity rows and approval cards. */
  summary: string;
  /** Why it's blocked, for blocked built-ins. */
  blockedReason?: string;
}

export interface PolicyContext {
  workspaceDir: string;
  /** Folders built-in read tools may look in (workspace, 00 Tethr). */
  readableRoots: string[];
  /** Email domains / addresses counted as inside Wandr (e.g. "travelwithwandr.com"). */
  internalAddresses: string[];
}

export type Decision =
  | { action: "allow"; note?: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string };

const SAFE_BUILTINS = new Set([
  "ToolSearch",
  "TodoWrite",
  "WebSearch",
  "WebFetch",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
]);
const READ_BUILTINS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_BUILTINS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

type Rule = [RegExp, ToolClass];
// Order matters: first match wins. Tool names are the suffix after mcp__<server>__.
const CONNECTOR_RULES: Record<string, Rule[]> = {
  Gmail: [
    [/^(get_|list_|search_)/, "read"],
    [/^(create_draft|update_draft|delete_draft)$/, "draft"],
    [/^(send_message|reply|forward)$/, "write"],
    [/.*/, "write"], // labels, spam, trash: change the inbox
  ],
  Slack: [
    [/^slack_(read_|search_|list_|get_)/, "read"],
    [/^slack_send_message_draft$/, "draft"],
    [/.*/, "write"],
  ],
  "Google Calendar": [
    [/^(list_|get_|search_|suggest_time$)/, "read"],
    [/.*/, "write"],
  ],
  "Google Drive": [
    [/^(search_files|read_file_content|download_file_content|list_|get_)/, "read"],
    [/^share_file$/, "public"],
    [/.*/, "write"],
  ],
  "Google Sheets": [
    [/^get_/, "read"],
    [/.*/, "write"],
  ],
  Stripe: [
    [/^(stripe_api_read|stripe_api_search|stripe_api_details|stripe_analytics|stripe_reports|search_stripe_documentation|list_available_accounts_or_orgs|stripe_implementation_planner)$/, "read"],
    [/^(stripe_api_write|manage_stripe_accounts|atlas_company_formation)$/, "money"],
    [/.*/, "write"],
  ],
  Mercury: [[/.*/, "money"]],
  Clay: [
    [/^(get-|get_|list_|search-|query-objects$|ask-question-about-accounts$|load-more-search-results$|render-search-results$)/, "read"],
    [/.*/, "write"], // add-*, run_subroutine* spend Clay credits
  ],
  "Claude Docs": [
    [/^(query|read|export)$/, "read"],
    [/.*/, "write"],
  ],
  Canva: [
    [/^(get-|list-|search-|read-|help$|resolve-shortlink$)/, "read"],
    [/^publish-brand-template$/, "public"],
    [/.*/, "write"],
  ],
  Figma: [
    [/^(get_|list_|search_|whoami$|weave_get_|weave_list_|weave_find_)/, "read"],
    [/.*/, "write"],
  ],
};

const READ_VERB = /^(get|list|search|read|query|fetch|describe|download|export|lookup|find|show|view|count|help|whoami)([-_]|$)/i;
const POSTHOG_READ_VERB = /^\s*(list|get|query|search|read|docs-search|explain|execute-sql|insight\s+(get|list)|dashboard\s+(get|list))\b/i;

// Patient-level clinical content. Deliberately narrow so marketing copy about
// travel meds isn't swept in; anything matching always needs Mark.
const MEDICAL = /\b(prescri(be|bed|ption|ptions)|diagnos(is|ed|e)|patient'?s?|symptoms?|dosage|side effects?|contraindicat\w*|medical history|allerg(y|ies|ic)|pregnan(t|cy)|lab results?)\b/i;

/** "mcp__claude_ai_Google_Calendar__list_events" → { server, connector, name } */
export function parseMcpTool(tool: string): { server: string; connector: string; name: string } | null {
  if (!tool.startsWith("mcp__")) return null;
  const rest = tool.slice(5);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const name = rest.slice(sep + 2);
  const connector = server.startsWith("claude_ai_") ? server.slice(10).replace(/_/g, " ") : server;
  return { server, connector, name };
}

function within(file: string, roots: string[]): boolean {
  const abs = path.resolve(file);
  return roots.some((root) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
}

function recipients(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["to", "cc", "bcc", "attendees", "recipients", "emails"]) {
    const v = input[key];
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]/) : [];
    for (const item of list) {
      const s = typeof item === "string" ? item : typeof item === "object" && item ? String((item as Record<string, unknown>).email ?? "") : "";
      const m = s.match(/[^\s<>"]+@[^\s<>"]+/);
      if (m) out.push(m[0].toLowerCase());
    }
  }
  return out;
}

export function isInternal(address: string, internal: string[]): boolean {
  const a = address.toLowerCase();
  return internal.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^@/, "");
    if (!e) return false;
    return e.includes("@") ? a === e : a.endsWith("@" + e);
  });
}

function words(name: string): string {
  return name.replace(/^slack_/, "").replace(/[-_]+/g, " ").trim();
}

function summarize(connector: string, name: string, input: Record<string, unknown>): string {
  const to = recipients(input);
  const subject = typeof input.subject === "string" ? input.subject : null;
  if (connector === "Gmail" && /^(send_message|reply|forward|create_draft|update_draft)$/.test(name)) {
    const verb = name.includes("draft") ? "Draft email" : name === "reply" ? "Reply" : name === "forward" ? "Forward" : "Email";
    return `${verb}${to.length ? ` to ${to.join(", ")}` : ""}${subject ? ` — “${subject}”` : ""}`;
  }
  if (connector === "Slack" && /send_message|schedule_message/.test(name)) {
    const ch = input.channel_id ?? input.channel ?? input.channel_name;
    return `Slack message${ch ? ` to ${String(ch)}` : ""}`;
  }
  if (connector === "Google Calendar" && /event/.test(name)) {
    const title = input.summary ?? input.title;
    return `Calendar: ${words(name)}${title ? ` — “${String(title)}”` : ""}`;
  }
  return `${connector}: ${words(name)}`;
}

/** Classify one tool call. */
export function classify(tool: string, input: Record<string, unknown> | undefined, ctx: PolicyContext): Classified {
  const args = input ?? {};
  const mcp = parseMcpTool(tool);
  if (!mcp) {
    if (SAFE_BUILTINS.has(tool)) return { tool, connector: null, server: null, cls: "builtin", summary: builtinSummary(tool, args) };
    if (READ_BUILTINS.has(tool)) {
      const target = String(args.file_path ?? args.path ?? "");
      if (target && !within(target, ctx.readableRoots)) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: "it's outside Tethr's folders (00 Tethr)" };
      }
      return { tool, connector: null, server: null, cls: "builtin", summary: builtinSummary(tool, args) };
    }
    if (WRITE_BUILTINS.has(tool)) {
      const target = String(args.file_path ?? args.notebook_path ?? "");
      const generated = path.resolve(ctx.workspaceDir, "CLAUDE.md");
      if (!target || !within(target, [ctx.workspaceDir])) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: "Tethr only writes inside its workspace folder" };
      }
      if (path.resolve(target) === generated) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: "CLAUDE.md is generated by Tethr; put notes in Memory.md" };
      }
      return { tool, connector: null, server: null, cls: "workspace", summary: builtinSummary(tool, args) };
    }
    if (tool === "Bash") return { tool, connector: null, server: null, cls: "shell", summary: `Run: ${String(args.command ?? "").slice(0, 120)}` };
    return { tool, connector: null, server: null, cls: "blocked", summary: tool, blockedReason: "that tool isn't available in Tethr's chat" };
  }

  const { server, connector, name } = mcp;
  let cls: ToolClass = READ_VERB.test(name) ? "read" : "write";
  const rules = CONNECTOR_RULES[connector];
  if (rules) {
    for (const [re, c] of rules) {
      if (re.test(name)) {
        cls = c;
        break;
      }
    }
  }
  if (connector === "PostHog" && name === "exec") {
    cls = POSTHOG_READ_VERB.test(String(args.command ?? "")) ? "read" : "write";
  }

  if (cls !== "read" && cls !== "money") {
    const outward = recipients(args);
    if ((cls === "write" || cls === "draft") && outward.some((a) => !isInternal(a, ctx.internalAddresses))) {
      // A draft to an outsider is still only a draft; sending/inviting them is public.
      if (cls === "write") cls = "public";
    }
    if (MEDICAL.test(JSON.stringify(args))) cls = "medical";
  }
  return { tool, connector, server, cls, summary: summarize(connector, name, args) };
}

/** Decide what the gate does with a classified call, given the connector's mode. */
export function decide(c: Classified, opts: { mode: ConnectorMode; shell: "off" | "ask" }): Decision {
  switch (c.cls) {
    case "builtin":
    case "workspace":
      return { action: "allow" };
    case "blocked":
      return { action: "deny", reason: `Tethr approval gate: blocked — ${c.blockedReason ?? "not allowed"}.` };
    case "shell":
      return opts.shell === "ask"
        ? { action: "ask", reason: `Tethr approval gate: shell command waiting for Mark's approval — ${c.summary}` }
        : { action: "deny", reason: "Tethr approval gate: shell commands are turned off in Tethr." };
    default:
      break;
  }
  const label = c.connector ?? "This connector";
  // Mercury and anything money: never more than "ask".
  const mode: ConnectorMode = c.cls === "money" && opts.mode === "auto" ? "ask" : opts.mode;
  if (mode === "off") return { action: "deny", reason: `Tethr approval gate: ${label} is turned off in Tethr's Integrations.` };
  if (c.cls === "read") return { action: "allow" };
  if (mode === "read") return { action: "deny", reason: `Tethr approval gate: ${label} is read-only in Tethr, so this was not done — ${c.summary}.` };
  if (c.cls === "draft") return { action: "allow" };
  if (mode === "auto" && c.cls === "write") return { action: "allow", note: "auto" };
  const why =
    c.cls === "money" ? " (moves money)" : c.cls === "public" ? " (goes outside Wandr)" : c.cls === "medical" ? " (mentions medical details)" : "";
  return { action: "ask", reason: `Tethr approval gate: waiting for Mark's approval${why} — ${c.summary}.` };
}

function builtinSummary(tool: string, args: Record<string, unknown>): string {
  const file = typeof args.file_path === "string" ? path.basename(args.file_path) : null;
  switch (tool) {
    case "ToolSearch":
      return "Looking up tools";
    case "WebSearch":
      return `Searching the web${typeof args.query === "string" ? ` for “${args.query.slice(0, 60)}”` : ""}`;
    case "WebFetch":
      try {
        return `Reading ${new URL(String(args.url)).host}`;
      } catch {
        return "Reading a web page";
      }
    case "Read":
      return `Reading ${file ?? "a file"}`;
    case "Glob":
    case "Grep":
    case "LS":
      return "Searching files";
    case "Write":
      return `Writing ${file ?? "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${file ?? "a file"}`;
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "Planning";
    default:
      return tool;
  }
}
