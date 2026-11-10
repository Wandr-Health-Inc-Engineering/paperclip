import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { panelPathFor } from "../tethr/assistant/attachments.js";
import { getAssistantRunner } from "../tethr/assistant/runner.js";
import { workspaceDir } from "../tethr/assistant/workspace.js";
import * as chats from "../tethr/chats.js";
import { isAreaId } from "../tethr/growth-map/areas.js";
import { growthMap } from "../tethr/growth-map/evidence.js";
import { setAreaHidden } from "../tethr/growth-map/store.js";
import type { GrowthMapView } from "../tethr/growth-map/map.js";
import { exploreBrief } from "../tethr/growth-map/text.js";
import { mirrorDir } from "../tethr/mirror.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { requirePerson } from "./tethr-people.js";

// Phase 26.9: the growth map for the UI. Read the map (worked out from
// evidence every time; nothing is stored but audits and links), start an audit
// of one area in the main chat ("Explore with tethr", a person's click only),
// and hide or show an area that doesn't apply. Mounted by tethrRoutes.

/** The map for the page: each audit write-up also gets where it opens in the side panel (relative to 00 Tethr). */
function forPage(view: GrowthMapView) {
  const ws = workspaceDir().dir;
  const mirror = mirrorDir();
  return {
    ...view,
    areas: view.areas.map((a) => ({
      ...a,
      lastAudit: a.lastAudit ? { ...a.lastAudit, panelPath: a.lastAudit.file ? panelPathFor(a.lastAudit.file, ws, mirror) : null } : null,
    })),
  };
}

export function tethrGrowthMapRoutes(db: Db): Router {
  const router = Router();

  router.get("/tethr/:companyId/growth-map", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(forPage(await growthMap(db, companyId)));
  });

  router.post("/tethr/:companyId/growth-map/:area/explore", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const areaId = req.params.area;
    if (!isAreaId(areaId)) {
      res.status(404).json({ error: "There's no such area on the growth map." });
      return;
    }
    const area = (await growthMap(db, companyId)).areas.find((a) => a.id === areaId)!;
    const actor = getActorInfo(req);
    const ids = await getAssistantRunner(db).send({
      companyId,
      threadId: chats.mainThreadId(companyId),
      kind: "system",
      text: exploreBrief(area),
      requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    res.json(ids);
  });

  router.post("/tethr/:companyId/growth-map/:area/hidden", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const areaId = req.params.area;
    if (!isAreaId(areaId)) {
      res.status(404).json({ error: "There's no such area on the growth map." });
      return;
    }
    const hidden = req.body?.hidden !== false;
    await setAreaHidden(companyId, areaId, hidden);
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: actor.actorId,
      action: hidden ? "tethr_growth_area_hidden" : "tethr_growth_area_shown",
      entityType: "company",
      entityId: companyId,
      details: { area: areaId },
    }).catch(() => undefined);
    res.json(forPage(await growthMap(db, companyId)));
  });

  return router;
}
