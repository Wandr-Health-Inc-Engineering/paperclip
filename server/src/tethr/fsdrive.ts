import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { mirrorDir, resolveWithinRoot, sanitizeTitleForFilename } from "./mirror.js";

// A generic, security-guarded file manager over a rooted directory on disk.
// Powers the human-modifiable views on the Drive page: the Google Drive-synced
// "00 Tethr" folder (root = TETHR_MIRROR_DIR) and any extra folders the user
// explicitly adds (an allowlist, each root a folder under the same Google Drive
// mount). Every op is confined to its root by resolveWithinRoot; names are
// sanitized; deletion is a soft move to "99 Archive" — never a hard delete.
//
// Agents never call any of this — it is reachable only from the UI routes. The
// mirror's write-once projection contract is untouched; these are human ops
// (the folder's owner acting through the app), which that contract explicitly
// allows.

const ARCHIVE_FOLDER = "99 Archive";
const TREE_MAX_ENTRIES = 1000;

function nowSuffix(): string {
  return crypto.randomBytes(3).toString("hex");
}

/** Normalize a caller-supplied relative path to an EXISTING item: strip leading
 * slashes and drop `.`/`..`/empty segments. Real segment names are preserved
 * verbatim (em dashes, commas, spaces) so they match files on disk — sanitizing
 * is only for NEW names (create/rename). resolveWithinRoot is the containment
 * backstop. Returns "" for the root. */
function normalizeRel(rel: string | undefined | null): string {
  return String(rel ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

export interface FsEntry {
  name: string;
  kind: "folder" | "file";
  /** Path relative to the source root (POSIX-style), e.g. "01 Briefs/x.md". */
  path: string;
  size?: number;
  modifiedAt?: string;
}

/** List one level of a rooted directory. Skips dotfiles (temp/Drive internals).
 * Folders first, then files, each alphabetical. */
export async function listFsChildren(root: string, relDir?: string): Promise<FsEntry[]> {
  const rel = normalizeRel(relDir);
  const abs = resolveWithinRoot(root, rel);
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
  );
  const out: FsEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (out.length >= TREE_MAX_ENTRIES) break;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      out.push({ name: e.name, kind: "folder", path: childRel });
    } else if (e.isFile()) {
      const st = await fsp.stat(path.join(abs, e.name)).catch(() => null);
      out.push({
        name: e.name,
        kind: "file",
        path: childRel,
        size: st?.size,
        modifiedAt: st?.mtime?.toISOString(),
      });
    }
  }
  return out;
}

/** Create a folder under `relDir` with a sanitized `name`. Returns its rel path. */
export async function fsCreateFolder(root: string, relDir: string, name: string): Promise<string> {
  const clean = sanitizeTitleForFilename(name);
  const parentRel = normalizeRel(relDir);
  const rel = parentRel ? `${parentRel}/${clean}` : clean;
  const abs = resolveWithinRoot(root, rel);
  await fsp.mkdir(abs, { recursive: true });
  return rel;
}

/** Move and/or rename `fromRel` into folder `toDirRel` (root = ""). Collision-safe:
 * appends " (2)", " (3)" … if the destination name is taken. Returns the new rel. */
export async function fsMove(
  root: string,
  fromRel: string,
  toDirRel: string,
  newName?: string,
): Promise<string> {
  const from = normalizeRel(fromRel);
  if (!from) throw new Error("nothing to move");
  const fromAbs = resolveWithinRoot(root, from);
  if (!fs.existsSync(fromAbs)) throw new Error("source not found");

  const baseName = newName ? sanitizeTitleForFilename(newName) : path.basename(from);
  const toDir = normalizeRel(toDirRel);
  // Guard: a folder cannot be moved into itself or its own subtree.
  if (fs.statSync(fromAbs).isDirectory() && (toDir === from || toDir.startsWith(`${from}/`))) {
    throw new Error("cannot move a folder into itself");
  }

  const { name, ext } = splitName(baseName);
  let candidate = baseName;
  let n = 2;
  while (fs.existsSync(resolveWithinRoot(root, toDir ? `${toDir}/${candidate}` : candidate))) {
    const destRel = toDir ? `${toDir}/${candidate}` : candidate;
    if (resolveWithinRoot(root, destRel) === fromAbs) break; // no-op rename to self
    candidate = `${name} (${n})${ext}`;
    n += 1;
  }
  const toRel = toDir ? `${toDir}/${candidate}` : candidate;
  const toAbs = resolveWithinRoot(root, toRel);
  if (toAbs === fromAbs) return from; // nothing to do
  await fsp.mkdir(path.dirname(toAbs), { recursive: true });
  await fsp.rename(fromAbs, toAbs);
  return toRel;
}

function splitName(base: string): { name: string; ext: string } {
  const ext = path.extname(base);
  return { name: ext ? base.slice(0, -ext.length) : base, ext };
}

const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".json", ".csv", ".log", ".yml", ".yaml", ".html", ".xml", ".text",
]);
const MAX_PREVIEW_BYTES = 512 * 1024;

export interface FsFileRead {
  kind: "text" | "binary" | "toolarge" | "missing";
  content?: string;
  ext?: string;
  size?: number;
}

/** Read a file for in-app preview. Text files (md/txt/json/…) come back as
 * content; binary or oversized files come back flagged so the UI points at
 * Google Drive/Finder instead. Guarded to the root; never a hard read outside. */
export async function readFsFile(root: string, rel: string): Promise<FsFileRead> {
  const abs = resolveWithinRoot(root, normalizeRel(rel));
  let st: fs.Stats;
  try {
    st = await fsp.stat(abs);
  } catch {
    return { kind: "missing" };
  }
  if (!st.isFile()) return { kind: "missing" };
  const ext = path.extname(abs).toLowerCase();
  if (!TEXT_EXTS.has(ext)) return { kind: "binary", ext, size: st.size };
  if (st.size > MAX_PREVIEW_BYTES) return { kind: "toolarge", ext, size: st.size };
  const content = await fsp.readFile(abs, "utf8");
  return { kind: "text", content, ext, size: st.size };
}

/** Soft-delete: move an item into the source's "99 Archive" folder (created on
 * demand). Recoverable; never a hard delete. Returns the archived rel path. */
export async function fsArchive(root: string, rel: string): Promise<string> {
  const from = normalizeRel(rel);
  if (!from || from === ARCHIVE_FOLDER || from.startsWith(`${ARCHIVE_FOLDER}/`)) {
    throw new Error("already archived");
  }
  await fsp.mkdir(resolveWithinRoot(root, ARCHIVE_FOLDER), { recursive: true });
  return fsMove(root, from, ARCHIVE_FOLDER);
}

// ---- The "other folders" allowlist ----------------------------------------
// Extra Google Drive folders the user explicitly adds. Stored as a small JSON
// config in the instance dir (local-machine config, like .env — no DB
// migration). Each mount must be an existing directory UNDER the same Google
// Drive mount that holds "00 Tethr" — so only Google Drive folders the user
// chooses, never arbitrary filesystem.

export interface DriveMount {
  id: string;
  label: string;
  path: string;
}

interface MountsFile {
  [companyId: string]: DriveMount[];
}

function mountsConfigPath(): string {
  // Test override so the suite never writes to the real instance config.
  if (process.env.TETHR_MOUNTS_FILE) return process.env.TETHR_MOUNTS_FILE;
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-drive-mounts.json");
}

async function readMountsFile(): Promise<MountsFile> {
  try {
    const raw = await fsp.readFile(mountsConfigPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as MountsFile) : {};
  } catch {
    return {};
  }
}

async function writeMountsFile(data: MountsFile): Promise<void> {
  const p = mountsConfigPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

/** The Google Drive "My Drive" root that contains 00 Tethr — the boundary every
 * added folder must live under. Null when the mirror isn't configured. */
export function driveMountRoot(): string | null {
  const mirror = mirrorDir();
  return mirror ? path.dirname(mirror) : null;
}

export async function listMounts(companyId: string): Promise<DriveMount[]> {
  const all = await readMountsFile();
  // Drop any whose folder has since disappeared (moved/renamed in Drive).
  return (all[companyId] ?? []).filter((m) => {
    try {
      return fs.statSync(m.path).isDirectory();
    } catch {
      return false;
    }
  });
}

export interface AddMountResult {
  ok: boolean;
  error?: string;
  mount?: DriveMount;
}

export async function addMount(companyId: string, input: { label?: string; path: string }): Promise<AddMountResult> {
  const driveRoot = driveMountRoot();
  if (!driveRoot) return { ok: false, error: "Google Drive isn't connected (TETHR_MIRROR_DIR unset)." };
  const requested = String(input.path ?? "").trim();
  if (!requested) return { ok: false, error: "Provide a folder path." };

  const abs = path.resolve(requested);
  // Must be an existing directory under the Google Drive mount, and not 00 Tethr.
  const base = path.resolve(driveRoot);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, error: "That folder isn't inside your Google Drive. Pick a folder under your Drive." };
  }
  const mirror = mirrorDir();
  if (mirror && path.resolve(mirror) === abs) {
    return { ok: false, error: "00 Tethr is already the main view." };
  }
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return { ok: false, error: "No folder exists at that path (is Google Drive synced?)." };
  }
  if (!stat.isDirectory()) return { ok: false, error: "That path isn't a folder." };

  const all = await readMountsFile();
  const list = all[companyId] ?? [];
  if (list.some((m) => path.resolve(m.path) === abs)) {
    return { ok: false, error: "That folder is already added." };
  }
  const mount: DriveMount = {
    id: crypto.randomBytes(6).toString("hex"),
    label: (input.label?.trim() || path.basename(abs)).slice(0, 80),
    path: abs,
  };
  all[companyId] = [...list, mount];
  await writeMountsFile(all);
  logger.info({ companyId, label: mount.label }, "[tethr] added a Drive folder mount");
  return { ok: true, mount };
}

export async function removeMount(companyId: string, id: string): Promise<boolean> {
  const all = await readMountsFile();
  const list = all[companyId] ?? [];
  const next = list.filter((m) => m.id !== id);
  if (next.length === list.length) return false;
  all[companyId] = next;
  await writeMountsFile(all);
  return true;
}

/** Resolve a UI `mount` param to an absolute root dir, or null if unknown.
 * "mirror" → 00 Tethr; "ext:<id>" → an added folder. */
export async function resolveMountRoot(companyId: string, mount: string): Promise<string | null> {
  if (mount === "mirror") return mirrorDir();
  const m = /^ext:(.+)$/.exec(mount);
  if (m) {
    const found = (await listMounts(companyId)).find((x) => x.id === m[1]);
    return found?.path ?? null;
  }
  return null;
}
