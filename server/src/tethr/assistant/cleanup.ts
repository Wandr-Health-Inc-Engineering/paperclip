import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fsMove } from "../fsdrive.js";
import { mirrorDir } from "../mirror.js";
import { FILES_DIR, workspaceDir } from "./workspace.js";
import { resolveInFiles } from "./files.js";

// Phase 27 follow-up (Mark, 2026-11-10: "add capacity for tethr to delete if it
// needs to within its folder with approval, it's just gonna end up getting
// clogged"). tethr and its agents can ask to remove files from tethr's own
// files/ folder. The person approves a card; approving MOVES them out of the way
// (Drive: 00 Tethr/99 Archive/tethr files; no Drive: the workspace's archive
// folder). Nothing is erased, and nothing outside files/ can be named.

export const CLEANUP_LIMITS = { files: 20, why: 400 };
export const CLEANUP_ARCHIVE_NAME = "tethr files";

export interface CleanupSpec {
  /** Paths as the chat writes them: "files/content/draft.md". */
  files: string[];
  why: string;
}

export interface CleanupCheck {
  ok: Array<{ rel: string; size: number }>;
  problems: string[];
}

/** Check each path: a file (not a folder) inside files/ that's there now. */
export async function checkCleanup(rawPaths: unknown, ws = workspaceDir().dir): Promise<CleanupCheck> {
  const list = Array.isArray(rawPaths) ? rawPaths : [];
  const ok: CleanupCheck["ok"] = [];
  const problems: string[] = [];
  for (const raw of list) {
    const target = resolveInFiles(ws, String(raw ?? ""), `"${String(raw ?? "")}"`);
    if ("error" in target) {
      problems.push(target.error);
      continue;
    }
    const rel = `${FILES_DIR}/${target.rel}`;
    if (ok.some((f) => f.rel === rel)) continue;
    const st = await fsp.lstat(target.abs).catch(() => null);
    if (!st) problems.push(`${rel} isn't there.`);
    else if (st.isSymbolicLink()) problems.push(`${rel} is a link; only plain files can be removed.`);
    else if (st.isDirectory()) problems.push(`${rel} is a folder; name the files in it instead.`);
    else ok.push({ rel, size: st.size });
  }
  return { ok, problems };
}

/** Where removed files go, and the root moves are confined to. */
function archiveTarget(ws: string): { root: string; fromPrefix: string; toDir: string; label: string } {
  const mirror = mirrorDir();
  const inMirror = mirror && path.relative(mirror, ws) && !path.relative(mirror, ws).startsWith("..") && !path.isAbsolute(path.relative(mirror, ws));
  if (mirror && inMirror) {
    return { root: mirror, fromPrefix: path.relative(mirror, ws).split(path.sep).join("/"), toDir: `99 Archive/${CLEANUP_ARCHIVE_NAME}`, label: `00 Tethr/99 Archive/${CLEANUP_ARCHIVE_NAME}` };
  }
  return { root: ws, fromPrefix: "", toDir: "archive", label: "tethr's archive folder" };
}

/** Where approving will put the files, in words. */
export function cleanupDestination(ws = workspaceDir().dir): string {
  return archiveTarget(ws).label;
}

/** Move what's still there out of files/. Each file is checked again first. */
export async function applyCleanup(spec: CleanupSpec, ws = workspaceDir().dir): Promise<{ moved: Array<{ from: string; to: string }>; missing: string[] }> {
  const { ok, problems } = await checkCleanup(spec.files, ws);
  const target = archiveTarget(ws);
  await fsp.mkdir(path.join(target.root, target.toDir), { recursive: true });
  const moved: Array<{ from: string; to: string }> = [];
  const missing = [...problems];
  for (const file of ok) {
    const from = target.fromPrefix ? `${target.fromPrefix}/${file.rel}` : file.rel;
    try {
      if (!fs.existsSync(path.join(target.root, from))) throw new Error("gone");
      const to = await fsMove(target.root, from, target.toDir);
      moved.push({ from: file.rel, to });
    } catch {
      missing.push(`${file.rel} couldn't be moved.`);
    }
  }
  return { moved, missing };
}

/** The approval card's body: exactly which files, why, and where they'll go. Plain text. */
export function cleanupCardBody(files: Array<{ rel: string; size: number }>, why: string, dest: string): string {
  const kb = (n: number) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`);
  return [
    `Why: ${why}`,
    "",
    `Files (${files.length}):`,
    ...files.map((f) => `- ${f.rel} (${kb(f.size)})`),
    "",
    `Approving moves them to ${dest}. Nothing is erased; you can empty that folder yourself.`,
  ].join("\n");
}
