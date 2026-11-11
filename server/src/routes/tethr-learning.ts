import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { kindStats } from "../tethr/decide/decide.js";
import { MemoryChangeError } from "../tethr/hermes/memory-layer.js";
import { oneLine } from "../tethr/goals.js";
import { activeRules } from "../tethr/inbox/store.js";
import { disableLearner, enableLearner, LearnerError, setLearningPace } from "../tethr/learn/learner.js";
import { DEFAULT_PACE, paceSchedule, parsePace } from "../tethr/learn/learning-pace.js";
import { listStudies } from "../tethr/learn/studies.js";
import { startStudy, stopStudy, StudyError, undoSkill } from "../tethr/learn/study.js";
import { areaName, LessonError, lessonsService } from "../tethr/learn/lessons.js";
import { learningStore } from "../tethr/learn/store.js";
import { teamService } from "../tethr/team.js";
import { TeamInputError } from "../tethr/team-spec.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Phase 26.5-26.6: the Learning page and the lesson cards. What tethr learned
// (by area and status, where each is applied, what happened), the learner's
// switch, pace and studies (rebuilt 2026-11-10: studies that end in skills,
// with Undo), the sources' track record, and how accurate each kind of Jev
// decision has been. Every change is a person's (agents get 403).

export function tethrLearningRoutes(db: Db): Router {
  const router = Router();
  const lessons = lessonsService(db);

  router.get("/tethr/:companyId/learning", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const state = learningStore.get(companyId);
    const agent = state.agentTag ? await teamService(db).get(companyId, state.agentTag) : null;
    const all = await lessons.list(companyId);
    res.json({
      lessons: all.map((l) => ({ ...l, areaName: areaName(l.area) })),
      learner: {
        enabled: state.enabled === true,
        agent: agent ? { tag: agent.tag, name: agent.name, paused: agent.paused, threadId: agent.threadId, maxRunsPerDay: agent.maxRunsPerDay, budgetMonthlyCents: agent.budgetMonthlyCents, spentMonthlyCents: agent.spentMonthlyCents } : null,
        pace: state.pace ?? DEFAULT_PACE,
        schedule: paceSchedule(state.pace),
        applyMode: state.applyMode ?? "auto",
      },
      // The learner's studies, newest first, with the skills each made.
      studies: listStudies(companyId).slice(0, 30),
      sources: Object.entries(state.sources ?? {})
        .map(([domain, r]) => ({ domain, ...r }))
        .sort((a, b) => b.approved + b.kept - (a.approved + a.kept))
        .slice(0, 30),
      decisions: await kindStats(db, companyId),
      filingRules: activeRules(companyId).map((r) => r.text),
    });
  });

  const person =
    (
      handler: (
        companyId: string,
        id: string,
        body: Record<string, unknown>,
        actor: { userId: string | null; name: string },
        params: Record<string, string | undefined>,
      ) => Promise<unknown>,
    ) =>
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!requirePerson(req, res)) return;
      const userId = getActorInfo(req).actorId ?? null;
      try {
        const out = await handler(companyId, String(req.params.id ?? ""), (req.body ?? {}) as Record<string, unknown>, { userId, name: "Learning page" }, req.params as Record<string, string | undefined>);
        res.json(out ?? { ok: true });
      } catch (err) {
        if (err instanceof LessonError || err instanceof LearnerError || err instanceof StudyError || err instanceof TeamInputError || err instanceof MemoryChangeError) {
          res.status(409).json({ error: err.message });
          return;
        }
        throw err;
      }
    };

  router.post("/tethr/:companyId/lessons/:id/apply", person((c, id, _b, actor) => lessons.apply(c, id, actor.name)));
  router.post("/tethr/:companyId/lessons/:id/reject", person((c, id, b, actor) => lessons.reject(c, id, actor.name, typeof b.reason === "string" ? b.reason : undefined)));
  router.post("/tethr/:companyId/lessons/:id/offer", person((c, id) => lessons.offer(c, id)));
  router.post("/tethr/:companyId/lessons/:id/settle", person((c, id, b, actor) => lessons.settle(c, id, b.keep === true, actor.name)));

  router.post(
    "/tethr/:companyId/learning/learner",
    person(async (c, _id, b, actor) => {
      const on = b.enabled === true;
      if (on) await enableLearner(db, c, actor);
      else await disableLearner(db, c, actor);
      await logActivity(db, { companyId: c, actorType: "user", actorId: actor.userId ?? "", action: on ? "tethr_learner_on" : "tethr_learner_off", entityType: "company", entityId: c, details: {} }).catch(() => {});
      return { enabled: on };
    }),
  );

  // The learner's pace and whether its skills save on their own or ask first.
  router.post(
    "/tethr/:companyId/learning/settings",
    person(async (c, _id, b, actor) => {
      if (b.pace !== undefined) await setLearningPace(db, c, parsePace(b.pace), actor);
      if (b.applyMode === "auto" || b.applyMode === "ask") await learningStore.update(c, (st) => ({ ...st, applyMode: b.applyMode as "auto" | "ask" }));
      const st = learningStore.get(c);
      await logActivity(db, { companyId: c, actorType: "user", actorId: actor.userId ?? "", action: "tethr_learner_settings", entityType: "company", entityId: c, details: { pace: st.pace ?? null, applyMode: st.applyMode ?? "auto" } }).catch(() => {});
      return { pace: st.pace ?? DEFAULT_PACE, schedule: paceSchedule(st.pace), applyMode: st.applyMode ?? "auto" };
    }),
  );

  // A person asks Sage to learn something now.
  router.post(
    "/tethr/:companyId/learning/studies",
    person(async (c, _id, b) => {
      const study = await startStudy(db, c, { trigger: "asked", topic: oneLine(b.topic, 200), depth: b.depth === "quick" ? "quick" : "deep", by: "you" });
      return { study };
    }),
  );
  router.post("/tethr/:companyId/learning/studies/:id/stop", person(async (c, id) => ({ study: await stopStudy(db, c, id) })));
  // Undo a skill a study saved: what it said before comes back, or a new one is removed.
  router.post(
    "/tethr/:companyId/learning/studies/:id/skills/:name/undo",
    person((c, id, _b, actor, params) => undoSkill(db, c, id, params.name ?? "", actor.userId ?? "a person").then((skill) => ({ skill }))),
  );

  return router;
}
