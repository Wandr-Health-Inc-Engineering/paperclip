// Phase 15 — Filer, the staged file-archive engine (mirrors org-changes.ts).
//
// A "delete" in Tethr is ALWAYS a soft archive: the file moves to the store's
// archive folder ("99 Archive" in the shared 00 Tethr workspace, "/archive" in
// the internal Drive) and stays recoverable. A change is STAGED by the
// stage_file_archive tool (gated `drive_change` output, sensitivity
// "destructive" — structurally excluded from auto-approve), APPLIED here when
// a human approves it, and re-validated at apply time because the file may
// have moved between staging and approval. Nothing in this module (or anywhere
// in the flow) hard-deletes.

import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { driveService } from "./drive.js";
import { fsArchive, listFsChildren } from "./fsdrive.js";
import { mirrorDir } from "./mirror.js";

export const DRIVE_CHANGE_STORES = ["shared", "internal"] as const;
export type DriveChangeStore = (typeof DRIVE_CHANGE_STORES)[number];

/** Shared-workspace archive folder name (matches fsdrive's soft-delete dest). */
const SHARED_ARCHIVE = "99 Archive";
const INTERNAL_ARCHIVE = "/archive";
/** Bounded fuzzy-search caps for shared-store basename resolution. */
const WALK_MAX_DEPTH = 4;
const WALK_MAX_ENTRIES = 500;

export interface DriveChangeSpec {
  store: DriveChangeStore;
  /** Resolved path — shared: rel like "01 Briefs/x.md"; internal: "/scratch/x.md". */
  path: string;
  reason?: string;
}

export interface DriveChangeTarget {
  name: string;
  /** Where it is now (display form). */
  from: string;
  /** Where approval will move it (display form; collision suffix possible). */
  dest: string;
  size?: number | null;
  modifiedAt?: string | null;
}

export type ValidateDriveChangeResult =
  | { ok: true; spec: DriveChangeSpec; target: DriveChangeTarget; errors: [] }
  | { ok: false; errors: string[]; spec?: undefined; target?: undefined };

/** Strip leading slashes and dot segments; keep real names verbatim. */
function normalizeSharedRel(rel: string): string {
  return String(rel ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

/** Root-level docs and the launcher are workspace furniture — never archivable. */
function isProtectedSharedPath(rel: string): boolean {
  if (rel === SHARED_ARCHIVE || rel.startsWith(`${SHARED_ARCHIVE}/`)) return true;
  if (!rel.includes("/") && (rel.startsWith("00 ") || rel.toLowerCase().endsWith(".command"))) {
    return true;
  }
  return false;
}

/** Bounded recursive walk of the shared root for basename resolution. */
async function walkShared(root: string): Promise<Array<{ path: string; name: string }>> {
  const out: Array<{ path: string; name: string }> = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: "", depth: 0 }];
  while (queue.length && out.length < WALK_MAX_ENTRIES) {
    const { rel, depth } = queue.shift()!;
    let children;
    try {
      children = await listFsChildren(root, rel);
    } catch {
      continue;
    }
    for (const child of children) {
      if (out.length >= WALK_MAX_ENTRIES) break;
      if (child.kind === "folder") {
        if (child.name === SHARED_ARCHIVE) continue; // archived stays archived
        if (depth < WALK_MAX_DEPTH) queue.push({ rel: child.path, depth: depth + 1 });
      } else {
        out.push({ path: child.path, name: child.name });
      }
    }
  }
  return out;
}

/**
 * Validate a raw stage_file_archive input. Zero side effects. On an exact-path
 * miss in the shared store, falls back to a bounded case-insensitive basename
 * search — a UNIQUE hit resolves; multiple hits name the candidates.
 */
export async function validateDriveChange(
  db: Db,
  companyId: string,
  raw: Record<string, unknown>,
): Promise<ValidateDriveChangeResult> {
  const errors: string[] = [];
  const store = String(raw.store ?? "").trim() as DriveChangeStore;
  const rawPath = String(raw.path ?? "").trim();
  const reason = typeof raw.reason === "string" ? raw.reason.slice(0, 300) : undefined;

  if (!DRIVE_CHANGE_STORES.includes(store)) {
    return { ok: false, errors: [`store must be "shared" (00 Tethr workspace) or "internal" (Tethr's working Drive)`] };
  }
  if (!rawPath) return { ok: false, errors: ["a file path is required"] };

  if (store === "shared") {
    const root = mirrorDir();
    if (!root) {
      return { ok: false, errors: ["the shared workspace (00 Tethr) isn't connected on this machine"] };
    }
    let rel = normalizeSharedRel(rawPath);
    if (!rel) return { ok: false, errors: ["can't archive the workspace root"] };
    if (isProtectedSharedPath(rel)) {
      return { ok: false, errors: [`"${rel}" is protected (archive folder, workspace docs, and the launcher can't be archived)`] };
    }
    let st = await fsp.stat(path.resolve(root, rel)).catch(() => null);
    if (st?.isDirectory()) {
      return { ok: false, errors: [`"${rel}" is a folder — I archive one file at a time (folders stay put)`] };
    }
    if (!st) {
      // Exact miss → unique-basename resolution, names only, never content.
      const base = (rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel).toLowerCase();
      const files = await walkShared(root);
      const hits = files.filter((f) => f.name.toLowerCase() === base);
      if (hits.length === 1 && !isProtectedSharedPath(hits[0].path)) {
        rel = hits[0].path;
        st = await fsp.stat(path.resolve(root, rel)).catch(() => null);
      } else if (hits.length > 1 && hits.length <= 5) {
        return {
          ok: false,
          errors: [`"${rawPath}" matches ${hits.length} files — say which one: ${hits.map((h) => `"${h.path}"`).join(", ")}`],
        };
      } else if (hits.length > 5) {
        return { ok: false, errors: [`"${rawPath}" matches too many files — give the folder too, e.g. "01 Briefs/${rawPath}"`] };
      } else {
        return { ok: false, errors: [`no file named "${rawPath}" in the shared workspace — check the exact filename`] };
      }
    }
    if (!st) return { ok: false, errors: [`no file at "${rel}" in the shared workspace`] };
    const name = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
    return {
      ok: true,
      errors: [],
      spec: { store, path: rel, ...(reason ? { reason } : {}) },
      target: {
        name,
        from: rel,
        dest: `${SHARED_ARCHIVE}/${name}`,
        size: st.size,
        modifiedAt: st.mtime?.toISOString() ?? null,
      },
    };
  }

  // internal — Tethr's DB-backed working Drive.
  const internalPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  if (internalPath === "/" || internalPath === INTERNAL_ARCHIVE || internalPath.startsWith(`${INTERNAL_ARCHIVE}/`)) {
    return { ok: false, errors: [`"${internalPath}" is protected (the root and ${INTERNAL_ARCHIVE} can't be archived)`] };
  }
  const drive = driveService(db);
  const node = await drive.findNodeByPath(companyId, internalPath);
  if (!node) return { ok: false, errors: [`no file at "${internalPath}" in the internal Drive (drive_list shows what's there)`] };
  if (node.kind !== "file") {
    return { ok: false, errors: [`"${internalPath}" is a folder — I archive one file at a time (folders stay put)`] };
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    spec: { store, path: internalPath, ...(reason ? { reason } : {}) },
    target: {
      name: node.name,
      from: internalPath,
      dest: `${INTERNAL_ARCHIVE}/${node.name}`,
      size: node.byteSize ?? null,
      modifiedAt: node.updatedAt instanceof Date ? node.updatedAt.toISOString() : null,
    },
  };
}

/** The deterministic gated body — what the Queue/Slack approval shows. */
export function renderDriveChangeBody(spec: DriveChangeSpec, target: DriveChangeTarget): string {
  const storeLabel = spec.store === "shared" ? "shared workspace (00 Tethr)" : "internal Drive";
  const sizeLabel =
    typeof target.size === "number" && target.size >= 0
      ? target.size >= 1024
        ? `${(target.size / 1024).toFixed(1)} KB`
        : `${target.size} B`
      : null;
  const detail = [sizeLabel, target.modifiedAt ? `modified ${target.modifiedAt.slice(0, 10)}` : null]
    .filter(Boolean)
    .join(", ");
  return [
    "Archive (soft delete) — nothing is ever hard-deleted.",
    "",
    `Store:        ${storeLabel}`,
    `Will archive: ${target.from}${detail ? `  (${detail})` : ""}`,
    `Moves to:     ${target.dest}  (numbered suffix if that name is taken)`,
    ...(spec.reason ? [`Reason:       ${spec.reason}`] : []),
    "",
    "Recoverable any time — move it back out of the archive folder.",
    'Reply "approve"/"confirm" to archive, "reject"/"cancel" to keep the file.',
  ].join("\n");
}

export type ApplyDriveChangeResult =
  | { ok: true; from: string; to: string }
  | { ok: false; error: string };

/**
 * Apply an approved archive. Re-validates first — the file may have moved,
 * vanished, or become protected since staging. Never throws: a failed apply is
 * a clean `{ok:false}` so gating can close the output deterministically.
 */
export async function applyDriveChange(
  db: Db,
  input: { companyId: string; spec: DriveChangeSpec; actorTag: string },
): Promise<ApplyDriveChangeResult> {
  try {
    const validated = await validateDriveChange(db, input.companyId, { ...input.spec });
    if (!validated.ok) return { ok: false, error: validated.errors.join("; ") };
    const { spec } = validated;
    if (spec.store === "shared") {
      const root = mirrorDir();
      if (!root) return { ok: false, error: "the shared workspace isn't connected" };
      const to = await fsArchive(root, spec.path);
      return { ok: true, from: spec.path, to };
    }
    const drive = driveService(db);
    const node = await drive.findNodeByPath(input.companyId, spec.path);
    if (!node) return { ok: false, error: `no file at "${spec.path}" anymore` };
    const moved = await drive.archiveNode(input.companyId, node.id, input.actorTag);
    if (!moved) return { ok: false, error: "the file vanished while archiving" };
    return { ok: true, from: spec.path, to: moved.path };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "archive failed" };
  }
}

/** One-line summary for titles/logs: "archive: <name> (shared)". */
export function driveChangeSummary(spec: DriveChangeSpec, target: DriveChangeTarget): string {
  return `archive ${target.name} (${spec.store === "shared" ? "shared workspace" : "internal Drive"})`;
}
