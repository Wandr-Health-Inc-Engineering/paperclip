import { Router } from "express";
import { and, count, eq, inArray, max } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { getAssistantRunner } from "../tethr/assistant/runner.js";
import * as chats from "../tethr/chats.js";
import { adminFirstName, companyProfileService } from "../tethr/company.js";
import { getIntegrations } from "../tethr/integrations.js";
import { getRoster } from "../tethr/overseers.js";
import { getSetup } from "../tethr/setup.js";
import { AGENT_REPORT_SOURCE } from "../tethr/team-report.js";
import { scheduleWords, TeamInputError, teamProposalBrief } from "../tethr/team-spec.js";
import { teamService } from "../tethr/team.js";
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
          waitingOnYou: Number(by(waiting, a.agentId)?.n ?? 0),
          lastReportAt: by(reports, a.agentId)?.at ?? null,
          budgetMonthlyCents: a.budgetMonthlyCents,
          spentMonthlyCents: a.spentMonthlyCents,
        })),
      ),
    });
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
