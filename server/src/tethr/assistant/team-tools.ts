import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs } from "@paperclipai/db";
import { gatingService } from "../gating.js";
import { getIntegrations } from "../integrations.js";
import { orgService } from "../org.js";
import { getRoster } from "../overseers.js";
import { getSetup } from "../setup.js";
import { announceNewAgent } from "../team-report.js";
import { scheduleWords, TEAM_LIMITS, TeamInputError, teamSpecText, validateTask, validateTeamSpec, type TeamAgentSpec } from "../team-spec.js";
import { describePatch, raisesLimits, teamConnectorLabels, teamService, validateTeamPatch, type TeamAgent, type TeamPatch } from "../team.js";
import type { McpToolDef, TethrToolContext, TethrToolResult } from "./tethr-tools.js";

// Phase 23: tethr's tools for running its team, on the "tethr" MCP server. Only
// tethr's own chats (main and side) may use them: an agent's thread is refused
// by its deny rules, the gate and the tools endpoint. New agents and changes
// follow Integrations → Team ("Ask me" = an approval card, "Automatic" = within
// the team's limits); a raise in budget or runs always asks; pausing never does.

export const TEAM_TOOL_DEFS: McpToolDef[] = [
  {
    name: "team_list",
    description:
      "Your team of agents: each one's tag, job, status, schedule, owner, runs used today, open tasks and spend, plus the team's limits and whether new agents need approval. Check it before creating or assigning.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_agent",
    description:
      "Add an agent to your team: one clear job that repeats or needs its own focus (a weekly check, a running watch, an ongoing project). It gets its own chat, works tasks you assign and its schedule, and reports back to you here and to its owner on Slack. Depending on the team setting it's created right away or shown to the person as an approval card. Never create a duplicate of an agent in team_list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'A short name, e.g. "Price Scout".' },
        tag: { type: "string", description: "Optional @tag (lowercase, hyphens). Defaults from the name." },
        title: { type: "string", description: 'Its job title, e.g. "Competitor pricing watch".' },
        mission: { type: "string", description: "One sentence: what it's for and which goal it moves." },
        instructions: {
          type: "string",
          description: "How to do the job: what to look at, how, what to deliver (and where in files/), what good looks like, what to avoid. Written to the agent.",
        },
        connectors: {
          type: "array",
          items: { type: "string" },
          description: 'The connectors it may use, by their Integrations names (e.g. "Google Drive", "Stripe", "Tethr tools"). Only what the job needs.',
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
          description: "Optional. A task to start as soon as it exists.",
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
      "Hand one task to an agent on your team. It starts right away in the agent's own chat, and its report comes back to this chat (and its owner on Slack). Use it for one-off or parallel work that fits an agent's job; keep talking with the person meanwhile.",
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
      "Change an agent on your team: pause or resume it, or change its title, mission, instructions, connectors, schedule (null removes it), budget, runs a day or owner. Pausing happens at once. Other changes follow the team setting; raising its budget or runs always asks the person.",
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

function ownerName(companyId: string, role: TeamAgent["ownerRole"]): string | undefined {
  return getRoster(companyId)[role]?.name || undefined;
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;

async function teamList(db: Db, companyId: string): Promise<TethrToolResult> {
  const team = teamService(db);
  const agents = await team.list(companyId);
  const settings = getIntegrations(companyId).team;
  const tz = getSetup(companyId).timezone;
  const active = agents.filter((a) => !a.paused);
  const header = `Your team: ${active.length} active, ${agents.length - active.length} paused. Limits: ${settings.maxAgents} active agents, $${settings.monthlyBudgetUsd} a month together. New agents: ${settings.newAgents === "auto" ? "automatic (within the limits)" : "need the person's approval"}.`;
  if (!agents.length) return { text: `${header}\nNo agents yet.` };
  const lines = [header];
  for (const a of agents) {
    const [runs, open] = await Promise.all([team.runsToday(a.agentId), team.openTasks(a.agentId)]);
    lines.push(
      `- ${a.tag} · ${a.name} · ${a.title} · ${a.paused ? "paused" : "active"} · ${a.schedule ? scheduleWords(a.schedule.cron, tz) : "on assignment only"}`,
      `  Mission: ${a.mission}`,
      `  Tools: ${a.connectors.join(", ") || "files only"} · reports to ${ownerName(companyId, a.ownerRole) ?? a.ownerRole} (${a.ownerRole})`,
      `  Today: ${runs} of ${a.maxRunsPerDay} runs · open tasks: ${open} of ${TEAM_LIMITS.openTasksMax} · spend: ${dollars(a.spentMonthlyCents)} of ${dollars(a.budgetMonthlyCents)} this month`,
    );
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

async function stageCard(
  db: Db,
  ctx: Required<Pick<TethrToolContext, "companyId">> & TethrToolContext,
  card: { kind: typeof TEAM_AGENT_KIND | typeof TEAM_CHANGE_KIND; title: string; body: string; sensitivity: "org" | "spend"; meta: Record<string, unknown> },
) {
  const router = await orgService(db).getRouterProfile(ctx.companyId);
  if (!router) throw new Error("No @tethr agent in this company.");
  return gatingService(db).createOutput({
    companyId: ctx.companyId,
    agentId: router.agent.id,
    agentTag: router.profile.tag,
    routeRunId: ctx.runId ?? null,
    kind: card.kind,
    title: card.title.slice(0, 160),
    body: card.body,
    sensitivity: card.sensitivity,
    meta: { ...card.meta, threadId: ctx.threadId ?? null },
  });
}

async function createAgent(db: Db, ctx: TethrToolContext & { companyId: string }, args: Record<string, unknown>): Promise<TethrToolResult> {
  const team = teamService(db);
  const spec = validateTeamSpec(args, { takenTags: await team.takenTags(ctx.companyId), connectors: teamConnectorLabels(ctx.companyId) });
  if (await pendingCardFor(db, ctx.companyId, TEAM_AGENT_KIND, spec.tag)) {
    return { text: `${spec.tag} is already waiting for approval. Don't propose it again.`, isError: true };
  }
  const why = typeof args.why === "string" ? args.why.trim().slice(0, 600) : "";
  const settings = getIntegrations(ctx.companyId).team;
  const tz = getSetup(ctx.companyId).timezone;

  let overLimit: string | null = null;
  if (settings.newAgents === "auto") {
    const active = (await team.list(ctx.companyId)).filter((a) => !a.paused);
    const committed = await team.activeBudgetCents(ctx.companyId);
    if (active.length >= settings.maxAgents) overLimit = `the team already has ${active.length} active agents (limit ${settings.maxAgents})`;
    else if (committed + Math.round(spec.budgetMonthlyUsd * 100) > settings.monthlyBudgetUsd * 100) {
      overLimit = `it would take the team past its $${settings.monthlyBudgetUsd} a month`;
    }
    if (!overLimit) {
      const router = await orgService(db).getRouterProfile(ctx.companyId);
      const agent = await team.create(ctx.companyId, spec, { via: "auto", agentId: router?.agent.id ?? null });
      await announceNewAgent(db, ctx.companyId, agent, why);
      return {
        text: [
          `Created ${agent.tag} (${agent.name}, ${agent.title}). It's live${agent.schedule ? ` and runs ${scheduleWords(agent.schedule.cron, tz)}` : ""}.`,
          spec.firstTask ? `Its first task, "${spec.firstTask.title}", has started; the report will come back here.` : "Give it work with assign_task.",
          "Tell the person what you created and why.",
        ].join(" "),
        meta: { tag: agent.tag, via: "auto" },
      };
    }
  }
  const output = await stageCard(db, ctx, {
    kind: TEAM_AGENT_KIND,
    title: `New agent: ${spec.name} (${spec.tag}), ${spec.title}`,
    body: teamSpecText(spec, { ownerName: ownerName(ctx.companyId, spec.ownerRole), timezone: tz, why }),
    sensitivity: "org",
    meta: { spec, why },
  });
  return {
    text: `Sent ${spec.tag} for approval${overLimit ? ` (automatic creation is on, but ${overLimit})` : ""}: a card with its full spec is in this chat and the Queue. It's created when the person approves; don't call create_agent for it again. Tell them in a line what it's for.`,
    meta: { tag: spec.tag, outputId: output.id, via: "card" },
  };
}

async function assignTask(db: Db, ctx: TethrToolContext & { companyId: string }, args: Record<string, unknown>): Promise<TethrToolResult> {
  const tag = typeof args.agent === "string" ? args.agent : "";
  if (!tag.trim()) return { text: "assign_task: give agent (its @tag).", isError: true };
  const task = validateTask(args, "task");
  const router = await orgService(db).getRouterProfile(ctx.companyId);
  const { identifier, agent } = await teamService(db).assign(ctx.companyId, tag, task, { agentId: router?.agent.id ?? null });
  return {
    text: `Assigned ${identifier ?? "the task"} to ${agent.tag}: "${task.title}". It's starting in its own chat; its report will come back to this chat. Carry on meanwhile.`,
    meta: { tag: agent.tag, identifier },
  };
}

async function updateAgent(db: Db, ctx: TethrToolContext & { companyId: string }, args: Record<string, unknown>): Promise<TethrToolResult> {
  const team = teamService(db);
  const agent = await team.get(ctx.companyId, typeof args.agent === "string" ? args.agent : "");
  if (!agent) return { text: `update_agent: there's no agent ${String(args.agent ?? "")} on the team. Check team_list.`, isError: true };
  const { agent: _a, pause, why: rawWhy, ...fields } = args;
  const why = typeof rawWhy === "string" ? rawWhy.trim().slice(0, 600) : "";
  const done: string[] = [];
  if (pause === true && !agent.paused) {
    await team.setPaused(ctx.companyId, agent.tag, true, {});
    done.push(`Paused ${agent.tag}: no scheduled or assigned runs until it's resumed.`);
  }
  const patch: TeamPatch = validateTeamPatch(fields, ctx.companyId);
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
    return { text: `${done.join(" ")} Tell the person what changed and why.` };
  }
  const tz = getSetup(ctx.companyId).timezone;
  const lines = [...(resume ? ["Resume it (scheduled and assigned runs start again)"] : []), ...describePatch(agent, patch, tz)];
  if (why) lines.push("", `Why: ${why}`);
  const output = await stageCard(db, ctx, {
    kind: TEAM_CHANGE_KIND,
    title: `Change ${agent.tag}: ${[resume ? "resume" : "", ...Object.keys(patch)].filter(Boolean).join(", ")}`,
    body: [`${agent.name} (${agent.tag}): ${agent.title}`, "", ...lines].join("\n"),
    // A raise in what it may spend or how often it runs rides the money gate (always a person).
    sensitivity: raises ? "spend" : "org",
    meta: { tag: agent.tag, patch, resume, why },
  });
  done.push(`Sent the change to ${agent.tag} for approval (a card in this chat and the Queue); it applies when approved.`);
  return { text: done.join(" "), meta: { tag: agent.tag, outputId: output.id } };
}

/** Run one team tool. Errors in the input come back as error results. */
export async function runTeamTool(name: string, args: Record<string, unknown>, ctx: TethrToolContext): Promise<TethrToolResult> {
  if (!ctx.db || !ctx.companyId) return { text: `${name} isn't available here.`, isError: true };
  const scoped = { ...ctx, companyId: ctx.companyId };
  try {
    if (name === "team_list") return await teamList(ctx.db, ctx.companyId);
    if (name === "create_agent") return await createAgent(ctx.db, scoped, args);
    if (name === "assign_task") return await assignTask(ctx.db, scoped, args);
    if (name === "update_agent") return await updateAgent(ctx.db, scoped, args);
    return { text: `There's no team tool called ${name}.`, isError: true };
  } catch (err) {
    if (err instanceof TeamInputError) return { text: `${name}: ${err.message}`, isError: true };
    throw err;
  }
}

/** For gating (approve a card): build the agent the card describes. */
export function specFromCard(meta: unknown): TeamAgentSpec | null {
  const spec = (meta as { spec?: TeamAgentSpec } | null)?.spec;
  return spec && typeof spec.tag === "string" ? spec : null;
}
