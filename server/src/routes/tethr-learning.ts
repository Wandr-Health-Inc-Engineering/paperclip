import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { kindStats } from "../tethr/decide/decide.js";
import { MemoryChangeError } from "../tethr/hermes/memory-layer.js";
import { oneLine } from "../tethr/goals.js";
import { activeRules } from "../tethr/inbox/store.js";
import { disableLearner, enableLearner, LearnerError } from "../tethr/learn/learner.js";
import { areaName, LessonError, lessonsService } from "../tethr/learn/lessons.js";
import { learningStore } from "../tethr/learn/store.js";
import { injectionReason, needsPersonReason } from "../tethr/screen.js";
import { teamService } from "../tethr/team.js";
import { TeamInputError } from "../tethr/team-spec.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Phase 26.5-26.6: the Learning page and the lesson cards. What tethr learned
// (by area and status, where each is applied, what happened), the learner's
// switch and queue, the sources' track record, and how accurate each kind of
// Jev decision has been. Every change is a person's (agents get 403).

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
        queue: state.queue ?? [],
      },
      sources: Object.entries(state.sources ?? {})
        .map(([domain, r]) => ({ domain, ...r }))
        .sort((a, b) => b.approved + b.kept - (a.approved + a.kept))
        .slice(0, 30),
      decisions: await kindStats(db, companyId),
      filingRules: activeRules(companyId).map((r) => r.text),
    });
  });

  const person =
    (handler: (companyId: string, id: string, body: Record<string, unknown>, actor: { userId: string | null; name: string }) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!requirePerson(req, res)) return;
      const userId = getActorInfo(req).actorId ?? null;
      try {
        const out = await handler(companyId, String(req.params.id ?? ""), (req.body ?? {}) as Record<string, unknown>, { userId, name: "Learning page" });
        res.json(out ?? { ok: true });
      } catch (err) {
        if (err instanceof LessonError || err instanceof LearnerError || err instanceof TeamInputError || err instanceof MemoryChangeError) {
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

  router.post(
    "/tethr/:companyId/learning/queue",
    person(async (c, _id, b) => {
      const topic = oneLine(b.topic, 200);
      if (topic.length < 5) throw new LessonError("Give a topic to study.");
      const refused = injectionReason(topic) ?? needsPersonReason(topic);
      if (refused) throw new LessonError(`That topic can't be queued (${refused}).`);
      const s = await learningStore.update(c, (st) => ({ ...st, queue: [...(st.queue ?? []), { topic, by: "a person", at: new Date().toISOString() }].slice(-20) }));
      return { queue: s.queue ?? [] };
    }),
  );

  router.delete(
    "/tethr/:companyId/learning/queue/:id",
    person(async (c, id) => {
      const index = Number(id);
      const s = await learningStore.update(c, (st) => ({ ...st, queue: (st.queue ?? []).filter((_q, i) => i !== index) }));
      return { queue: s.queue ?? [] };
    }),
  );

  return router;
}
