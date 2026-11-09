import { inferOverseerRole, OVERSEER_ROLES, type OverseerRole } from "./overseers.js";
import { validCron } from "./setup.js";

// Phase 23: the spec of an agent on tethr's team, and the words around it.
// Pure (no DB): validation, the schedule in plain words, the approval card's
// text, and what an agent is told when it works a task. The service that
// creates and runs agents is team.ts.

export const TEAM_LIMITS = {
  nameChars: 40,
  titleChars: 80,
  missionChars: 300,
  instructionsChars: 4_000,
  briefChars: 4_000,
  taskTitleChars: 160,
  connectors: 8,
  budgetDefaultUsd: 15,
  budgetMaxUsd: 50,
  runsDefault: 4,
  runsMax: 12,
  /** Open tasks one agent may hold at once. */
  openTasksMax: 3,
  slackSummaryChars: 240,
} as const;

export interface TeamSchedule {
  /** Five-field cron, in the setup time zone. At most hourly. */
  cron: string;
  /** What each scheduled run should do (it becomes the task's brief). */
  brief: string;
}

export interface TeamTask {
  title: string;
  brief: string;
}

export interface TeamAgentSpec {
  name: string;
  tag: string;
  title: string;
  mission: string;
  instructions: string;
  /** Integrations connector labels it may use ("Gmail", "Stripe", "Tethr tools"…). */
  connectors: string[];
  schedule: TeamSchedule | null;
  budgetMonthlyUsd: number;
  maxRunsPerDay: number;
  /** Who it reports to on Slack: the roster person for this role. */
  ownerRole: OverseerRole;
  firstTask: TeamTask | null;
}

export class TeamInputError extends Error {}

/** Tags that can never name a team agent (Slack words, tethr itself). */
const RESERVED_TAGS = new Set(["@tethr", "@all", "@here", "@channel", "@everyone", "@team", "@admin", "@you", "@me"]);
const TAG_RE = /^@[a-z][a-z0-9-]{1,23}$/;

/** "Competitor Scout" → "@competitor-scout" (lowercase, hyphens, ≤ 24 chars). */
export function tagFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 23)
    .replace(/-+$/g, "");
  return `@${slug || "agent"}`;
}

function text(value: unknown, field: string, min: number, max: number): string {
  const v = typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
  if (v.length < min) throw new TeamInputError(`${field} is required${min > 1 ? ` (at least ${min} characters)` : ""}.`);
  if (v.length > max) throw new TeamInputError(`${field} is too long (at most ${max} characters).`);
  return v;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bounded(value: unknown, field: string, fallback: number, min: number, max: number, integer: boolean): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new TeamInputError(`${field} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new TeamInputError(`${field} must be a whole number.`);
  if (n < min || n > max) throw new TeamInputError(`${field} must be between ${min} and ${max}.`);
  return n;
}

/** A cron tethr may schedule: valid, and at most hourly (the minute is a plain number). */
export function validTeamCron(cron: unknown): cron is string {
  if (!validCron(cron)) return false;
  return /^\d{1,2}$/.test(cron.trim().split(/\s+/)[0]!);
}

export function validateSchedule(raw: unknown): TeamSchedule | null {
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== "object") throw new TeamInputError("schedule must be { cron, brief } or left out.");
  const r = raw as Record<string, unknown>;
  const cron = typeof r.cron === "string" ? oneLine(r.cron) : "";
  if (!validTeamCron(cron)) {
    throw new TeamInputError('schedule.cron must be a five-field cron that runs at most hourly, e.g. "0 9 * * 1" for Mondays at 9:00.');
  }
  return { cron, brief: text(r.brief, "schedule.brief", 10, TEAM_LIMITS.briefChars) };
}

export function validateTask(raw: unknown, field = "task"): TeamTask {
  if (!raw || typeof raw !== "object") throw new TeamInputError(`${field} must be { title, brief }.`);
  const r = raw as Record<string, unknown>;
  return {
    title: oneLine(text(r.title, `${field}.title`, 3, TEAM_LIMITS.taskTitleChars)),
    brief: text(r.brief, `${field}.brief`, 10, TEAM_LIMITS.briefChars),
  };
}

/** Match connector names to the Integrations labels, case-insensitively. */
export function validateConnectors(raw: unknown, known: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TeamInputError("connectors must be a list of connector names.");
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : "";
    const label = known.find((k) => k.toLowerCase() === name.toLowerCase());
    if (!label) throw new TeamInputError(`Unknown connector "${name}". Use names from Integrations: ${known.join(", ")}.`);
    if (!out.includes(label)) out.push(label);
  }
  if (out.length > TEAM_LIMITS.connectors) throw new TeamInputError(`At most ${TEAM_LIMITS.connectors} connectors.`);
  return out;
}

export function validateOwner(raw: unknown, fallbackText: string): OverseerRole {
  if (raw === undefined || raw === null || raw === "") return inferOverseerRole(fallbackText);
  const role = String(raw).trim().toLowerCase();
  if (!(OVERSEER_ROLES as readonly string[]).includes(role)) throw new TeamInputError(`owner must be one of ${OVERSEER_ROLES.join(", ")}.`);
  return role as OverseerRole;
}

/** Check a new agent's spec. `takenTags` = every tag in the company, archived ones included. */
export function validateTeamSpec(raw: unknown, ctx: { takenTags: Iterable<string>; connectors: string[] }): TeamAgentSpec {
  if (!raw || typeof raw !== "object") throw new TeamInputError("Give the agent's spec.");
  const r = raw as Record<string, unknown>;
  const name = oneLine(text(r.name, "name", 2, TEAM_LIMITS.nameChars));
  const tag = typeof r.tag === "string" && r.tag.trim() ? `@${r.tag.trim().replace(/^@+/, "").toLowerCase()}` : tagFromName(name);
  if (!TAG_RE.test(tag)) throw new TeamInputError("tag must look like @scout: lowercase letters, numbers and hyphens, 2 to 24 characters.");
  const taken = new Set([...ctx.takenTags].map((t) => t.toLowerCase()));
  if (RESERVED_TAGS.has(tag) || taken.has(tag)) throw new TeamInputError(`${tag} is already taken; pick another tag.`);
  const title = oneLine(text(r.title, "title", 2, TEAM_LIMITS.titleChars));
  const mission = oneLine(text(r.mission, "mission", 5, TEAM_LIMITS.missionChars));
  return {
    name,
    tag,
    title,
    mission,
    instructions: text(r.instructions, "instructions", 20, TEAM_LIMITS.instructionsChars),
    connectors: validateConnectors(r.connectors, ctx.connectors),
    schedule: validateSchedule(r.schedule),
    budgetMonthlyUsd: bounded(r.budget_usd ?? r.budgetMonthlyUsd, "budget_usd", TEAM_LIMITS.budgetDefaultUsd, 1, TEAM_LIMITS.budgetMaxUsd, false),
    maxRunsPerDay: bounded(r.max_runs_per_day ?? r.maxRunsPerDay, "max_runs_per_day", TEAM_LIMITS.runsDefault, 1, TEAM_LIMITS.runsMax, true),
    ownerRole: validateOwner(r.owner ?? r.ownerRole, `${title} ${mission}`),
    firstTask: r.first_task || r.firstTask ? validateTask(r.first_task ?? r.firstTask, "first_task") : null,
  };
}

// ---- the schedule in words ------------------------------------------------------

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}`;
}

function listWords(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "0 9 * * 1" → "every Monday at 9:00 am". Unusual crons come back as themselves. */
export function scheduleWords(cron: string, timezone?: string): string {
  const parts = cron.trim().split(/\s+/);
  const zone = timezone ? ` (${timezone})` : "";
  if (parts.length !== 5) return `on the schedule "${cron}"${zone}`;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minute = Number(m);
  if (!/^\d+$/.test(m) || mon !== "*") return `on the schedule "${cron}"${zone}`;
  if (h === "*" && dom === "*" && dow === "*") return `every hour at :${String(minute).padStart(2, "0")}${zone}`;
  if (!/^\d+$/.test(h)) return `on the schedule "${cron}"${zone}`;
  const at = `at ${clock(Number(h), minute)}${zone}`;
  if (dom === "*" && dow === "*") return `every day ${at}`;
  if (dom === "*" && (dow === "1-5" || dow === "MON-FRI")) return `weekdays ${at}`;
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) {
    const days = dow.split(",").map((d) => DAY_NAMES[Number(d) % 7]!);
    return `every ${listWords(days)} ${at}`;
  }
  if (/^\d+$/.test(dom) && dow === "*") return `on day ${dom} of each month ${at}`;
  return `on the schedule "${cron}"${zone}`;
}

// ---- what people and agents read ------------------------------------------------

/** The approval card's body: everything the agent will be, in plain text. */
export function teamSpecText(spec: TeamAgentSpec, opts: { ownerName?: string; timezone?: string; why?: string } = {}): string {
  const lines = [
    `${spec.name} (${spec.tag}): ${spec.title}`,
    `Mission: ${spec.mission}`,
    `Runs: ${spec.schedule ? `${scheduleWords(spec.schedule.cron, opts.timezone)}, and when tethr assigns it work` : "only when tethr assigns it work"}`,
    `Limits: up to ${spec.maxRunsPerDay} runs a day, $${spec.budgetMonthlyUsd} a month (hard stop)`,
    `Tools: ${spec.connectors.length ? spec.connectors.join(", ") : "none beyond reading and writing its files"}. Anything it would send, post, spend or delete still asks first.`,
    `Reports to: ${opts.ownerName ? `${opts.ownerName} (${spec.ownerRole})` : spec.ownerRole} on Slack, and to the main chat`,
  ];
  if (spec.schedule) lines.push("", "Each scheduled run:", spec.schedule.brief);
  if (spec.firstTask) lines.push("", `First task: ${spec.firstTask.title}`, spec.firstTask.brief);
  lines.push("", "Instructions:", spec.instructions);
  if (opts.why?.trim()) lines.push("", `Why: ${opts.why.trim()}`);
  return lines.join("\n");
}

export interface AgentIdentity {
  tag: string;
  name: string;
  title: string;
  mission: string;
  instructions: string;
  connectors: string[];
}

/** Who an agent is, at the top of a fresh session or a task. */
export function agentIdentityText(agent: AgentIdentity): string {
  return [
    `[You are ${agent.name} (${agent.tag}), on tethr's team: ${agent.title}. ${agent.mission}]`,
    "You work for tethr, the team's lead, and report back to it; the person may also talk to you directly in this chat. You can't create agents or hand work to other agents.",
    `Tools you may use: ${agent.connectors.length ? agent.connectors.join(", ") : "only reading and writing files"}.`,
    "",
    "Your instructions:",
    agent.instructions,
  ].join("\n");
}

/** The system turn an agent gets for a task. */
export function agentTaskText(agent: AgentIdentity, task: { identifier?: string | null; title: string; brief: string | null }): string {
  return [
    `Task${task.identifier ? ` ${task.identifier}` : ""}: ${task.title}`,
    "",
    agentIdentityText(agent),
    "",
    "The task:",
    task.brief?.trim() || task.title,
    "",
    "When you're done: put any file you make in files/, then write a short report (what you did, what you found with the numbers, what you'd do next).",
    `End with one line that starts "Slack summary:" and says the result in a sentence, with no customer names, emails or health details. It's the only part that goes to Slack.`,
  ].join("\n");
}

const SLACK_SUMMARY_RE = /^\s*\**slack summary:?\**:?\s*(.+)$/im;

/** Pull the agent's "Slack summary:" line out of its report. */
export function splitSlackSummary(text: string): { body: string; summary: string | null } {
  const match = text.match(SLACK_SUMMARY_RE);
  if (!match) return { body: text.trim(), summary: null };
  const summary = oneLine(match[1]!.replace(/\*+$/, "")).slice(0, TEAM_LIMITS.slackSummaryChars) || null;
  const body = text.replace(match[0], "").trim();
  return { body, summary };
}

// ---- what an agent may not touch -------------------------------------------------

/** tethr's own team tools: only tethr (the main and side chats) may use them. */
export const TEAM_TOOL_NAMES = ["team_list", "create_agent", "assign_task", "update_agent"] as const;

/** Claude Code's MCP server name for an Integrations connector label. */
export function connectorServer(label: string): string {
  return label === "Tethr tools" ? "tethr" : `claude_ai_${label.replace(/ /g, "_")}`;
}

/** Per-turn deny rules for an agent's turn: every connector outside its
 * allowlist, tethr's team tools, and the shell. (The hook enforces the same.) */
export function agentDenyRules(allowed: string[], labels: string[]): string[] {
  const rules = labels.filter((label) => !allowed.includes(label)).map((label) => `mcp__${connectorServer(label)}`);
  if (allowed.includes("Tethr tools")) rules.push(...TEAM_TOOL_NAMES.map((name) => `mcp__tethr__${name}`));
  rules.push("Bash");
  return rules;
}

/** Why the gate refuses an agent this call, or null. Mirrors agentDenyRules. */
export function agentToolRefusal(agent: { tag: string; connectors: string[] }, toolName: string, connector: string | null): string | null {
  if (toolName === "Bash") return `Tethr approval gate: blocked. ${agent.tag} can't use the shell.`;
  const teamTool = TEAM_TOOL_NAMES.find((name) => toolName === `mcp__tethr__${name}`);
  if (teamTool) return `Tethr approval gate: blocked. Only tethr creates agents or hands out work; ${agent.tag} can't use ${teamTool}.`;
  if (connector && !agent.connectors.includes(connector)) {
    return `Tethr approval gate: blocked. ${agent.tag} isn't set up to use ${connector}. If the job needs it, say so in your report so tethr can add it.`;
  }
  return null;
}

/** The system turn behind "Propose a starting team" (main chat). Its first line is what the chat shows. */
export function teamProposalBrief(person?: string | null): string {
  const who = person?.trim() || "the person you're working with";
  return `Propose a starting team
[Brief for tethr] ${who} wants you to propose a starting team of agents. Call team_list and goals_list, and look at Memory.md and the recent work in this chat and files/.
Then propose two or three agents that would move the goals most, one create_agent call each. Make them distinct: no overlap with each other, and nothing you already do well in this chat. For each, give clear instructions (what to look at, what to deliver, where in files/ to put it), only the connectors it needs, a schedule if the work repeats, and a first task if there's an obvious one. Keep budgets modest.
After the calls, explain each in plain words: what it would do, how often, what it delivers, which goal it moves, and why it's worth having. If agents need approval, say they're waiting as cards. Don't assign other tasks yet.`;
}
