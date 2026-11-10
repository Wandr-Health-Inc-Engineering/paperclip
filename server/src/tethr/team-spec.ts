import { METRIC_SOURCES, METRIC_UNITS } from "./goals.js";
import { inferOverseerRole, OVERSEER_ROLES, type OverseerRole } from "./overseers.js";
import { validCron } from "./setup.js";

// Phase 23-24: the spec of an agent on tethr's team, and the words around it.
// No DB here: validation, the schedule in plain words, the approval card's
// text, and what an agent is told when it works a task. The service that
// creates and runs agents is team.ts.
//
// Phase 24 (tethr is the brain): an agent may be a LEAD with a small sub-team
// of its own (depth 2: tethr → lead → sub-agents), and every agent can own a
// goal (an existing one, or a new one saved when the card is approved).

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
  /** Sub-agents one lead may have. */
  subAgentsMax: 4,
  slackSummaryChars: 240,
  goalTitleChars: 120,
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

export interface TeamMetric {
  name: string;
  unit: (typeof METRIC_UNITS)[number];
  source: (typeof METRIC_SOURCES)[number];
  method: string;
  target: number;
  /** YYYY-MM-DD */
  targetDate: string;
  baseline: number | null;
  direction: "up" | "down";
}

/** The goal an agent moves: one that exists, or a new one saved on approval. */
export type TeamGoal =
  | { kind: "existing"; goalId: string; title: string }
  | { kind: "new"; title: string; description: string | null; metric: TeamMetric | null };

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
  /** May build and run a small sub-team of its own. Never true for a sub-agent. */
  lead: boolean;
  goal: TeamGoal | null;
}

export class TeamInputError extends Error {}

/** Tags that can never name a team agent (Slack words, tethr itself). */
const RESERVED_TAGS = new Set(["@tethr", "@all", "@here", "@channel", "@everyone", "@team", "@admin", "@you", "@me"]);
const TAG_RE = /^@[a-z][a-z0-9-]{1,23}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const TAG_SLUG_MAX = 23;

/** "Competitor Scout" → "@competitor-scout" (lowercase, hyphens, ≤ 24 chars). A long
 * name is cut at a word, never mid-word ("@paid-ads-keyword", not "@paid-ads-keyword-resear"). */
export function tagFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= TAG_SLUG_MAX) return `@${slug || "agent"}`;
  const cut = slug.slice(0, TAG_SLUG_MAX);
  // The next character is a hyphen: the cut already ends on a whole word.
  if (slug[TAG_SLUG_MAX] === "-") return `@${cut}`;
  const lastWordStart = cut.lastIndexOf("-");
  // One long word has nowhere better to cut.
  return `@${lastWordStart >= 2 ? cut.slice(0, lastWordStart) : cut}`;
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

function finite(value: unknown, field: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(n)) throw new TeamInputError(`${field} must be a number.`);
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

function validateMetric(raw: unknown): TeamMetric | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") throw new TeamInputError("new_goal.metric must be an object or left out.");
  const r = raw as Record<string, unknown>;
  const unit = String(r.unit ?? "count");
  if (!(METRIC_UNITS as readonly string[]).includes(unit)) throw new TeamInputError(`new_goal.metric.unit must be one of ${METRIC_UNITS.join(", ")}.`);
  const source = String(r.source ?? "manual");
  if (!(METRIC_SOURCES as readonly string[]).includes(source)) throw new TeamInputError(`new_goal.metric.source must be one of ${METRIC_SOURCES.join(", ")}.`);
  const targetDate = String(r.target_date ?? r.targetDate ?? "");
  if (!DATE_RE.test(targetDate)) throw new TeamInputError("new_goal.metric.target_date must be YYYY-MM-DD.");
  const baselineRaw = r.baseline;
  return {
    name: oneLine(text(r.name, "new_goal.metric.name", 3, TEAM_LIMITS.goalTitleChars)),
    unit: unit as TeamMetric["unit"],
    source: source as TeamMetric["source"],
    method: text(r.method, "new_goal.metric.method", 5, 600),
    target: finite(r.target, "new_goal.metric.target"),
    targetDate,
    baseline: baselineRaw === undefined || baselineRaw === null || baselineRaw === "" ? null : finite(baselineRaw, "new_goal.metric.baseline"),
    direction: r.direction === "down" ? "down" : "up",
  };
}

/** The goal an agent will move: `goal_id` (must exist) or `new_goal`. */
export function validateGoal(r: Record<string, unknown>, goals: Map<string, string>): TeamGoal | null {
  const goalId = typeof r.goal_id === "string" ? r.goal_id.trim() : "";
  if (goalId && r.new_goal) throw new TeamInputError("Give goal_id or new_goal, not both.");
  if (goalId) {
    const title = goals.get(goalId);
    if (!title) throw new TeamInputError(`There's no goal ${goalId}. Use an id from goals_list, or new_goal.`);
    return { kind: "existing", goalId, title };
  }
  if (!r.new_goal) return null;
  if (typeof r.new_goal !== "object") throw new TeamInputError("new_goal must be { title, description?, metric? }.");
  const g = r.new_goal as Record<string, unknown>;
  return {
    kind: "new",
    title: oneLine(text(g.title, "new_goal.title", 3, TEAM_LIMITS.goalTitleChars)),
    description: typeof g.description === "string" && g.description.trim() ? g.description.trim().slice(0, 1_000) : null,
    metric: validateMetric(g.metric),
  };
}

export interface SpecContext {
  /** Every tag in the company, archived agents included (a tag is never reused). */
  takenTags: Iterable<string>;
  /** Connector labels in Integrations. */
  connectors: string[];
  /** Goal id → title, for goal_id. */
  goals?: Map<string, string>;
  /** When a lead is creating this agent for its sub-team. */
  lead?: { tag: string; connectors: string[] } | null;
}

/** Check a new agent's spec. */
export function validateTeamSpec(raw: unknown, ctx: SpecContext): TeamAgentSpec {
  if (!raw || typeof raw !== "object") throw new TeamInputError("Give the agent's spec.");
  const r = raw as Record<string, unknown>;
  const name = oneLine(text(r.name, "name", 2, TEAM_LIMITS.nameChars));
  const tag = typeof r.tag === "string" && r.tag.trim() ? `@${r.tag.trim().replace(/^@+/, "").toLowerCase()}` : tagFromName(name);
  if (!TAG_RE.test(tag)) throw new TeamInputError("tag must look like @scout: lowercase letters, numbers and hyphens, 2 to 24 characters.");
  const taken = new Set([...ctx.takenTags].map((t) => t.toLowerCase()));
  if (RESERVED_TAGS.has(tag) || taken.has(tag)) throw new TeamInputError(`${tag} is already taken; pick another tag.`);
  const title = oneLine(text(r.title, "title", 2, TEAM_LIMITS.titleChars));
  const mission = oneLine(text(r.mission, "mission", 5, TEAM_LIMITS.missionChars));
  const connectors = validateConnectors(r.connectors, ctx.connectors);
  const lead = r.lead === true;
  if (ctx.lead) {
    if (lead) throw new TeamInputError("A sub-agent can't be a lead (teams go two levels deep at most).");
    const extra = connectors.filter((c) => !ctx.lead!.connectors.includes(c));
    if (extra.length) throw new TeamInputError(`A sub-agent can only use tools its lead has; ${ctx.lead.tag} doesn't have ${extra.join(", ")}.`);
  }
  return {
    name,
    tag,
    title,
    mission,
    instructions: text(r.instructions, "instructions", 20, TEAM_LIMITS.instructionsChars),
    connectors,
    schedule: validateSchedule(r.schedule),
    budgetMonthlyUsd: bounded(r.budget_usd ?? r.budgetMonthlyUsd, "budget_usd", TEAM_LIMITS.budgetDefaultUsd, 1, TEAM_LIMITS.budgetMaxUsd, false),
    maxRunsPerDay: bounded(r.max_runs_per_day ?? r.maxRunsPerDay, "max_runs_per_day", TEAM_LIMITS.runsDefault, 1, TEAM_LIMITS.runsMax, true),
    ownerRole: validateOwner(r.owner ?? r.ownerRole, `${title} ${mission}`),
    firstTask: r.first_task || r.firstTask ? validateTask(r.first_task ?? r.firstTask, "first_task") : null,
    lead,
    goal: validateGoal(r, ctx.goals ?? new Map()),
  };
}

/** A stored spec (a card's meta) back into validate's input shape, to check it again on approval. */
export function specToInput(spec: TeamAgentSpec): Record<string, unknown> {
  const goal = spec.goal;
  return {
    ...spec,
    budget_usd: spec.budgetMonthlyUsd,
    max_runs_per_day: spec.maxRunsPerDay,
    owner: spec.ownerRole,
    first_task: spec.firstTask,
    goal_id: goal?.kind === "existing" ? goal.goalId : undefined,
    new_goal:
      goal?.kind === "new"
        ? {
            title: goal.title,
            description: goal.description,
            metric: goal.metric && { ...goal.metric, target_date: goal.metric.targetDate },
          }
        : undefined,
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

/** One line for a goal: "Moves: Revenue" or "New goal: … (saved when you approve)". */
export function goalLine(goal: TeamGoal | null, opts: { pending?: boolean } = {}): string | null {
  if (!goal) return null;
  if (goal.kind === "existing") return `Moves: ${goal.title}`;
  const m = goal.metric;
  const metric = m ? `, measured as ${m.name}: ${m.baseline ?? "?"} → ${m.target} by ${m.targetDate}` : "";
  return `New goal: ${goal.title}${metric}${opts.pending === false ? "" : " (saved when you approve)"}`;
}

/** The approval card's body: everything the agent will be, in plain text. */
export function teamSpecText(spec: TeamAgentSpec, opts: { ownerName?: string; timezone?: string; why?: string; leadTag?: string | null } = {}): string {
  const boss = opts.leadTag ?? "tethr";
  const lines = [
    `${spec.name} (${spec.tag}): ${spec.title}`,
    `Mission: ${spec.mission}`,
    ...(spec.goal ? [goalLine(spec.goal)!] : []),
    `Runs: ${spec.schedule ? `${scheduleWords(spec.schedule.cron, opts.timezone)}, and when ${boss} assigns it work` : `only when ${boss} assigns it work`}`,
    `Limits: up to ${spec.maxRunsPerDay} runs a day, $${spec.budgetMonthlyUsd} a month (hard stop)`,
    `Tools: web search and its files${spec.connectors.length ? `, plus ${spec.connectors.join(", ")}` : ""}. Anything it would send, post, spend or delete still asks first.`,
    opts.leadTag
      ? `Part of ${opts.leadTag}'s team: it reports to ${opts.leadTag}, which reports to tethr.`
      : `Reports to: ${opts.ownerName ? `${opts.ownerName} (${spec.ownerRole})` : spec.ownerRole} on Slack, and to the main chat`,
  ];
  if (spec.lead) lines.push(`Lead: it can build and run a small sub-team of its own (up to ${TEAM_LIMITS.subAgentsMax} agents); each one is a card like this.`);
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
  lead?: boolean;
  leadTag?: string | null;
  goalTitle?: string | null;
  subTeam?: string[];
}

/** Who an agent is, at the top of a fresh session or a task. */
export function agentIdentityText(agent: AgentIdentity): string {
  const boss = agent.leadTag ?? "tethr";
  const lines = [
    `[You are ${agent.name} (${agent.tag}), on tethr's team: ${agent.title}. ${agent.mission}]`,
    agent.leadTag
      ? `You're on ${agent.leadTag}'s sub-team: you work for ${agent.leadTag} and report back to it. You can't create agents or hand work to other agents.`
      : agent.lead
        ? "You lead a small sub-team for tethr, the team's lead, and report back to tethr. You can create sub-agents for parts of your job (create_agent; each needs the person's approval unless agents are set to Automatic), hand them tasks (assign_task) and change them (update_agent). Split bigger work into tasks for them; when their reports are in, you write the combined report."
        : "You work for tethr, the team's lead, and report back to it. You can't create agents or hand work to other agents.",
    `The person may also talk to you directly in this chat. Your reports go to ${boss}.`,
    `Tools you may use: web search and your files${agent.connectors.length ? `, plus ${agent.connectors.join(", ")}` : ""}.`,
  ];
  lines.push(
    "When you need a decision or a fact from a person before you can go on, call the ask tool: it shows them a card with buttons and tells them it's waiting. Ask once, then finish with what you can do without the answer. Don't bury the question in your report, and don't ask it again on later runs.",
  );
  if (agent.goalTitle) lines.push(`Your goal: ${agent.goalTitle}. Say how your work moves it.`);
  if (agent.lead && agent.subTeam?.length) lines.push(`Your sub-team: ${agent.subTeam.join(", ")}.`);
  lines.push("", "Your instructions:", agent.instructions);
  return lines.join("\n");
}

const REPORT_ENDING = [
  'When you\'re done: put any file you make in files/, then, under a line that says "Report:", write a short report (what you did, what you found with the numbers, what you\'d do next).',
  `End with one line that starts "Slack summary:" and says the result in a sentence, with no customer names, emails or health details. It's the only part that goes to Slack.`,
];

/** The system turn an agent gets for a task. */
export function agentTaskText(agent: AgentIdentity, task: { identifier?: string | null; title: string; brief: string | null }): string {
  const delegate = agent.lead
    ? ["", "If parts of this suit your sub-team, hand them out with assign_task (they become sub-tasks of this one) and say what you handed out; you'll be woken to write the combined report when they're done. Otherwise do it yourself."]
    : [];
  return [
    `Task${task.identifier ? ` ${task.identifier}` : ""}: ${task.title}`,
    "",
    agentIdentityText(agent),
    "",
    "The task:",
    task.brief?.trim() || task.title,
    ...delegate,
    "",
    ...REPORT_ENDING,
  ].join("\n");
}

export interface ChildResult {
  identifier: string | null;
  title: string;
  assigneeTag: string | null;
  status: string;
  lastComment: string | null;
}

/** The system turn that wakes a lead when its sub-team has finished a task's sub-tasks. */
export function agentRollupText(agent: AgentIdentity, task: { identifier?: string | null; title: string }, children: ChildResult[]): string {
  const results = children.map(
    (c) => `- ${c.identifier ? `${c.identifier} ` : ""}${c.title} (${c.assigneeTag ?? "unassigned"}, ${c.status}): ${(c.lastComment ?? "no result").slice(0, 1_500)}`,
  );
  return [
    `Roll-up${task.identifier ? ` ${task.identifier}` : ""}: ${task.title}`,
    "",
    agentIdentityText(agent),
    "",
    "Your sub-team has finished the sub-tasks of this task:",
    ...results,
    "",
    "Put it together: check what came back, fill any gap yourself, and decide what's next. Don't hand out more sub-tasks for this task unless something essential is missing.",
    "",
    ...REPORT_ENDING,
  ].join("\n");
}

const SLACK_SUMMARY_RE = /^\s*\**slack summary:?\**:?\s*(.+)$/im;
/** A line that's only "Report:" (or "**Report**", "## Report"): the report starts after it. */
const REPORT_HEADING_RE = /^\s*(?:#{1,3}\s*)?\**report:?\**:?\s*$/gim;

/** Pull the agent's "Slack summary:" line out of its report. */
export function splitSlackSummary(text: string): { body: string; summary: string | null } {
  const match = text.match(SLACK_SUMMARY_RE);
  if (!match) return { body: text.trim(), summary: null };
  const summary = oneLine(match[1]!.replace(/\*+$/, "")).slice(0, TEAM_LIMITS.slackSummaryChars) || null;
  const body = text.replace(match[0], "").trim();
  return { body, summary };
}

/** Did the agent write a report (a "Report:" line)? */
export function hasReportHeading(text: string): boolean {
  return [...text.matchAll(REPORT_HEADING_RE)].length > 0;
}

/** The system turn that wakes a lead when one of its sub-agents reports on its
 * own (a first task or a scheduled run, not a sub-task the lead handed out). */
export function leadNudgeText(report: { tag: string; title: string; identifier?: string | null; summary: string | null }): string {
  return [
    `Report from ${report.tag}: ${report.identifier ? `${report.identifier} ` : ""}${report.title}`,
    `[Brief] ${report.tag} on your sub-team just reported${report.summary ? ` (${report.summary})` : ""}; the full report is in your notes and as a card in this chat.`,
    "Decide what's next: hand your sub-team follow-up work (assign_task), adjust one (update_agent), or do a piece yourself.",
    'If you now have something tethr should know, write it under a line that says "Report:" and end with a "Slack summary:" line; it goes to tethr. If not, just say in a line what happens next, and nothing goes to tethr.',
  ].join("\n");
}

/** The report an agent wrote, without the working notes it streamed before it
 * ("I'll look at…"): everything after its last "Report:" line, else all of it. */
export function reportBody(text: string): string {
  let start = -1;
  for (const m of text.matchAll(REPORT_HEADING_RE)) start = (m.index ?? 0) + m[0].length;
  const body = start >= 0 ? text.slice(start).trim() : text.trim();
  return body || text.trim();
}

// ---- what an agent may not touch -------------------------------------------------

/** The team tools: tethr's (main and side chats), and a lead's for its own sub-team. */
export const TEAM_TOOL_NAMES = ["team_list", "create_agent", "assign_task", "update_agent"] as const;

/** Phase 27: tethr tools every agent on the team has, whatever its connectors:
 * they're how it reaches a person (a question as a card, a connection it's missing). */
export const AGENT_ALWAYS_TOOLS = ["ask"] as const;
const isAlwaysTool = (name: string) => (AGENT_ALWAYS_TOOLS as readonly string[]).includes(name);

/** Claude Code's MCP server name for an Integrations connector label. */
export function connectorServer(label: string): string {
  return label === "Tethr tools" ? "tethr" : `claude_ai_${label.replace(/ /g, "_")}`;
}

/**
 * Per-turn deny rules for an agent's turn: every connector outside its
 * allowlist, the team tools (unless it's a lead), and the shell. Every agent
 * keeps the tethr server for the tools that reach a person (AGENT_ALWAYS_TOOLS),
 * so one without "Tethr tools" has the other Tethr tools (`otherTethrTools`)
 * denied one by one. The hook enforces the same.
 */
export function agentDenyRules(allowed: string[], labels: string[], opts: { lead?: boolean; otherTethrTools?: string[] } = {}): string[] {
  const hasTethrTools = allowed.includes("Tethr tools");
  const rules = labels.filter((label) => label !== "Tethr tools" && !allowed.includes(label)).map((label) => `mcp__${connectorServer(label)}`);
  if (!hasTethrTools) {
    // Without the list of the other tools there's no way to deny them one by one: deny the whole server.
    if (opts.otherTethrTools) rules.push(...opts.otherTethrTools.filter((name) => !isAlwaysTool(name)).map((name) => `mcp__tethr__${name}`));
    else rules.push("mcp__tethr");
  }
  if (!opts.lead) rules.push(...TEAM_TOOL_NAMES.map((name) => `mcp__tethr__${name}`));
  rules.push("Bash");
  return rules;
}

/** Why the gate refuses an agent this call, or null. Mirrors agentDenyRules. */
export function agentToolRefusal(agent: { tag: string; connectors: string[]; lead?: boolean }, toolName: string, connector: string | null): string | null {
  if (toolName === "Bash") return `Tethr approval gate: blocked. ${agent.tag} can't use the shell.`;
  const teamTool = TEAM_TOOL_NAMES.find((name) => toolName === `mcp__tethr__${name}`);
  if (teamTool) {
    return agent.lead
      ? null
      : `Tethr approval gate: blocked. Only tethr and team leads create agents or hand out work; ${agent.tag} can't use ${teamTool}.`;
  }
  if (AGENT_ALWAYS_TOOLS.some((name) => toolName === `mcp__tethr__${name}`)) return null;
  if (connector && !agent.connectors.includes(connector)) {
    return `Tethr approval gate: blocked. ${agent.tag} isn't set up to use ${connector}. If the job needs it, say so in your report so it can be added.`;
  }
  return null;
}

/** The system turn behind "Propose a starting team" (main chat). Its first line is what the chat shows. */
export function teamProposalBrief(person?: string | null): string {
  const who = person?.trim() || "the person you're working with";
  return `Propose a starting team
[Brief for tethr] ${who} wants you to propose a starting team of agents. Call team_list and goals_list, and look at the Memory section of CLAUDE.md and the recent work in this chat and files/.
Then propose two or three agents that would move the goals most, one create_agent call each, each with the goal it moves. Make them distinct: no overlap with each other, and nothing you already do well in this chat. For each, give clear instructions (what to look at, what to deliver, where in files/ to put it), only the connectors it needs, a schedule if the work repeats, and a first task if there's an obvious one. Keep budgets modest.
After the calls, explain each in plain words: what it would do, how often, what it delivers, which goal it moves, and why it's worth having. If agents need approval, say they're waiting as cards. Don't assign other tasks yet.`;
}
