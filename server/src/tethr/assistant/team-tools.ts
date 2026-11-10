import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs } from "@paperclipai/db";
import { gatingService } from "../gating.js";
import { goalsService } from "../goals.js";
import { getIntegrations } from "../integrations.js";
import { orgService } from "../org.js";
import { getRoster } from "../overseers.js";
import { getSetup } from "../setup.js";
import { announceNewAgent } from "../team-report.js";
import { taskIssueForRun } from "../team-run.js";
import {
  goalLine,
  scheduleWords,
  TEAM_LIMITS,
  TeamInputError,
  teamSpecText,
  validateTask,
  validateTeamSpec,
  type TeamAgentSpec,
} from "../team-spec.js";
import { describePatch, raisesLimits, teamConnectorLabels, teamService, validateTeamPatch, type TeamAgent, type TeamPatch } from "../team.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// Phase 23-24: the tools for running tethr's team, on the "tethr" MCP server.
// - tethr (the main chat and side chats) runs the whole team.
// - A LEAD runs only its own sub-team, from its own chat: its team_list shows
//   it and its sub-agents, create_agent makes a sub-agent under it, assign_task
//   hands work to its sub-agents (a sub-task of the task it's working), and
//   update_agent changes only them.
// - Any other agent is refused (deny rules, the gate and the tools endpoint).
// New agents and changes follow Integrations → Team ("Ask me" = an approval
// card that buzzes the person, "Automatic" = within the team's limits); a raise
// in budget or runs always asks; pausing never does.

const GOAL_PROPS = {
  goal_id: { type: "string", description: "The goal it moves, from goals_list." },
  new_goal: {
    type: "object",
    description: "Or a new goal it will own, saved when the agent is approved. Use it when the effort is new (e.g. a paid ads channel).",
    properties: {
      title: { type: "string", description: 'e.g. "Paid acquisition".' },
      description: { type: "string" },
      metric: {
        type: "object",
        description: "Optional. How it's measured: the same fields as save_metric.",
        properties: {
          name: { type: "string" },
          unit: { type: "string", enum: ["count", "usd", "percent", "number"] },
          source: { type: "string", enum: ["stripe", "posthog", "google_ads", "manual", "other"] },
          method: { type: "string" },
          baseline: { type: "number" },
          target: { type: "number" },
          target_date: { type: "string", description: "YYYY-MM-DD" },
          direction: { type: "string", enum: ["up", "down"] },
        },
        required: ["name", "method", "target", "target_date"],
      },
    },
    required: ["title"],
  },
} as const;

export const TEAM_TOOL_DEFS: McpToolDef[] = [
  {
    name: "team_list",
    description:
      "Your team of agents: each one's tag, job, goal, status, schedule, owner, runs used today, open tasks and spend, with sub-teams under their leads, plus the team's limits and whether new agents need approval. Check it before creating or assigning. (A lead sees itself and its sub-team.)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_agent",
    description:
      "Add an agent to the team: one clear job that repeats or needs its own focus. When you recommend an ongoing effort, use this instead of leaving it as advice: e.g. if paid ads look worth trying, propose a lead (lead: true) that owns a new paid-acquisition goal, runs on a schedule, and whose first task is to set up its sub-team (one agent for keywords, one for strategy). It gets its own chat, works the tasks it's given and its schedule, and reports back. Depending on the team setting it's created right away or shown to the person as an approval card under your reply. Never create a duplicate of an agent in team_list. From a lead's chat, this makes a sub-agent on its own team.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'A short name, e.g. "Paid Ads".' },
        tag: { type: "string", description: "Optional @tag (lowercase, hyphens). Defaults from the name." },
        title: { type: "string", description: 'Its job title, e.g. "Paid acquisition lead".' },
        mission: { type: "string", description: "One sentence: what it's for and which goal it moves." },
        instructions: {
          type: "string",
          description: "How to do the job: what to look at, how, what to deliver (and where in files/), what good looks like, what to avoid. Written to the agent.",
        },
        lead: {
          type: "boolean",
          description: `true = it can build and run a small sub-team of its own (up to ${TEAM_LIMITS.subAgentsMax} agents). For bigger efforts. Sub-agents can't be leads.`,
        },
        ...GOAL_PROPS,
        connectors: {
          type: "array",
          items: { type: "string" },
          description:
            'The connectors it may use, by their Integrations names (e.g. "Google Drive", "Stripe", "Tethr tools"). Only what the job needs. A sub-agent gets a subset of its lead\'s.',
        },
        schedule: {
          type: "object",
          description: "Optional. When it runs on its own (setup's time zone), at most hourly.",
          properties: {
            cron: { type: "string", description: 'Five-field cron, e.g. "0 9 * * 1" = Mondays at 9:00.' },
            brief: { type: "string", description: "What each scheduled run should do and deliver." },
          },
          required: ["cron", "brief"],
        },
        budget_usd: { type: "number", description: `Monthly spend cap in dollars (default ${TEAM_LIMITS.budgetDefaultUsd}, at most ${TEAM_LIMITS.budgetMaxUsd}).` },
        max_runs_per_day: { type: "number", description: `Most runs a day (default ${TEAM_LIMITS.runsDefault}, at most ${TEAM_LIMITS.runsMax}).` },
        owner: { type: "string", enum: ["tech", "exec", "growth"], description: "Whose Slack it reports to (the person in that role). Inferred if left out." },
        first_task: {
          type: "object",
          description: "Optional. A task to start as soon as it exists (for a lead: often 'set up your sub-team').",
          properties: { title: { type: "string" }, brief: { type: "string" } },
          required: ["title", "brief"],
        },
        why: { type: "string", description: "Why the team needs it, in a sentence or two. Shown on the approval card." },
      },
      required: ["name", "title", "mission", "instructions"],
    },
  },
  {
    name: "assign_task",
    description:
      "Hand one task to an agent on the team. It starts right away in the agent's own chat, and its report comes back to you. Use it for one-off or parallel work that fits an agent's job; keep going meanwhile. From a lead's chat: hand work to your own sub-agents (it becomes a sub-task of the task you're on, and you'll be woken to roll up when they're done).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's @tag." },
        title: { type: "string", description: "The task in a few words." },
        brief: { type: "string", description: "What to do, what to deliver, and anything it needs to know." },
      },
      required: ["agent", "title", "brief"],
    },
  },
  {
    name: "update_agent",
    description:
      "Change an agent on the team: pause or resume it, or change its title, mission, instructions, connectors, schedule (null removes it), budget, runs a day or owner. Pausing happens at once. Other changes follow the team setting; raising its budget or runs always asks the person. A lead can change only its own sub-agents.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent's @tag." },
        pause: { type: "boolean", description: "true pauses it now; false resumes it." },
        title: { type: "string" },
        mission: { type: "string" },
        instructions: { type: "string" },
        connectors: { type: "array", items: { type: "string" } },
        schedule: { type: ["object", "null"], properties: { cron: { type: "string" }, brief: { type: "string" } } },
        budget_usd: { type: "number" },
        max_runs_per_day: { type: "number" },
        owner: { type: "string", enum: ["tech", "exec", "growth"] },
        why: { type: "string", description: "Why, in a sentence. Shown on the approval card." },
      },
      required: ["agent"],
    },
  },
];

export const TEAM_TOOL_SET = new Set(TEAM_TOOL_DEFS.map((d) => d.name));

/** The agent kinds an approval card can carry. */
export const TEAM_AGENT_KIND = "team_agent" as const;
export const TEAM_CHANGE_KIND = "team_change" as const;

/** Who is calling: tethr (whole team) or a lead (its own sub-team). */
type Caller = { kind: "tethr" } | { kind: "lead"; agent: TeamAgent };

type Scoped = TethrToolContext & { companyId: string; db: Db };

function ownerName(companyId: string, role: TeamAgent["ownerRole"]): string | undefined {
  return getRoster(companyId)[role]?.name || undefined;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

async function callerOf(ctx: Scoped): Promise<Caller | { kind: "refused"; text: string }> {
  if (!ctx.threadId) return { kind: "tethr" };
  const member = await teamService(ctx.db).byThread(ctx.companyId, ctx.threadId);
  if (!member) return { kind: "tethr" };
  if (!member.lead) return { kind: "refused", text: `Only tethr and team leads create agents or hand out work; ${member.tag} isn't a lead.` };
  return { kind: "lead", agent: member };
}

/** The agents a caller may manage. */
function manageable(caller: Caller, agents: TeamAgent[]): TeamAgent[] {
  return caller.kind === "tethr" ? agents : agents.filter((a) => a.leadTag === caller.agent.tag);
}

async function goalTitles(db: Db, companyId: string): Promise<Map<string, string>> {
  const { goals } = await goalsService(db).list(companyId);
  return new Map(goals.map((g) => [g.id, g.title]));
}

async function teamList(ctx: Scoped, caller: Caller): Promise<TethrToolResult> {
  const team = teamService(ctx.db);
  const all = await team.list(ctx.companyId);
  const settings = getIntegrations(ctx.companyId).team;
  const tz = getSetup(ctx.companyId).timezone;
  const describe = async (a: TeamAgent, indent: string) => {
    const [runs, open] = await Promise.all([team.runsToday(a.agentId), team.openTasks(a.agentId)]);
    const reports = a.leadTag ?? `${ownerName(ctx.companyId, a.ownerRole) ?? a.ownerRole} (${a.ownerRole})`;
    return [
      `${indent}- ${a.tag} · ${a.name} · ${a.title}${a.lead ? " · lead" : ""} · ${a.paused ? "paused" : "active"} · ${a.schedule ? scheduleWords(a.schedule.cron, tz) : "on assignment only"}`,
      `${indent}  Mission: ${a.mission}${a.goalTitle ? ` · Goal: ${a.goalTitle}` : ""}`,
      `${indent}  Tools: ${a.connectors.join(", ") || "web search and files only"} · reports to ${reports}`,
      `${indent}  Today: ${runs} of ${a.maxRunsPerDay} runs · open tasks: ${open} of ${TEAM_LIMITS.openTasksMax} · spend: ${dollars(a.spentMonthlyCents)} of ${dollars(a.budgetMonthlyCents)} this month`,
    ];
  };
  if (caller.kind === "lead") {
    const subs = all.filter((a) => a.leadTag === caller.agent.tag);
    const lines = [`Your sub-team: ${subs.length} of ${TEAM_LIMITS.subAgentsMax}. New agents: ${settings.newAgents === "auto" ? "automatic (within the team's limits)" : "need the person's approval"}.`];
    lines.push(...(await describe(caller.agent, "")));
    for (const s of subs) lines.push(...(await describe(s, "  ")));
    if (!subs.length) lines.push("  (No sub-agents yet.)");
    return { text: lines.join("\n") };
  }
  const active = all.filter((a) => !a.paused);
  const header = `Your team: ${active.length} active, ${all.length - active.length} paused. Limits: ${settings.maxAgents} active agents, $${settings.monthlyBudgetUsd} a month together. New agents: ${settings.newAgents === "auto" ? "automatic (within the limits)" : "need the person's approval"}.`;
  if (!all.length) return { text: `${header}\nNo agents yet.` };
  const lines = [header];
  for (const a of all.filter((x) => !x.leadTag)) {
    lines.push(...(await describe(a, "")));
    for (const s of all.filter((x) => x.leadTag === a.tag)) lines.push(...(await describe(s, "  ")));
  }
  return { text: lines.join("\n") };
}

/** A card for this tag already waiting on the person? */
async function pendingCardFor(db: Db, companyId: string, kind: string, tag: string): Promise<boolean> {
  const rows = await db
    .select({ id: tethrOutputs.id })
    .from(tethrOutputs)
    .where(
      and(
        eq(tethrOutputs.companyId, companyId),
        eq(tethrOutputs.kind, kind),
        eq(tethrOutputs.status, "gated"),
        sql`coalesce(${tethrOutputs.meta}->'spec'->>'tag', ${tethrOutputs.meta}->>'tag') = ${tag}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Stage an approval card, from tethr or from the lead asking (so its owner is the one buzzed). */
async function stageCard(
  ctx: Scoped,
  caller: Caller,
  card: { kind: typeof TEAM_AGENT_KIND | typeof TEAM_CHANGE_KIND; title: string; body: string; sensitivity: "org" | "spend"; meta: Record<string, unknown> },
) {
  const router = await orgService(ctx.db).getRouterProfile(ctx.companyId);
  if (!router) throw new Error("No @tethr agent in this company.");
  const asker = caller.kind === "lead" ? { agentId: caller.agent.agentId, agentTag: caller.agent.tag } : { agentId: router.agent.id, agentTag: router.profile.tag };
  return gatingService(ctx.db).createOutput({
    companyId: ctx.companyId,
    ...asker,
    routeRunId: ctx.runId ?? null,
    kind: card.kind,
    title: card.title.slice(0, 160),
    body: card.body,
    sensitivity: card.sensitivity,
    meta: { ...card.meta, threadId: ctx.threadId ?? null },
  });
}

/** Is there room under Automatic? Returns why not, or null. */
async function overTeamLimits(ctx: Scoped, budgetUsd: number): Promise<string | null> {
  const settings = getIntegrations(ctx.companyId).team;
  const team = teamService(ctx.db);
  const active = (await team.list(ctx.companyId)).filter((a) => !a.paused);
  if (active.length >= settings.maxAgents) return `the team already has ${active.length} active agents (limit ${settings.maxAgents})`;
  if ((await team.activeBudgetCents(ctx.companyId)) + Math.round(budgetUsd * 100) > settings.monthlyBudgetUsd * 100) {
    return `it would take the team past its $${settings.monthlyBudgetUsd} a month`;
  }
  return null;
}

async function createAgent(ctx: Scoped, caller: Caller, args: Record<string, unknown>): Promise<TethrToolResult> {
  const team = teamService(ctx.db);
  const lead = caller.kind === "lead" ? caller.agent : null;
  if (lead && (await team.subTeam(ctx.companyId, lead.tag)).length >= TEAM_LIMITS.subAgentsMax) {
    return { text: `${lead.tag} already has ${TEAM_LIMITS.subAgentsMax} agents on its team; change one with update_agent instead.`, isError: true };
  }
  const spec = validateTeamSpec(args, {
    takenTags: await team.takenTags(ctx.companyId),
    connectors: teamConnectorLabels(ctx.companyId),
    goals: await goalTitles(ctx.db, ctx.companyId),
    lead: lead ? { tag: lead.tag, connectors: lead.connectors } : null,
  });
  if (await pendingCardFor(ctx.db, ctx.companyId, TEAM_AGENT_KIND, spec.tag)) {
    return { text: `${spec.tag} is already waiting for approval. Don't propose it again.`, isError: true };
  }
  const why = typeof args.why === "string" ? args.why.trim().slice(0, 600) : "";
  const settings = getIntegrations(ctx.companyId).team;
  const tz = getSetup(ctx.companyId).timezone;
  const forTeam = lead ? ` for ${lead.tag}'s team` : "";

  let overLimit: string | null = null;
  if (settings.newAgents === "auto") {
    overLimit = await overTeamLimits(ctx, spec.budgetMonthlyUsd);
    if (!overLimit) {
      const router = await orgService(ctx.db).getRouterProfile(ctx.companyId);
      const agent = await team.create(ctx.companyId, spec, { via: "auto", agentId: lead?.agentId ?? router?.agent.id ?? null }, { lead });
      await announceNewAgent(ctx.db, ctx.companyId, agent, why);
      return {
        text: [
          `Created ${agent.tag} (${agent.name}, ${agent.title})${forTeam}. It's live${agent.schedule ? ` and runs ${scheduleWords(agent.schedule.cron, tz)}` : ""}.`,
          spec.goal ? `${goalLine(spec.goal, { pending: false })}.` : "",
          spec.firstTask ? `Its first task, "${spec.firstTask.title}", has started; the report will come back to ${lead?.tag ?? "you"}.` : "Give it work with assign_task.",
          lead ? "" : "Tell the person what you created and why.",
        ]
          .filter(Boolean)
          .join(" "),
        meta: { tag: agent.tag, via: "auto" },
      };
    }
  }
  const output = await stageCard(ctx, caller, {
    kind: TEAM_AGENT_KIND,
    title: `New agent${forTeam}: ${spec.name} (${spec.tag}), ${spec.title}`,
    body: teamSpecText(spec, { ownerName: ownerName(ctx.companyId, spec.ownerRole), timezone: tz, why, leadTag: lead?.tag ?? null }),
    sensitivity: "org",
    meta: { spec, why, leadTag: lead?.tag ?? null },
  });
  return {
    text: `Sent ${spec.tag} for approval${overLimit ? ` (automatic creation is on, but ${overLimit})` : ""}: a card with its full spec${spec.goal ? " and its goal" : ""} is right under your reply, where they approve or reject it (say "the card below", not Slack or another page). It's created when they approve; don't call create_agent for it again.${lead ? "" : " Tell them in a line what it's for."}`,
    meta: { tag: spec.tag, outputId: output.id, via: "card" },
  };
}

async function assignTask(ctx: Scoped, caller: Caller, args: Record<string, unknown>): Promise<TethrToolResult> {
  const tag = typeof args.agent === "string" ? args.agent : "";
  if (!tag.trim()) return { text: "assign_task: give agent (its @tag).", isError: true };
  const task = validateTask(args, "task");
  const team = teamService(ctx.db);
  if (caller.kind === "lead") {
    const target = await team.get(ctx.companyId, tag);
    if (!target || target.leadTag !== caller.agent.tag) {
      return { text: `assign_task: ${tag} isn't on your sub-team. Check team_list.`, isError: true };
    }
    const parentIssueId = ctx.runId ? taskIssueForRun(ctx.runId) : null;
    const { identifier, agent } = await team.assign(ctx.companyId, tag, task, { agentId: caller.agent.agentId, parentIssueId });
    return {
      text: `Assigned ${identifier ?? "the task"} to ${agent.tag}: "${task.title}".${parentIssueId ? " It's a sub-task of the task you're on; you'll be woken to roll up when your sub-team is done." : " Its report will come back to your chat."}`,
      meta: { tag: agent.tag, identifier, sub: !!parentIssueId },
    };
  }
  const router = await orgService(ctx.db).getRouterProfile(ctx.companyId);
  const { identifier, agent } = await team.assign(ctx.companyId, tag, task, { agentId: router?.agent.id ?? null });
  return {
    text: `Assigned ${identifier ?? "the task"} to ${agent.tag}: "${task.title}". It's starting in its own chat; its report will come back to ${agent.leadTag ?? "this chat"}. Carry on meanwhile.`,
    meta: { tag: agent.tag, identifier },
  };
}

async function updateAgent(ctx: Scoped, caller: Caller, args: Record<string, unknown>): Promise<TethrToolResult> {
  const team = teamService(ctx.db);
  const agent = manageable(caller, await team.list(ctx.companyId)).find(
    (a) => a.tag === `@${String(args.agent ?? "").trim().replace(/^@+/, "").toLowerCase()}`,
  );
  if (!agent) return { text: `update_agent: there's no agent ${String(args.agent ?? "")} you can change. Check team_list.`, isError: true };
  const { agent: _a, pause, why: rawWhy, ...fields } = args;
  const why = typeof rawWhy === "string" ? rawWhy.trim().slice(0, 600) : "";
  const done: string[] = [];
  if (pause === true && !agent.paused) {
    await team.setPaused(ctx.companyId, agent.tag, true, {});
    done.push(`Paused ${agent.tag}: no scheduled or assigned runs until it's resumed.`);
  }
  const patch: TeamPatch = validateTeamPatch(fields, ctx.companyId);
  if (caller.kind === "lead" && patch.connectors) {
    const extra = patch.connectors.filter((c) => !caller.agent.connectors.includes(c));
    if (extra.length) return { text: `update_agent: a sub-agent can only use tools you have; you don't have ${extra.join(", ")}.`, isError: true };
  }
  const resume = pause === false && agent.paused;
  if (!Object.keys(patch).length && !resume) {
    return done.length ? { text: done.join(" ") } : { text: "update_agent: nothing to change.", isError: true };
  }
  const settings = getIntegrations(ctx.companyId).team;
  const raises = raisesLimits(agent, patch);
  if (settings.newAgents === "auto" && !raises) {
    if (Object.keys(patch).length) await team.update(ctx.companyId, agent.tag, patch, {});
    if (resume) await team.setPaused(ctx.companyId, agent.tag, false, {});
    done.push(`Updated ${agent.tag}${resume ? " and resumed it" : ""}.`);
    return { text: `${done.join(" ")}${caller.kind === "tethr" ? " Tell the person what changed and why." : ""}` };
  }
  const tz = getSetup(ctx.companyId).timezone;
  const lines = [...(resume ? ["Resume it (scheduled and assigned runs start again)"] : []), ...describePatch(agent, patch, tz)];
  if (why) lines.push("", `Why: ${why}`);
  const output = await stageCard(ctx, caller, {
    kind: TEAM_CHANGE_KIND,
    title: `Change ${agent.tag}: ${[resume ? "resume" : "", ...Object.keys(patch)].filter(Boolean).join(", ")}`,
    body: [`${agent.name} (${agent.tag}): ${agent.title}`, "", ...lines].join("\n"),
    // A raise in what it may spend or how often it runs rides the money gate (always a person).
    sensitivity: raises ? "spend" : "org",
    meta: { tag: agent.tag, patch, resume, why },
  });
  done.push(`Sent the change to ${agent.tag} for approval (the card is right under your reply); it applies when approved.`);
  return { text: done.join(" "), meta: { tag: agent.tag, outputId: output.id } };
}

/** Run one team tool. Errors in the input come back as error results. */
export async function runTeamTool(name: string, args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId) return { text: `${name} isn't available here.`, isError: true };
  const scoped: Scoped = { ...ctx, companyId: ctx.companyId, db: ctx.db };
  try {
    const caller = await callerOf(scoped);
    if (caller.kind === "refused") return { text: `${name}: ${caller.text}`, isError: true };
    if (name === "team_list") return await teamList(scoped, caller);
    if (name === "create_agent") return await createAgent(scoped, caller, args);
    if (name === "assign_task") return await assignTask(scoped, caller, args);
    if (name === "update_agent") return await updateAgent(scoped, caller, args);
    return { text: `There's no team tool called ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof TeamInputError) return { text: `${name}: ${err.message}`, isError: true };
    throw err;
  }
}

/** For gating (approve a card): the agent spec a card carries. */
export function specFromCard(meta: unknown): TeamAgentSpec | null {
  const spec = (meta as { spec?: TeamAgentSpec } | null)?.spec;
  return spec && typeof spec.tag === "string" ? spec : null;
}
