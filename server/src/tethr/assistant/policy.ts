import path from "node:path";
import { isPrivateHost } from "../net.js";
import { areaById, isAreaId } from "../growth-map/areas.js";

export { isPrivateHost, resolvesToPrivateHost } from "../net.js";

// The approval gate's policy (phase 18). Every tool call the chat's Claude
// session makes passes through the PreToolUse hook → POST /tethr/hooks/pre →
// classify() + decide() here. Pure functions: no I/O, fully unit-tested.
//
// Classes: read (look only) · draft (prepared, not sent) · write (changes
// something) · public (reaches someone outside Wandr) · money · medical ·
// destructive (deletes or overwrites) · web (opens a web page) · builtin
// (Claude's own safe tools) · workspace (file write inside Tethr's workspace) ·
// shell · blocked (anything else).
//
// Modes per connector: off · read · ask (approval required) · auto. Money,
// public, medical and destructive always ask, even in auto (Mark's always-ask
// list). Web pages are free until the thread has read connector data (a
// "tainted" thread); after that a page outside Wandr's own domains asks, since
// a URL can carry private data out.

export type ToolClass =
  | "read"
  | "draft"
  | "write"
  | "public"
  | "money"
  | "medical"
  | "destructive"
  | "web"
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
  /** web: the page is on one of Wandr's own domains. */
  internalHost?: boolean;
}

export interface PolicyContext {
  workspaceDir: string;
  /** Folders built-in read tools may look in (workspace, 00 Tethr). */
  readableRoots: string[];
  /** Email domains / addresses counted as inside Wandr (e.g. "travelwithwandr.com"). */
  internalAddresses: string[];
  /** The Claude session's working directory; relative tool paths resolve against
   * it (defaults to workspaceDir). Never the server's own cwd. */
  cwd?: string;
}

export type Decision =
  | { action: "allow"; note?: string }
  | { action: "deny"; reason: string }
  | { action: "ask"; reason: string };

const SAFE_BUILTINS = new Set([
  "ToolSearch",
  "TodoWrite",
  "WebSearch",
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
    [/^(trash_|delete_label$)/, "destructive"],
    [/.*/, "write"], // labels, spam: change the inbox
  ],
  Slack: [
    [/^slack_(read_|search_|list_|get_)/, "read"],
    [/^slack_send_message_draft$/, "draft"],
    [/.*/, "write"],
  ],
  "Google Calendar": [
    [/^(list_|get_|search_|suggest_time$)/, "read"],
    [/^delete_event$/, "destructive"],
    [/.*/, "write"],
  ],
  "Google Drive": [
    [/^(search_files|read_file_content|download_file_content|list_|get_)/, "read"],
    [/^share_file$/, "public"],
    [/^(trash_file|update_file)$/, "destructive"],
    [/.*/, "write"],
  ],
  "Google Sheets": [
    [/^get_/, "read"],
    [/^batch_clear_values$/, "destructive"],
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
    [/^delete$/, "destructive"],
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
  // Tethr's own MCP server "tethr" (phase 19): scoring and keyword lookups,
  // run in the Tethr server; they change nothing outside its files/ folder.
  "Tethr tools": [
    // make_document only writes a new file into Tethr's own files/ folder.
    [/^(score_list|keyword_ideas|goals_list|make_document|team_list|growth_map|lessons_due|google_ads_report)$/, "read"],
    // Goals live in Tethr itself: saving one changes nothing outside Tethr.
    [/^(save_goal|save_metric|record_metric)$/, "draft"],
    // Phase 23: running tethr's team happens inside Tethr. New agents and
    // changes still follow the Team setting (an approval card under "Ask me").
    [/^(create_agent|assign_task|update_agent)$/, "draft"],
    // Phase 25: tethr's memory (Hermes, or the built-in store). Saving is
    // internal like goals; searching and reading skills are reads.
    [/^(recall|skill_view)$/, "read"],
    [/^(memory|skill_save)$/, "draft"],
    // Phase 26.9: the growth map lives in Tethr; an audit or link changes nothing outside it.
    [/^map_area$/, "draft"],
    // Phase 26.5-26.6: lessons are proposed, queued and reviewed inside Tethr; only a person applies one.
    [/^(propose_lesson|study|review_lesson)$/, "draft"],
    // Phase 27: a question to the person is a card inside Tethr. It grants nothing:
    // the answer comes back as their own message.
    // delete_files only stages a card (destructive: always a person's yes).
    [/^(ask|need_connection|delete_files|checklist)$/, "draft"],
    [/.*/, "blocked"],
  ],
};

const READ_VERB = /^(get|list|search|read|query|fetch|describe|download|export|lookup|find|show|view|count|help|whoami)([-_]|$)/i;
const DESTRUCTIVE_VERB = /^(delete|trash|remove|destroy|purge|archive)([-_]|$)/i;
/** Files Claude Code treats as its own config or instructions. Never writable. */
const CLAUDE_FILES = new Set(["claude.md", "claude.local.md", ".mcp.json"]);
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
  const connector = server === "tethr" ? "Tethr tools" : server.startsWith("claude_ai_") ? server.slice(10).replace(/_/g, " ") : server;
  return { server, connector, name };
}

/** A tool path as an absolute path, resolving relative ones against the Claude
 * session's cwd (not this server's). */
function absPath(file: string, ctx: PolicyContext): string {
  return path.resolve(ctx.cwd ?? ctx.workspaceDir, file);
}

function within(abs: string, roots: string[]): boolean {
  return roots.some((root) => {
    const r = path.resolve(root);
    return abs === r || abs.startsWith(r + path.sep);
  });
}

/** Where the chat may write: anything under files/. Never a dot path or a
 * CLAUDE*.md / .mcp.json anywhere (Claude Code loads those as settings, hooks
 * or instructions; a hook there would run shell commands). Memory.md is a copy
 * tethr writes (phase 25); memories are saved with the memory tool.
 * Returns why a target is refused, or null when it's fine. */
export function workspaceWriteRefusal(abs: string, workspaceDir: string): string | null {
  const rel = path.relative(path.resolve(workspaceDir), abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return "Tethr only writes inside its workspace folder";
  const parts = rel.split(path.sep);
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.some((p) => p.startsWith(".")) || CLAUDE_FILES.has(lower[lower.length - 1])) {
    return lower[lower.length - 1] === "claude.md"
      ? "CLAUDE.md is generated by Tethr; save memories with the memory tool"
      : "that's a settings file Tethr doesn't let the chat change";
  }
  if (parts.length === 1 && lower[0] === "memory.md") return "Memory.md is a copy Tethr writes; save memories with the memory tool (tethr tools)";
  return parts.length > 1 && lower[0] === "files" ? null : "files go in the files/ folder";
}

/** Input fields that name who a message or invite reaches. Calendar's added and
 * removed attendees count: both get an email from Google. */
const RECIPIENT_FIELDS = [
  "to",
  "cc",
  "bcc",
  "recipients",
  "emails",
  "attendees",
  "attendeeEmails",
  "addedAttendees",
  "addedAttendeeEmails",
  "removedAttendeeEmails",
];

function recipients(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of RECIPIENT_FIELDS) {
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

/** A growth-map area's name for a step label ("an area" when the input names none). */
function areaLabel(area: unknown): string {
  return isAreaId(area) ? areaById(area).name : "an area";
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
  if (connector === "Tethr tools" && name === "score_list") {
    const n = Array.isArray(input.items) ? input.items.length : 0;
    const from = typeof input.from_file === "string" ? path.basename(input.from_file) : "";
    return `Scoring ${n ? `${n} items` : from ? from : "a list"} with Jev`;
  }
  if (connector === "Tethr tools" && name === "goals_list") return "Reading the goals";
  if (connector === "Tethr tools" && name === "checklist") return `Making you a checklist${typeof input.title === "string" ? `: “${input.title.slice(0, 60)}”` : ""}`;
  if (connector === "Tethr tools" && name === "delete_files") {
    const n = Array.isArray(input.paths) ? input.paths.length : 0;
    return n ? `Asking to delete ${n} file${n === 1 ? "" : "s"}` : "Asking to delete files";
  }
  if (connector === "Tethr tools" && name === "need_connection") return `Asking for a connection${typeof input.connector === "string" ? `: ${input.connector.slice(0, 40)}` : ""}`;
  if (connector === "Tethr tools" && name === "google_ads_report") return `Reading Google Ads (${typeof input.report === "string" ? input.report : "overview"})`;
  if (connector === "Tethr tools" && name === "ask") return `Asking you${typeof input.question === "string" ? `: “${input.question.slice(0, 80)}”` : ""}`;
  if (connector === "Tethr tools" && name === "propose_lesson") return `Proposing a lesson${typeof input.lesson === "string" ? `: “${input.lesson.slice(0, 60)}”` : ""}`;
  if (connector === "Tethr tools" && name === "study") return `Queueing a topic to study${typeof input.topic === "string" ? `: “${input.topic.slice(0, 60)}”` : ""}`;
  if (connector === "Tethr tools" && name === "lessons_due") return "Reading the lessons due for review";
  if (connector === "Tethr tools" && name === "review_lesson") return input.verdict === "retired" ? "Suggesting a lesson be retired" : "Suggesting a lesson be kept";
  if (connector === "Tethr tools" && name === "growth_map") return input.area ? `Reading the growth map (${areaLabel(input.area)})` : "Reading the growth map";
  if (connector === "Tethr tools" && name === "map_area") {
    if (typeof input.score === "number") return `Recording an audit of ${areaLabel(input.area)}`;
    return input.focus === true ? `Setting the focus: ${areaLabel(input.area)}` : `Updating ${areaLabel(input.area)} on the growth map`;
  }
  if (connector === "Tethr tools" && name === "make_document") {
    const format = typeof input.format === "string" ? input.format.toUpperCase() : "document";
    return `Making a ${format}${typeof input.title === "string" ? ` “${input.title.slice(0, 60)}”` : ""}`;
  }
  if (connector === "Tethr tools" && name === "save_goal") {
    return `Saving goal${typeof input.title === "string" ? ` “${input.title.slice(0, 60)}”` : ""}`;
  }
  if (connector === "Tethr tools" && name === "save_metric") {
    return `Saving metric${typeof input.name === "string" ? ` “${input.name.slice(0, 60)}”` : ""}`;
  }
  if (connector === "Tethr tools" && name === "record_metric") return "Recording a goal measurement";
  if (connector === "Tethr tools" && name === "memory") return input.target === "people" ? "Saving to memory (people)" : "Saving to memory";
  if (connector === "Tethr tools" && name === "recall") {
    return typeof input.query === "string" && input.query.trim() ? `Searching past chats for “${input.query.trim().slice(0, 60)}”` : "Reading a past chat";
  }
  if (connector === "Tethr tools" && name === "skill_view") return `Loading the skill${typeof input.name === "string" ? ` “${input.name.slice(0, 60)}”` : ""}`;
  if (connector === "Tethr tools" && name === "skill_save") return `Saving a skill${typeof input.name === "string" ? ` “${input.name.slice(0, 60)}”` : ""}`;
  if (connector === "Tethr tools" && name === "keyword_ideas") {
    const seeds = Array.isArray(input.seeds) ? input.seeds.filter((s) => typeof s === "string").slice(0, 3) : [];
    return `Keyword ideas${seeds.length ? ` for ${seeds.map((s) => `“${String(s).slice(0, 40)}”`).join(", ")}` : ""}`;
  }
  if (connector === "Google Calendar" && /event/.test(name)) {
    const title = input.summary ?? input.title;
    return `Calendar: ${words(name)}${title ? ` — “${String(title)}”` : ""}`;
  }
  return `${connector}: ${words(name)}`;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** Calendar event fields every guest sees on their own copy of the event,
 * whether or not Google emails them about the change. Color and reminders are
 * the user's own and aren't listed. */
const GUEST_VISIBLE_EVENT_FIELDS = [
  "summary",
  "description",
  "location",
  "startTime",
  "endTime",
  "allDay",
  "timeZone",
  "addedAttachments",
  "removedAttachmentFileUrls",
  "addGoogleMeetUrl",
  "googleMeetUrl",
  "visibility",
  "guestPermissions",
  "eventType",
];

/** A send that reaches people the input doesn't name:
 * - a Gmail reply goes to the original sender unless `to` replaces them (cc and
 *   bcc only add people), and reply-all reaches the whole thread;
 * - a forward with nobody listed;
 * - a Calendar update that changes what guests see: it lands on every guest's
 *   copy even with notifications off, and the input doesn't say who the guests
 *   are (a solo event asks too; color and reminder changes don't);
 * - a Calendar RSVP with a note goes to the organizer. (A plain accept or
 *   decline carries no text, so it follows the connector's mode.) */
function leavesForUnnamedPeople(connector: string, name: string, args: Record<string, unknown>, named: string[]): boolean {
  if (connector === "Gmail" && name === "reply") return args.replyAll === true || recipients({ to: args.to }).length === 0;
  if (connector === "Gmail" && name === "forward") return named.length === 0;
  if (connector === "Google Calendar" && name === "update_event") return GUEST_VISIBLE_EVENT_FIELDS.some((key) => args[key] !== undefined);
  if (connector === "Google Calendar" && name === "respond_to_event") return hasText(args.responseComment);
  return false;
}

/** Calendar's `calendarId` names whose calendar gets the event. Someone else's
 * calendar (an address, not "primary" or one of the user's own group
 * calendars) counts as a recipient. */
function calendarOwner(connector: string, args: Record<string, unknown>): string[] {
  if (connector !== "Google Calendar" || typeof args.calendarId !== "string") return [];
  const id = args.calendarId.trim().toLowerCase();
  if (!id.includes("@") || /@group(\.v)?\.calendar\.google\.com$/.test(id)) return [];
  return [id];
}

/** Classify one tool call. */
export function classify(tool: string, input: Record<string, unknown> | undefined, ctx: PolicyContext): Classified {
  const args = input ?? {};
  const mcp = parseMcpTool(tool);
  if (!mcp) {
    if (tool === "WebFetch") {
      let host = "";
      try {
        host = new URL(String(args.url)).hostname.toLowerCase();
      } catch {
        host = "";
      }
      // Never this Mac or its network: tethr's own API answers loopback requests
      // as Mark (local_trusted), so a page fetch there would read his data.
      if (!host || isPrivateHost(host)) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: "the chat can't open pages on this computer or its local network" };
      }
      return { tool, connector: null, server: null, cls: "web", summary: builtinSummary(tool, args), internalHost: isInternalHost(host, ctx.internalAddresses) };
    }
    if (SAFE_BUILTINS.has(tool)) return { tool, connector: null, server: null, cls: "builtin", summary: builtinSummary(tool, args) };
    if (READ_BUILTINS.has(tool)) {
      const target = String(args.file_path ?? args.path ?? "");
      // A Glob pattern can name its own folder ("/Users/x/**", "../**"): its fixed part counts too.
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      const patternRoot = tool === "Glob" && (/^[/~]/.test(pattern) || pattern.split("/").includes("..")) ? pattern.split(/[*?[{]/)[0] || "/" : "";
      if (patternRoot && !within(absPath(patternRoot, ctx), ctx.readableRoots)) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: "it's outside Tethr's folders (00 Tethr)" };
      }
      if (target && !within(absPath(target, ctx), ctx.readableRoots)) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: "it's outside Tethr's folders (00 Tethr)" };
      }
      return { tool, connector: null, server: null, cls: "builtin", summary: builtinSummary(tool, args) };
    }
    if (WRITE_BUILTINS.has(tool)) {
      const target = String(args.file_path ?? args.notebook_path ?? "");
      const refusal = target ? workspaceWriteRefusal(absPath(target, ctx), ctx.workspaceDir) : "Tethr only writes inside its workspace folder";
      if (refusal) {
        return { tool, connector: null, server: null, cls: "blocked", summary: builtinSummary(tool, args), blockedReason: refusal };
      }
      return { tool, connector: null, server: null, cls: "workspace", summary: builtinSummary(tool, args) };
    }
    if (tool === "Bash") return { tool, connector: null, server: null, cls: "shell", summary: `Run: ${String(args.command ?? "").slice(0, 120)}` };
    return { tool, connector: null, server: null, cls: "blocked", summary: tool, blockedReason: "that tool isn't available in Tethr's chat" };
  }

  const { server, connector, name } = mcp;
  let cls: ToolClass = READ_VERB.test(name) ? "read" : DESTRUCTIVE_VERB.test(name) ? "destructive" : "write";
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
  // Gmail sends a saved draft as it is and ignores every other field, so an
  // approval card could show recipients and text that never go out. The chat
  // sends with the recipients and text written out instead.
  if (connector === "Gmail" && name === "send_message" && hasText(args.draftId)) {
    return {
      tool,
      connector,
      server,
      cls: "blocked",
      summary: "Send a saved Gmail draft as it is",
      blockedReason: "sending a saved draft hides who it goes to and what it says; send it with to, subject and body written out so the approval shows them",
    };
  }

  // Tethr's own tools keep everything inside Tethr (a metric named "new patients
  // per month" isn't medical content going anywhere), so the outward checks skip them.
  if (cls !== "read" && cls !== "money" && connector !== "Tethr tools") {
    const outward = [...recipients(args), ...calendarOwner(connector, args)];
    if ((cls === "write" || cls === "draft") && outward.some((a) => !isInternal(a, ctx.internalAddresses))) {
      // A draft to an outsider is still only a draft; sending/inviting them is public.
      if (cls === "write") cls = "public";
    }
    // Recipients the input doesn't name could be anyone, so those sends count as
    // leaving the company.
    if (cls === "write" && leavesForUnnamedPeople(connector, name, args, outward)) cls = "public";
    if (MEDICAL.test(JSON.stringify(args))) cls = "medical";
  }
  return { tool, connector, server, cls, summary: summarize(connector, name, args) };
}

/** Is a web host one of Wandr's own (a domain from internalAddresses, or a subdomain)? */
export function isInternalHost(host: string, internal: string[]): boolean {
  return internal.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^@/, "");
    const domain = e.includes("@") ? e.slice(e.indexOf("@") + 1) : e;
    return !!domain && (host === domain || host.endsWith("." + domain));
  });
}

/** Decide what the gate does with a classified call, given the connector's mode.
 * `tainted`: this thread's session has read connector data. */
export function decide(c: Classified, opts: { mode: ConnectorMode; shell: "off" | "ask"; tainted?: boolean }): Decision {
  switch (c.cls) {
    case "builtin":
    case "workspace":
      return { action: "allow" };
    case "web":
      return opts.tainted && !c.internalHost
        ? { action: "ask", reason: `Tethr approval gate: waiting for approval in tethr (this chat has read your connected tools, so opening outside pages needs an ok) — ${c.summary}.` }
        : { action: "allow" };
    case "blocked":
      return { action: "deny", reason: `Tethr approval gate: blocked — ${c.blockedReason ?? "not allowed"}.` };
    case "shell":
      return opts.shell === "ask"
        ? { action: "ask", reason: `Tethr approval gate: shell command waiting for approval in tethr — ${c.summary}` }
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
    c.cls === "money"
      ? " (moves money)"
      : c.cls === "public"
        ? " (goes outside the company)"
        : c.cls === "medical"
          ? " (mentions medical details)"
          : c.cls === "destructive"
            ? " (deletes or overwrites)"
            : "";
  return { action: "ask", reason: `Tethr approval gate: waiting for approval in tethr${why} — ${c.summary}.` };
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
        const u = new URL(String(args.url));
        return `Opening ${u.host}${u.pathname === "/" ? "" : u.pathname.slice(0, 60)}`;
      } catch {
        return "Opening a web page";
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
