import { Router } from "express";
import { and, count, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { openQuestions } from "../tethr/assistant/questions.js";
import { needsYou } from "../tethr/needs-you.js";
import { recheckConnections } from "../tethr/team-needs.js";
import { getAssistantRunner } from "../tethr/assistant/runner.js";
import * as chats from "../tethr/chats.js";
import { adminFirstName, companyProfileService } from "../tethr/company.js";
import { autonomyFor, getIntegrations, modeFor } from "../tethr/integrations.js";
import { AgentSettingsError, effectiveSettings, parseAgentSettings, settingsOwner, settingsSummary, SETTINGLESS_TOOLS, type AgentSettings } from "../tethr/agent-settings.js";
import { kindsForConnector } from "../tethr/assistant/policy.js";
import { spendAdapterFor } from "../tethr/spend/adapters.js";
import { getRoster } from "../tethr/overseers.js";
import { getSetup } from "../tethr/setup.js";
import { AGENT_REPORT_SOURCE } from "../tethr/team-report.js";
import { scheduleWords, TEAM_LIMITS, TeamInputError, teamProposalBrief, validateConnectors } from "../tethr/team-spec.js";
import { describePatch, teamConnectorLabels, teamService, type TeamAgent, type TeamPatch } from "../tethr/team.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Phase 23: tethr's team for the UI. The roster with what each agent is doing
// right now, pause/resume (a person's call, applied at once), and "propose a
// starting team" (a system turn in the main chat; under "Ask me" it only makes
// approval cards). Mounted by tethrRoutes (routes/tethr.ts).

export function tethrTeamRoutes(db: Db): Router {
  const router = Router();

  router.get("/tethr/:companyId/team", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const team = teamService(db);
    const agents = await team.list(companyId);
    const ids = agents.map((a) => a.agentId);
    const tz = getSetup(companyId).timezone;
    const roster = getRoster(companyId);
    const [running, waiting, reports] = ids.length
      ? await Promise.all([
          db
            .select({ agentId: tethrRouteRuns.agentId, n: count() })
            .from(tethrRouteRuns)
            .where(and(inArray(tethrRouteRuns.agentId, ids), inArray(tethrRouteRuns.status, ["queued", "running"])))
            .groupBy(tethrRouteRuns.agentId),
          db
            .select({ agentId: tethrOutputs.agentId, n: count() })
            .from(tethrOutputs)
            .where(and(inArray(tethrOutputs.agentId, ids), inArray(tethrOutputs.status, ["gated", "changes_requested"])))
            .groupBy(tethrOutputs.agentId),
          db
            .select({ agentId: tethrRouteRuns.agentId, at: max(tethrRouteRuns.createdAt) })
            .from(tethrRouteRuns)
            .where(and(inArray(tethrRouteRuns.agentId, ids), eq(tethrRouteRuns.sourceKey, AGENT_REPORT_SOURCE)))
            .groupBy(tethrRouteRuns.agentId),
        ])
      : [[], [], []];
    const by = <T extends { agentId: string | null }>(rows: T[], id: string) => rows.find((r) => r.agentId === id);
    res.json({
      settings: getIntegrations(companyId).team,
      agents: await Promise.all(
        agents.map(async (a) => ({
          agentId: a.agentId,
          tag: a.tag,
          name: a.name,
          title: a.title,
          mission: a.mission,
          icon: a.icon,
          paused: a.paused,
          threadId: a.threadId,
          lead: a.lead,
          leadTag: a.leadTag,
          subTeam: agents.filter((s) => s.leadTag === a.tag).map((s) => s.tag),
          goal: a.goalId ? { id: a.goalId, title: a.goalTitle } : null,
          connectors: a.connectors,
          schedule: a.schedule ? { ...a.schedule, words: scheduleWords(a.schedule.cron, tz) } : null,
          ownerRole: a.ownerRole,
          ownerName: roster[a.ownerRole]?.name || null,
          maxRunsPerDay: a.maxRunsPerDay,
          runsToday: await team.runsToday(a.agentId),
          openTasks: await team.openTasks(a.agentId),
          running: Number(by(running, a.agentId)?.n ?? 0) > 0,
          // Approval cards it's waiting on, plus questions it asked that nobody has answered.
          waitingOnYou: Number(by(waiting, a.agentId)?.n ?? 0) + openQuestions(companyId, { agentTag: a.tag }).length,
          lastReportAt: by(reports, a.agentId)?.at ?? null,
          // Phase 27: connections its job needs that are missing. While any is, it doesn't run.
          waitingFor: [...new Set((await team.unmetNeeds(companyId, a)).map((n) => n.key))],
          budgetMonthlyCents: a.budgetMonthlyCents,
          spentMonthlyCents: a.spentMonthlyCents,
          // What runs on its own and what needs approval (a sub-agent: its lead's settings).
          settingsSummary: summaryFor(a, agents),
        })),
      ),
    });
  });

  // ---- an agent's own settings (Mark: "if there's a paid ad agent that's the head that's where all the settings should live") ----

  function summaryFor(a: TeamAgent, all: TeamAgent[]) {
    const owner = settingsOwner(a, all.find((x) => x.tag === a.leadTag) ?? null);
    return settingsSummary(Object.keys(owner.settings).length ? owner.settings : undefined, a.connectors);
  }

  router.get("/tethr/:companyId/team/:tag/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const all = await teamService(db).list(companyId);
    const agent = all.find((a) => a.tag === String(req.params.tag));
    if (!agent) {
      res.status(404).json({ error: "There's no such agent on the team." });
      return;
    }
    const cfg = getIntegrations(companyId);
    const lead = all.find((a) => a.tag === agent.leadTag) ?? null;
    const owner = settingsOwner(agent, lead);
    const tools = agent.connectors.filter((c) => !SETTINGLESS_TOOLS.has(c));
    res.json({
      tag: agent.tag,
      name: agent.name,
      // A sub-agent's settings live on its lead.
      settingsFrom: lead ? lead.tag : null,
      connectors: agent.connectors,
      tools: tools.map((connector) => {
        const effective = effectiveSettings(cfg, owner, connector);
        return {
          connector,
          // What the company has it at (Off there is off for everyone).
          company: modeFor(cfg, connector),
          own: owner.settings[connector] ?? null,
          mode: effective.mode,
          autonomy: effective.autonomy,
          kinds: kindsForConnector(connector),
          readsAccount: !!spendAdapterFor(connector),
        };
      }),
      // Tools it could be given: on in the company and not its own yet (a sub-agent: only its lead's).
      canAdd: teamConnectorLabels(companyId).filter(
        (c) => !SETTINGLESS_TOOLS.has(c) && !agent.connectors.includes(c) && modeFor(cfg, c) !== "off" && (!lead || lead.connectors.includes(c)),
      ),
      summary: summaryFor(agent, all),
      limits: { budgetMonthlyUsd: agent.budgetMonthlyCents / 100, maxRunsPerDay: agent.maxRunsPerDay, spentMonthlyUsd: agent.spentMonthlyCents / 100 },
      paused: agent.paused,
      subTeam: all
        .filter((s) => s.leadTag === agent.tag)
        .map((s) => ({ tag: s.tag, name: s.name, title: s.title, icon: s.icon, paused: s.paused, connectors: s.connectors, budgetMonthlyUsd: s.budgetMonthlyCents / 100, maxRunsPerDay: s.maxRunsPerDay })),
    });
  });

  // A person changes an agent's settings: applied at once (they're the one deciding).
  router.put("/tethr/:companyId/team/:tag/settings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const actor = getActorInfo(req);
    const team = teamService(db);
    const agent = await team.get(companyId, String(req.params.tag));
    if (!agent) {
      res.status(404).json({ error: "There's no such agent on the team." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const patch: TeamPatch = {};
      const cfg = getIntegrations(companyId);
      if (body.connectors !== undefined) {
        const lead = agent.leadTag ? await team.get(companyId, agent.leadTag) : null;
        const wanted = validateConnectors(body.connectors, teamConnectorLabels(companyId));
        const off = wanted.filter((c) => !agent.connectors.includes(c) && modeFor(cfg, c) === "off");
        if (off.length) throw new TeamInputError(`${off.join(", ")} ${off.length === 1 ? "is" : "are"} off in Integrations; switch it on there first.`);
        const beyondLead = lead ? wanted.filter((c) => !lead.connectors.includes(c)) : [];
        if (beyondLead.length) throw new TeamInputError(`A sub-agent can only use tools its lead has; ${lead!.tag} doesn't have ${beyondLead.join(", ")}.`);
        patch.connectors = wanted;
      }
      if (body.tools !== undefined) {
        if (agent.leadTag) {
          res.status(409).json({ error: `${agent.tag}'s settings live on its lead, ${agent.leadTag}.`, settingsFrom: agent.leadTag });
          return;
        }
        const tools = patch.connectors ?? agent.connectors;
        // An agent that has been following tethr's settings starts from them, so setting one
        // tool doesn't quietly change the others.
        const before: AgentSettings = Object.keys(agent.settings).length
          ? agent.settings
          : Object.fromEntries(
              tools
                .filter((t) => !SETTINGLESS_TOOLS.has(t))
                .map((t) => {
                  const mode = modeFor(cfg, t);
                  return [t, { mode: mode === "off" ? "read" : mode, autonomy: autonomyFor(cfg, t) }];
                }),
            );
        patch.settings = { ...before, ...parseAgentSettings(body.tools, tools, { byPerson: true, before }) };
      }
      if (body.budgetMonthlyUsd !== undefined) {
        const n = Number(body.budgetMonthlyUsd);
        if (!Number.isFinite(n) || n < 1 || n > TEAM_LIMITS.budgetMaxUsd) throw new TeamInputError(`The monthly budget is 1 to ${TEAM_LIMITS.budgetMaxUsd} dollars.`);
        patch.budgetMonthlyUsd = Math.round(n * 100) / 100;
      }
      if (body.maxRunsPerDay !== undefined) {
        const n = Number(body.maxRunsPerDay);
        if (!Number.isInteger(n) || n < 1 || n > TEAM_LIMITS.runsMax) throw new TeamInputError(`Runs a day is a whole number from 1 to ${TEAM_LIMITS.runsMax}.`);
        patch.maxRunsPerDay = n;
      }
      if (!Object.keys(patch).length) {
        res.status(400).json({ error: "Nothing to change." });
        return;
      }
      const updated = await team.update(companyId, agent.tag, patch, { userId: actor.actorId });
      await chats
        .addNote(companyId, chats.mainThreadId(companyId), `${updated.tag}'s settings were changed by hand in tethr: ${describePatch(agent, patch).join("; ")}.`)
        .catch(() => {});
      res.json({ tag: updated.tag, settings: updated.settings, connectors: updated.connectors });
    } catch (err) {
      if (err instanceof TeamInputError || err instanceof AgentSettingsError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Phase 27: everything that waits on a person, as one list (the chat's pill, the
  // Needs you page, the sidebar count).
  router.get("/tethr/:companyId/needs-you", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await needsYou(db, companyId));
  });

  // After a key or a connector setting was saved from a card: close the cards it
  // answers and start what was only waiting on that.
  router.post("/tethr/:companyId/team/recheck", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    res.json(await recheckConnections(db, companyId));
  });

  // Pause or resume an agent. A person deciding this needs no card.
  router.post("/tethr/:companyId/team/:tag/pause", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const actor = getActorInfo(req);
    try {
      const agent = await teamService(db).setPaused(companyId, String(req.params.tag), req.body?.paused !== false, { userId: actor.actorId });
      await chats
        .addNote(companyId, chats.mainThreadId(companyId), `${agent.tag} was ${agent.paused ? "paused" : "resumed"} by hand in tethr.`)
        .catch(() => {});
      res.json({ tag: agent.tag, paused: agent.paused });
    } catch (err) {
      if (err instanceof TeamInputError) {
        res.status(404).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Ask tethr to propose a starting team in the main chat.
  router.post("/tethr/:companyId/team/propose", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const actor = getActorInfo(req);
    const profile = await companyProfileService(db).get(companyId);
    const ids = await getAssistantRunner(db).send({
      companyId,
      threadId: chats.mainThreadId(companyId),
      kind: "system",
      text: teamProposalBrief(adminFirstName(profile)),
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    res.json(ids);
  });

  return router;
}
