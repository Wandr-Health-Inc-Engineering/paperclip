import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { DECISION_MODES, type DecisionMode } from "../tethr/decide/kinds.js";
import { DecisionSettingError, kindStats, monthlyCapUsd, setDecisionMode, setMonthlyCap, spentThisMonth } from "../tethr/decide/decide.js";
import { jevConfigured, jevHealth, jevHealthText } from "../tethr/jev.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Phase 26.2: Jev decisions on the Integrations page. Each kind's mode with its
// record (how often Jev was right, its confidence bar), the month's spend
// against the cap. Only a person changes them; Automatic has to be earned.

export function tethrDecisionRoutes(db: Db): Router {
  const router = Router();

  const view = async (companyId: string) => ({
    kinds: await kindStats(db, companyId),
    spentUsd: await spentThisMonth(db, companyId),
    capUsd: monthlyCapUsd(companyId),
    jev: jevConfigured() ? jevHealthText(await jevHealth()) : "Jev isn't set up (no TypeSafe key).",
  });

  router.get("/tethr/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await view(companyId));
  });

  router.put("/tethr/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const body = (req.body ?? {}) as { kind?: unknown; mode?: unknown; monthlyCapUsd?: unknown };
    try {
      if (typeof body.kind === "string") {
        if (!DECISION_MODES.includes(body.mode as DecisionMode)) throw new DecisionSettingError("mode is off, suggest or auto.");
        await setDecisionMode(db, companyId, body.kind, body.mode as DecisionMode);
      }
      if (body.monthlyCapUsd !== undefined) await setMonthlyCap(companyId, Number(body.monthlyCapUsd));
    } catch (err) {
      if (err instanceof DecisionSettingError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: "tethr_decisions_changed",
      entityType: "company",
      entityId: companyId,
      details: { kind: body.kind ?? null, mode: body.mode ?? null, monthlyCapUsd: body.monthlyCapUsd ?? null },
    }).catch(() => {});
    res.json(await view(companyId));
  });

  return router;
}
