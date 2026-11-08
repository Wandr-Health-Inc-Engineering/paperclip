import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, routines, routineTriggers, tethrAgentProfiles } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { logger } from "../../middleware/logger.js";
import { serialize, writeAtomic } from "../atomic.js";
import { GROWTH_WORKFLOWS } from "./growth-workflows.js";

// Phase 18 — the fresh start (Mark's call, 2026-11-07). Tethr becomes a
// chat-first assistant: one @tethr, nothing else in the way. The nine
// specialists were barely used (in the last 100 requests @tethr handled 35, the
// others 1–9 each) and the CEO sat in an error state, so they are ARCHIVED:
//
//   - each agent is PAUSED with pauseReason "archived: fresh start" — never
//     terminated (core refuses to resume a terminated agent), so it's recoverable;
//   - its routines are paused and their triggers disabled (the archiveWandrGrowth
//     pattern), plus @tethr's own "Weekly growth review" (no default briefs);
//   - every @tethr routing row pointing at one of them is stripped, so a Slack or
//     chat ask can never reach @ceo & co.
//
// Everything changed is stashed in the instance-dir `tethr-archive.json` (same
// pattern as throttle.ts; `TETHR_ARCHIVE_FILE` overrides it for tests) so
// `restoreSpecialists` can put it all back exactly. The file is also the
// run-once marker for boot: once a company has a record (archived OR restored),
// `archiveSpecialistsOnce` never touches it again. The seed functions and agent
// code stay in the repo as the parts bin.

/** Every Tethr specialist the fresh start archives (@radar/@remedy/@cgo exist only in the DB — factory-made). */
export const SPECIALIST_TAGS = [
  "@ceo",
  "@radar",
  "@remedy",
  "@cgo",
  "@rank",
  "@tank",
  "@tinkr",
  "@patch",
  "@filer",
] as const;

export const ARCHIVE_PAUSE_REASON = "archived: fresh start";

/** The one routine @tethr owns that the fresh start also pauses. */
const TETHR_ROUTINE_TITLES = GROWTH_WORKFLOWS.filter((w) => w.ownerTag === "@tethr").map((w) => w.title);

type RoutingRow = { when: string[]; to: string; description?: string };

interface StashedAgent {
  agentId: string;
  tag: string;
  status: string;
  pauseReason: string | null;
  pausedAt: string | null;
}

interface StashedRoutine {
  routineId: string;
  title: string;
  status: string;
}

interface StashedTrigger {
  triggerId: string;
  routineId: string;
  enabled: boolean;
}

interface StashedRoutingRow {
  /** Index in @tethr's routing table at the time it was removed. */
  index: number;
  row: RoutingRow;
}

export interface ArchiveRecord {
  state: "archived" | "restored";
  archivedAt: string;
  archivedBy?: string;
  restoredAt?: string;
  restoredBy?: string;
  agents: StashedAgent[];
  routines: StashedRoutine[];
  triggers: StashedTrigger[];
  routingRows: StashedRoutingRow[];
}

interface ArchiveFile {
  [companyId: string]: ArchiveRecord;
}

function archivePath(): string {
  if (process.env.TETHR_ARCHIVE_FILE) return process.env.TETHR_ARCHIVE_FILE;
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-archive.json");
}

function readArchiveFile(): ArchiveFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(archivePath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ArchiveFile) : {};
  } catch {
    return {};
  }
}

/** Atomic write (temp file + rename): a crash mid-write never leaves a
 * truncated file that reads back as "never archived". Callers hold the file's
 * serialize() queue around their read-modify-write. */
async function writeArchiveFile(data: ArchiveFile): Promise<void> {
  await writeAtomic(archivePath(), JSON.stringify(data, null, 2));
}

/** The stash for one company, or null if the fresh start never ran there. */
export function getArchiveRecord(companyId: string): ArchiveRecord | null {
  return readArchiveFile()[companyId] ?? null;
}

/** True when `TETHR_SEED_SPECIALISTS=true` — the opt-in to the old auto-seeded org. */
export function seedSpecialistsEnabled(): boolean {
  return process.env.TETHR_SEED_SPECIALISTS === "true";
}

/** An agent the fresh start archived (paused with the archive reason). */
export function isArchivedAgent(agent: { status: string; pauseReason?: string | null }): boolean {
  return agent.status === "paused" && agent.pauseReason === ARCHIVE_PAUSE_REASON;
}

export interface ArchiveResult {
  /** Tags newly archived by this call (empty on a repeat call). */
  archived: string[];
  routinesPaused: number;
  triggersDisabled: number;
  routingRowsRemoved: number;
  /** True when nothing needed changing — every specialist was already archived. */
  alreadyArchived: boolean;
}

export interface RestoreResult {
  restored: string[];
  routinesResumed: number;
  triggersEnabled: number;
  routingRowsRestored: number;
  /** False when there was no archive to restore. */
  hadArchive: boolean;
}

async function tethrProfileRow(db: Db, companyId: string) {
  const [row] = await db
    .select({ id: tethrAgentProfiles.id, agentId: tethrAgentProfiles.agentId, routingTable: tethrAgentProfiles.routingTable })
    .from(tethrAgentProfiles)
    .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")))
    .limit(1);
  return row ?? null;
}

/**
 * Archive the specialists: pause them (recoverably), pause their routines +
 * @tethr's weekly review, disable those routines' triggers, and strip @tethr's
 * routing rows to them. Idempotent — "ensure archived": a repeat call changes
 * nothing and leaves the stash alone; a specialist added since the last call is
 * archived and merged into the stash.
 */
export async function archiveSpecialists(
  db: Db,
  companyId: string,
  opts: { by?: string } = {},
): Promise<ArchiveResult> {
  return serialize(archivePath(), () => archiveUnlocked(db, companyId, opts));
}

async function archiveUnlocked(db: Db, companyId: string, opts: { by?: string }): Promise<ArchiveResult> {
  const file = readArchiveFile();
  const prior = file[companyId];
  const record: ArchiveRecord =
    prior && prior.state === "archived"
      ? prior
      : {
          state: "archived",
          archivedAt: new Date().toISOString(),
          ...(opts.by ? { archivedBy: opts.by } : {}),
          agents: [],
          routines: [],
          triggers: [],
          routingRows: [],
        };
  const now = new Date();
  const tags = [...SPECIALIST_TAGS] as string[];

  // 1. Agents → paused with the archive reason (never terminated).
  const rows = await db
    .select({ agent: agents, tag: tethrAgentProfiles.tag })
    .from(tethrAgentProfiles)
    .innerJoin(agents, eq(tethrAgentProfiles.agentId, agents.id))
    .where(and(eq(tethrAgentProfiles.companyId, companyId), inArray(tethrAgentProfiles.tag, tags)));
  const archived: string[] = [];
  const archivedIds: string[] = [];
  for (const { agent, tag } of rows) {
    // Terminated agents are gone for good; pending-approval ones never ran.
    if (agent.status === "terminated" || agent.status === "pending_approval") continue;
    archivedIds.push(agent.id);
    if (isArchivedAgent(agent)) continue;
    if (!record.agents.some((a) => a.agentId === agent.id)) {
      record.agents.push({
        agentId: agent.id,
        tag,
        status: agent.status,
        pauseReason: agent.pauseReason ?? null,
        pausedAt: agent.pausedAt ? new Date(agent.pausedAt).toISOString() : null,
      });
    }
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: ARCHIVE_PAUSE_REASON, pausedAt: now, updatedAt: now })
      .where(eq(agents.id, agent.id));
    archived.push(tag);
  }

  // 2. Routines: the archived agents' own, plus @tethr's weekly growth review.
  const tethr = await tethrProfileRow(db, companyId);
  const routineRows = await db
    .select({ id: routines.id, title: routines.title, status: routines.status, assigneeAgentId: routines.assigneeAgentId })
    .from(routines)
    .where(eq(routines.companyId, companyId));
  const targetRoutines = routineRows.filter(
    (r) =>
      (r.assigneeAgentId && archivedIds.includes(r.assigneeAgentId)) ||
      (tethr && r.assigneeAgentId === tethr.agentId && TETHR_ROUTINE_TITLES.includes(r.title)),
  );
  let routinesPaused = 0;
  for (const r of targetRoutines) {
    if (r.status === "paused") continue;
    if (!record.routines.some((s) => s.routineId === r.id)) {
      record.routines.push({ routineId: r.id, title: r.title, status: r.status });
    }
    await db
      .update(routines)
      .set({ status: "paused", updatedAt: now })
      .where(and(eq(routines.id, r.id), ne(routines.status, "paused")));
    routinesPaused++;
  }
  let triggersDisabled = 0;
  if (targetRoutines.length) {
    const triggers = await db
      .select({ id: routineTriggers.id, routineId: routineTriggers.routineId })
      .from(routineTriggers)
      .where(
        and(
          inArray(routineTriggers.routineId, targetRoutines.map((r) => r.id)),
          eq(routineTriggers.enabled, true),
        ),
      );
    for (const t of triggers) {
      if (!record.triggers.some((s) => s.triggerId === t.id)) {
        record.triggers.push({ triggerId: t.id, routineId: t.routineId, enabled: true });
      }
      await db
        .update(routineTriggers)
        .set({ enabled: false, updatedAt: now })
        .where(eq(routineTriggers.id, t.id));
      triggersDisabled++;
    }
  }

  // 3. Strip @tethr's routing rows to any specialist, so nothing routes there.
  let routingRowsRemoved = 0;
  if (tethr) {
    const table = Array.isArray(tethr.routingTable) ? (tethr.routingTable as RoutingRow[]) : [];
    const kept: RoutingRow[] = [];
    table.forEach((row, index) => {
      if (tags.includes(row.to)) {
        record.routingRows.push({ index, row });
        routingRowsRemoved++;
      } else {
        kept.push(row);
      }
    });
    if (routingRowsRemoved) {
      await db
        .update(tethrAgentProfiles)
        .set({ routingTable: kept, updatedAt: now })
        .where(eq(tethrAgentProfiles.id, tethr.id));
    }
  }

  const alreadyArchived =
    archived.length === 0 && routinesPaused === 0 && triggersDisabled === 0 && routingRowsRemoved === 0;
  // Write on the first call (the run-once marker) and whenever something changed.
  if (!alreadyArchived || !prior || prior.state !== "archived") {
    file[companyId] = record;
    await writeArchiveFile(file);
  }
  if (!alreadyArchived) {
    logger.info(
      { companyId, archived, routinesPaused, triggersDisabled, routingRowsRemoved },
      "[tethr] fresh start: archived the specialists (paused, recoverable) — only @tethr is active",
    );
  }
  return { archived, routinesPaused, triggersDisabled, routingRowsRemoved, alreadyArchived };
}

/**
 * Boot/seed entry point: archive once per company. A company that already has a
 * record — archived, or archived and later restored — is left alone, so a
 * restore survives restarts.
 */
export async function archiveSpecialistsOnce(db: Db, companyId: string): Promise<ArchiveResult | null> {
  // Check and archive inside one turn of the file's queue, so a restore (or a
  // second boot path) can't slip in between.
  return serialize(archivePath(), async () => {
    if (getArchiveRecord(companyId)) return null;
    return archiveUnlocked(db, companyId, { by: "tethr-boot" });
  });
}

/**
 * Undo the archive from the stash: prior agent statuses, routine statuses,
 * trigger enabled flags, and @tethr's routing rows (at their old positions).
 * Anything a human changed since the archive (an agent resumed by hand, a row
 * re-added) is left as it is. Marks the record "restored" so boot never
 * re-archives.
 */
export async function restoreSpecialists(
  db: Db,
  companyId: string,
  opts: { by?: string } = {},
): Promise<RestoreResult> {
  return serialize(archivePath(), () => restoreUnlocked(db, companyId, opts));
}

async function restoreUnlocked(db: Db, companyId: string, opts: { by?: string }): Promise<RestoreResult> {
  const file = readArchiveFile();
  const record = file[companyId];
  if (!record || record.state !== "archived") {
    return { restored: [], routinesResumed: 0, triggersEnabled: 0, routingRowsRestored: 0, hadArchive: false };
  }
  const now = new Date();

  const restored: string[] = [];
  for (const stashed of record.agents) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, stashed.agentId)).limit(1);
    if (!agent || !isArchivedAgent(agent)) continue;
    // A run can't still be in flight after the archive, so "running" comes back idle.
    const status = stashed.status === "running" ? "idle" : stashed.status;
    await db
      .update(agents)
      .set({
        status,
        pauseReason: stashed.pauseReason,
        pausedAt: stashed.pausedAt ? new Date(stashed.pausedAt) : null,
        updatedAt: now,
      })
      .where(eq(agents.id, agent.id));
    restored.push(stashed.tag);
  }

  let routinesResumed = 0;
  for (const stashed of record.routines) {
    const updated = await db
      .update(routines)
      .set({ status: stashed.status, updatedAt: now })
      .where(and(eq(routines.id, stashed.routineId), eq(routines.status, "paused")))
      .returning({ id: routines.id });
    routinesResumed += updated.length;
  }

  let triggersEnabled = 0;
  if (record.triggers.length) {
    const { routineService } = await import("../../services/routines.js");
    const svc = routineService(db);
    for (const stashed of record.triggers) {
      if (!stashed.enabled) continue;
      const [trigger] = await db
        .select({ id: routineTriggers.id, enabled: routineTriggers.enabled })
        .from(routineTriggers)
        .where(eq(routineTriggers.id, stashed.triggerId))
        .limit(1);
      if (!trigger || trigger.enabled) continue;
      try {
        // Through the service so a schedule trigger gets a fresh nextRunAt.
        await svc.updateTrigger(trigger.id, { enabled: true } as never, { userId: opts.by ?? "tethr-restore" });
      } catch (err) {
        logger.warn({ err, triggerId: trigger.id }, "[tethr] restore: trigger update via service failed; enabling directly");
        await db
          .update(routineTriggers)
          .set({ enabled: true, updatedAt: now })
          .where(eq(routineTriggers.id, trigger.id));
      }
      triggersEnabled++;
    }
  }

  let routingRowsRestored = 0;
  const tethr = await tethrProfileRow(db, companyId);
  if (tethr && record.routingRows.length) {
    const table = Array.isArray(tethr.routingTable) ? [...(tethr.routingTable as RoutingRow[])] : [];
    const sorted = [...record.routingRows].sort((a, b) => a.index - b.index);
    for (const { index, row } of sorted) {
      if (table.some((r) => r.to === row.to)) continue;
      table.splice(Math.min(index, table.length), 0, row);
      routingRowsRestored++;
    }
    if (routingRowsRestored) {
      await db
        .update(tethrAgentProfiles)
        .set({ routingTable: table, updatedAt: now })
        .where(eq(tethrAgentProfiles.id, tethr.id));
    }
  }

  file[companyId] = {
    state: "restored",
    archivedAt: record.archivedAt,
    ...(record.archivedBy ? { archivedBy: record.archivedBy } : {}),
    restoredAt: now.toISOString(),
    ...(opts.by ? { restoredBy: opts.by } : {}),
    agents: [],
    routines: [],
    triggers: [],
    routingRows: [],
  };
  await writeArchiveFile(file);
  logger.info(
    { companyId, restored, routinesResumed, triggersEnabled, routingRowsRestored },
    "[tethr] fresh start undone: specialists restored",
  );
  return { restored, routinesResumed, triggersEnabled, routingRowsRestored, hadArchive: true };
}
