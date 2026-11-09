import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { count, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, goals, issues, projectGoals, projects, routines, tethrMemories, tethrOutputs, tethrRouteRuns } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { companyService } from "../services/companies.js";
import { serialize, writeAtomic } from "./atomic.js";
import { workspaceDir } from "./assistant/workspace.js";
import { mirrorDir } from "./mirror.js";

// The fresh-start wipe (phase 20.0, Mark's call: "wipe it completely").
// Deletes whole companies (every agent, task, routine, chat turn, output and
// memory row, via core's company remove), drops their entries from Tethr's
// instance-dir JSON stores, moves the old files in the shared "00 Tethr" Drive
// folder into "99 Archive" (moved, never deleted: the team keeps access), and
// deletes the old chat sessions' Claude Code transcripts. A database backup is
// required first (core's POST /instance/database-backups). The endpoint is
// inert unless TETHR_ALLOW_RESET=true.

export const ARCHIVE_FOLDER = "99 Archive";
/** Top-level entries of 00 Tethr that stay put. */
const KEEP_TOP = new Set([ARCHIVE_FOLDER, "tethr", "Open Tethr Command Center.command"]);
/** Inside the workspace, what moves (CLAUDE.md is regenerated, so it stays). */
const WORKSPACE_MOVES = ["files", "Memory.md"];

export interface ResetCompany {
  id: string;
  name: string;
  prefix: string | null;
  status: string;
  counts: Record<string, number>;
}

export interface ResetPlan {
  companies: ResetCompany[];
  /** Instance-dir JSON files whose entries for these companies are dropped. */
  stores: string[];
  /** Drive moves, as paths relative to 00 Tethr. */
  driveMoves: Array<{ from: string; to: string }>;
  archiveDir: string | null;
  /** Claude Code transcript folders of the chat workspace, deleted. */
  transcriptDirs: string[];
  /** Companies that stay. The Drive folder, the chat workspace (Memory.md,
   * files/) and its transcripts are shared by every company on this instance,
   * so they're only archived when no company stays. */
  keptCompanies: string[];
}

export function resetAllowed(): boolean {
  return process.env.TETHR_ALLOW_RESET === "true";
}

function storeFiles(): string[] {
  const root = resolvePaperclipInstanceRoot();
  const pick = (env: string, name: string) => process.env[env] || path.resolve(root, name);
  return [
    pick("TETHR_CHATS_FILE", "tethr-chats.json"),
    pick("TETHR_INTEGRATIONS_FILE", "tethr-integrations.json"),
    pick("TETHR_OVERSEERS_FILE", "tethr-overseers.json"),
    pick("TETHR_PAUSED_FILE", "tethr-paused.json"),
    pick("TETHR_ARCHIVE_FILE", "tethr-archive.json"),
    pick("TETHR_MOUNTS_FILE", "tethr-drive-mounts.json"),
    pick("TETHR_SETUP_FILE", "tethr-setup.json"),
    pick("TETHR_PACE_FILE", "tethr-pace.json"),
    // Phase 25: dropping a company's record unlinks its Hermes profile; the
    // profile itself (memory, conversations, skills) stays in ~/.hermes.
    pick("TETHR_MEMORY_FILE", "tethr-memory.json"),
  ];
}

/** Claude Code keeps a session's transcript under ~/.claude/projects/<cwd with
 * every non-alphanumeric character turned into "-">. */
export function transcriptDirFor(cwd: string, home = os.homedir()): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude"), "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
}

export function archiveFolderName(now: Date): string {
  return `${now.toISOString().slice(0, 7)} before fresh start`;
}

/** What a reset would do. Nothing changes. */
export async function planReset(db: Db, prefixes: string[], now = new Date()): Promise<ResetPlan> {
  const rows = await db.select().from(companies).where(inArray(companies.issuePrefix, prefixes.length ? prefixes : ["__none__"]));
  const out: ResetCompany[] = [];
  for (const c of rows) {
    const n = async (table: typeof agents | typeof issues | typeof routines | typeof tethrOutputs | typeof tethrRouteRuns | typeof tethrMemories | typeof goals) =>
      (await db.select({ n: count() }).from(table).where(eq(table.companyId, c.id)))[0]?.n ?? 0;
    out.push({
      id: c.id,
      name: c.name,
      prefix: c.issuePrefix,
      status: c.status,
      counts: {
        agents: await n(agents),
        tasks: await n(issues),
        routines: await n(routines),
        goals: await n(goals),
        outputs: await n(tethrOutputs),
        chatTurns: await n(tethrRouteRuns),
        memoryRows: await n(tethrMemories),
      },
    });
  }

  const wiped = new Set(out.map((c) => c.id));
  const kept = (await db.select({ id: companies.id, name: companies.name, prefix: companies.issuePrefix }).from(companies))
    .filter((c) => !wiped.has(c.id))
    .map((c) => `${c.prefix ?? c.id} ${c.name}`);
  const touchShared = out.length > 0 && kept.length === 0;

  const mirror = mirrorDir();
  const driveMoves: ResetPlan["driveMoves"] = [];
  let archiveDir: string | null = null;
  if (touchShared && mirror && fs.existsSync(mirror)) {
    archiveDir = path.join(ARCHIVE_FOLDER, archiveFolderName(now));
    for (const name of (await fsp.readdir(mirror)).sort()) {
      if (KEEP_TOP.has(name) || name.startsWith(".")) continue;
      driveMoves.push({ from: name, to: path.join(archiveDir, name) });
    }
    const ws = workspaceDir().dir;
    const wsRel = path.relative(mirror, ws);
    if (wsRel && !wsRel.startsWith("..")) {
      for (const name of WORKSPACE_MOVES) {
        if (fs.existsSync(path.join(ws, name))) driveMoves.push({ from: path.join(wsRel, name), to: path.join(archiveDir, wsRel, name) });
      }
    }
  }

  const transcriptDirs = touchShared ? [transcriptDirFor(workspaceDir().dir)].filter((d) => fs.existsSync(d)) : [];
  return { companies: out, stores: storeFiles().filter((f) => fs.existsSync(f)), driveMoves, archiveDir, transcriptDirs, keptCompanies: kept };
}

async function dropKeys(file: string, ids: string[]): Promise<boolean> {
  return serialize(file, async () => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(await fsp.readFile(file, "utf8")) as Record<string, unknown>;
    } catch {
      return false;
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    let changed = false;
    for (const id of ids) {
      if (id in data) {
        delete data[id];
        changed = true;
      }
    }
    if (changed) await writeAtomic(file, JSON.stringify(data, null, 2));
    return changed;
  });
}

async function moveInto(from: string, to: string): Promise<string> {
  let dest = to;
  for (let n = 2; fs.existsSync(dest); n++) dest = `${to} (${n})`;
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rename(from, dest);
  return dest;
}

export interface ResetResult {
  deletedCompanies: string[];
  storesCleaned: string[];
  moved: string[];
  transcriptsDeleted: number;
  errors: string[];
}

/** Do it. Re-plans first, so it acts on what exists now. */
export async function runReset(db: Db, prefixes: string[], now = new Date()): Promise<ResetResult> {
  const plan = await planReset(db, prefixes, now);
  const result: ResetResult = { deletedCompanies: [], storesCleaned: [], moved: [], transcriptsDeleted: 0, errors: [] };
  const svc = companyService(db);
  for (const c of plan.companies) {
    try {
      // Core's remove() deletes goals before projects, so a project that points
      // at a goal (core's own onboarding wizard makes one) blocks it. Unlink first.
      await db.delete(projectGoals).where(eq(projectGoals.companyId, c.id));
      await db.update(projects).set({ goalId: null }).where(eq(projects.companyId, c.id));
      await svc.remove(c.id);
      result.deletedCompanies.push(`${c.prefix ?? c.id} ${c.name}`);
    } catch (err) {
      result.errors.push(`couldn't delete ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ids = plan.companies.map((c) => c.id);
  for (const file of plan.stores) {
    try {
      if (await dropKeys(file, ids)) result.storesCleaned.push(path.basename(file));
    } catch (err) {
      result.errors.push(`couldn't clean ${path.basename(file)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const mirror = mirrorDir();
  if (mirror) {
    for (const m of plan.driveMoves) {
      try {
        const dest = await moveInto(path.join(mirror, m.from), path.join(mirror, m.to));
        result.moved.push(path.relative(mirror, dest));
      } catch (err) {
        result.errors.push(`couldn't move ${m.from}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const dir of plan.transcriptDirs) {
    try {
      const entries = await fsp.readdir(dir);
      await fsp.rm(dir, { recursive: true, force: true });
      result.transcriptsDeleted += entries.length;
    } catch (err) {
      result.errors.push(`couldn't delete old chat transcripts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
