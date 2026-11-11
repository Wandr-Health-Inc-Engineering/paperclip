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
import { NoteError, notesService } from "../tethr/memory/notes.js";

// Phase 25: tethr's memory for the UI (Company → Settings → Memory and the
// Integrations Memory card). What's saved, with who saved it; edits by people;
// a search box that shows what recall finds; skills; and switching Hermes on
// or off (instance admins). Mounted by tethrRoutes (routes/tethr.ts).

function sendError(res: import("express").Response, err: unknown) {
  if (err instanceof MemoryOpError || err instanceof MemoryChangeError || err instanceof NoteError) return res.status(409).json({ error: err.message });
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
      // Memory has no ceiling: how many notes are in every turn, kept, and retired, and the
      // ones in every turn as table rows (ids for pin, edit, remove).
      noteCounts: await notesService(db).counts(companyId),
      coreNotes: await notesService(db).list(companyId, { where: "core", limit: 200 }),
    });
  });

  // Every note tethr keeps: a page of them, or a search.
  router.get("/tethr/:companyId/memory/notes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const where = ["core", "kept", "retired", "all"].includes(String(req.query.where)) ? (String(req.query.where) as "core" | "kept" | "retired" | "all") : "kept";
    const q = String(req.query.q ?? "").trim().slice(0, 200);
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const svc = notesService(db);
    const notes = q
      ? (await svc.search(companyId, q, { limit, includeRetired: where === "retired" || where === "all" })).filter((n) =>
          where === "all" ? true : where === "retired" ? n.status === "retired" : where === "core" ? n.inCore : !n.inCore && n.status === "active",
        )
      : await svc.list(companyId, { where, limit, offset });
    res.json({ notes, counts: await svc.counts(companyId) });
  });

  /** A person adds, edits, pins, retires or removes a note. */
  const personNote =
    (work: (companyId: string, id: string, body: Record<string, unknown>) => Promise<unknown>, action: string) =>
    async (req: import("express").Request, res: import("express").Response) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (!requirePerson(req, res)) return;
      try {
        const out = await work(companyId, String(req.params.id ?? ""), (req.body ?? {}) as Record<string, unknown>);
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: getActorInfo(req).actorId,
          action,
          entityType: "company",
          entityId: companyId,
          details: { note: req.params.id ?? null },
        }).catch(() => {});
        res.json({ note: out, counts: await notesService(db).counts(companyId) });
      } catch (err) {
        sendError(res, err);
      }
    };
  const targetOf = (b: Record<string, unknown>): MemoryTarget => (b.target === "people" ? "people" : "company");
  router.post(
    "/tethr/:companyId/memory/notes",
    personNote(async (c, _id, b) => (await notesService(db).add(c, { target: targetOf(b), text: String(b.text ?? ""), by: "Memory page" })).note, "tethr_memory_note_added"),
  );
  router.patch(
    "/tethr/:companyId/memory/notes/:id",
    personNote(async (c, id, b) => {
      const svc = notesService(db);
      if (typeof b.pinned === "boolean") return svc.pin(c, id, b.pinned);
      return svc.patch(c, { target: targetOf(b), id, text: String(b.text ?? ""), by: "Memory page" });
    }, "tethr_memory_note_edited"),
  );
  // Sage tidies memory now: merges repeats, refreshes stale status notes (a person's note becomes a card).
  router.post("/tethr/:companyId/memory/tidy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (!requirePerson(req, res)) return;
    const { startStudy, StudyError } = await import("../tethr/learn/study.js");
    try {
      res.json({ study: await startStudy(db, companyId, { trigger: "asked", kind: "tidy", by: "you" }) });
    } catch (err) {
      if (err instanceof StudyError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });
  router.post("/tethr/:companyId/memory/notes/:id/retire", personNote((c, id) => notesService(db).retire(c, id), "tethr_memory_note_retired"));
  router.delete("/tethr/:companyId/memory/notes/:id", personNote((c, id) => notesService(db).remove(c, { target: "company", id }), "tethr_memory_note_removed"));

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
      // Through the notes table: kept for good, curated into every turn (memory/notes.ts).
      const svc = notesService(db);
      for (const op of ops) {
        if (op.action === "add") await svc.add(companyId, { target, text: op.content!, by: "Memory page" });
        else if (op.action === "patch") await svc.patch(companyId, { target, oldText: op.old_text, text: op.content!, by: "Memory page" });
        else await svc.remove(companyId, { target, oldText: op.old_text });
      }
      const usage = "";
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
    // The always-loaded set follows the notes table into whichever store is on now.
    await notesService(db).importAndCurate(companyId).catch(logFailure("curating memory after switching stores", { companyId }));
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
