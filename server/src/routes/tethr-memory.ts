import { Router } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { logActivity } from "../services/activity-log.js";
import { memoryPath, workspaceDir } from "../tethr/assistant/workspace.js";
import {
  ensureProfile,
  findHermes,
  freeProfileName,
  HermesError,
  lockdownGaps,
  profileNameFor,
  profileExists,
  readProfileConfig,
  readProfileId,
  runHelper,
} from "../tethr/hermes/bridge.js";
import { logFailure } from "../tethr/best-effort.js";
import { MEMORY_TARGETS, MemoryOpError, validateOps, type MemoryTarget } from "../tethr/hermes/entries.js";
import { backfillIndex, drainIndex, isImported } from "../tethr/hermes/indexer.js";
import {
  changeMemory,
  copyHermesIntoBuiltin,
  deleteSkill,
  dismissNotMoved,
  MemoryChangeError,
  memorySnapshot,
  mergeBuiltinIntoHermes,
  migrateFreeformMemory,
  notMovedNotes,
  searchPast,
  SKILL_NAME_RE,
  viewSkill,
  writeMemoryCopy,
} from "../tethr/hermes/memory-layer.js";
import { getMemoryState, updateMemoryState } from "../tethr/hermes/state.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { isInstanceAdmin, requirePerson } from "./tethr-people.js";

// Phase 25: tethr's memory for the UI (Company → Settings → Memory and the
// Integrations Memory card). What's saved, with who saved it; edits by people;
// a search box that shows what recall finds; skills; and switching Hermes on
// or off (instance admins). Mounted by tethrRoutes (routes/tethr.ts).

function sendError(res: import("express").Response, err: unknown) {
  if (err instanceof MemoryOpError || err instanceof MemoryChangeError) return res.status(409).json({ error: err.message });
  if (err instanceof HermesError) return res.status(503).json({ error: err.message });
  throw err;
}

export function tethrMemoryRoutes(db: Db): Router {
  const router = Router();

  router.get("/tethr/:companyId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const state = getMemoryState(companyId);
    const profile = state.hermesProfile ?? null;
    const install = await findHermes();
    res.json({
      ...memorySnapshot(companyId),
      copyPath: memoryPath(),
      inDrive: workspaceDir().inDrive,
      hermes: {
        installed: install !== null,
        profile,
        on: Boolean(profile && !state.hermesOff),
        ready: Boolean(profile && profileExists(profile)),
        lockdownGaps: profile && profileExists(profile) ? lockdownGaps(readProfileConfig(profile)) : [],
        // Turns really in Hermes (not the ones deliberately left out).
        indexed: Object.values(state.imported ?? {}).filter(isImported).length,
        lastImportAt: state.lastImportAt ?? null,
        lastImportError: state.lastImportError ?? null,
        wakeGateway: state.wakeGateway !== false,
      },
      notMoved: notMovedNotes(companyId),
    });
  });

  /** Dismiss notes that couldn't be moved (after re-adding them by hand, or to drop them). */
  router.post("/tethr/:companyId/memory/not-moved/dismiss", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const index = req.body?.index;
    await dismissNotMoved(companyId, Number.isInteger(index) ? (index as number) : "all");
    res.json({ notMoved: notMovedNotes(companyId) });
  });

  /** Whether tethr may start Hermes's background service to save conversations. */
  router.post("/tethr/:companyId/memory/wake-gateway", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isInstanceAdmin(req)) {
      res.status(403).json({ error: "Only an instance admin can change this" });
      return;
    }
    const allowed = req.body?.allowed === true;
    await updateMemoryState(companyId, (s) => ({ ...s, wakeGateway: allowed }));
    if (allowed) void backfillIndex(db, companyId).then(() => drainIndex(db)).catch(logFailure("catching up past chats in Hermes", { companyId }));
    res.json({ wakeGateway: allowed });
  });

  router.post("/tethr/:companyId/memory/entries", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const target = req.body?.target as MemoryTarget;
    if (!MEMORY_TARGETS.includes(target)) {
      res.status(400).json({ error: 'target must be "company" or "people"' });
      return;
    }
    try {
      const ops = validateOps(req.body?.operations);
      const usage = await changeMemory(companyId, target, ops, { by: "Memory page" });
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: getActorInfo(req).actorId,
        action: "tethr_memory_edited",
        entityType: "company",
        entityId: companyId,
        details: { target, changes: ops.map((o) => o.action) },
      }).catch(() => {});
      res.json({ usage, ...memorySnapshot(companyId) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/tethr/:companyId/memory/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const q = String(req.query.q ?? "").trim().slice(0, 300);
    if (!q) {
      res.json({ hits: [] });
      return;
    }
    try {
      res.json({ hits: await searchPast(companyId, q, { sources: null, limit: 10 }) });
    } catch (err) {
      sendError(res, err);
    }
  });

  router.get("/tethr/:companyId/memory/skills/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const name = String(req.params.name);
    try {
      const skill = SKILL_NAME_RE.test(name) ? await viewSkill(companyId, name) : null;
      if (!skill) {
        res.status(404).json({ error: "No such skill" });
        return;
      }
      res.json(skill);
    } catch (err) {
      sendError(res, err);
    }
  });

  router.delete("/tethr/:companyId/memory/skills/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const name = String(req.params.name);
    try {
      if (!SKILL_NAME_RE.test(name)) throw new MemoryChangeError("No tethr skill with that name.");
      await deleteSkill(companyId, name);
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: getActorInfo(req).actorId,
        action: "tethr_skill_removed",
        entityType: "company",
        entityId: companyId,
        details: { skill: name },
      }).catch(() => {});
      res.json(memorySnapshot(companyId));
    } catch (err) {
      sendError(res, err);
    }
  });

  /** Switch Hermes memory on (creating tethr's locked-down profile) or off. */
  router.post("/tethr/:companyId/memory/hermes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!isInstanceAdmin(req)) {
      res.status(403).json({ error: "Only an instance admin can change where memory lives" });
      return;
    }
    const on = req.body?.on === true;
    if (on && !(await findHermes())) {
      res.status(409).json({ error: "Hermes isn't installed on this computer." });
      return;
    }
    let moved = 0;
    let notMoved = 0;
    if (on) {
      const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
      // Its own profile if it has one; else a new one under a name nothing else holds.
      const profile = getMemoryState(companyId).hermesProfile ?? freeProfileName(profileNameFor(company?.prefix));
      const { created } = await ensureProfile(profile);
      // Hermes has to work BEFORE memory is pointed at it: a failure here leaves everything as it was.
      try {
        await runHelper(profile, "status");
      } catch (err) {
        res.status(503).json({ error: `Hermes didn't answer, so memory stays where it is. ${err instanceof Error ? err.message : ""}`.trim() });
        return;
      }
      // As "hermes profile create" does: ask a running gateway to serve the new profile.
      if (created) await runHelper(profile, "gateway.rescan").catch(logFailure("asking Hermes to pick up tethr's profile"));
      await updateMemoryState(companyId, (s) => ({
        ...s,
        hermesProfile: profile,
        hermesOff: false,
        // A new folder holds nothing the old ledger lists.
        ...(created ? { profileId: readProfileId(profile) ?? undefined, imported: {}, lastByThread: {} } : {}),
      }));
      const merged = await mergeBuiltinIntoHermes(companyId);
      moved = merged.moved + (await migrateFreeformMemory(companyId)).moved;
      notMoved = notMovedNotes(companyId).length;
      // Past conversations go in in the background.
      void backfillIndex(db, companyId).then(() => drainIndex(db)).catch(logFailure("catching up past chats in Hermes", { companyId }));
    } else {
      await copyHermesIntoBuiltin(companyId);
      await updateMemoryState(companyId, (s) => ({ ...s, hermesOff: true }));
      await writeMemoryCopy(companyId);
    }
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: getActorInfo(req).actorId,
      action: on ? "tethr_memory_hermes_on" : "tethr_memory_hermes_off",
      entityType: "company",
      entityId: companyId,
      details: { profile: getMemoryState(companyId).hermesProfile ?? null, moved, notMoved },
    }).catch(() => {});
    res.json({ on, moved, notMoved, ...memorySnapshot(companyId) });
  });

  return router;
}
