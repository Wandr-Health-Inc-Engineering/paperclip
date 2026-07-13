import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrOutputs } from "@paperclipai/db";
import type { TethrOutputKind } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

// The shared-workspace mirror (v1, no Google API): published deliverables are
// projected as plain files into a local folder that lives inside the user's
// Google Drive desktop-sync mount ("00 Tethr"), so partners see them on every
// device. Design contract (Mark, 2026-07-13):
//   - The DB stays the system of record for outputs; the folder is a
//     write-once-per-publish PROJECTION. Humans own the folder afterward —
//     they delete/move/rename freely and nothing here breaks or resurrects
//     (mirrored state is tracked on the output row, meta.mirror, not on disk).
//   - Write-only: nothing in this module feeds folder content back to agents.
//   - Only gate-passed published outputs can reach the folder (the single live
//     call site is gating.publishToDrive; backfill filters to published rows).
//   - A publish must never fail because the mirror failed.

/** Default partner-facing taxonomy. STRICT allowlist — kinds absent here
 * (answer, agent_proposal, org_change, future kinds) never mirror, so a new
 * output kind can't silently leak into the shared folder. */
export const MIRROR_FOLDERS: Partial<Record<TethrOutputKind, string>> = {
  brief: "01 Briefs",
  document: "02 Documents",
  lead_digest: "03 Research",
  news_digest: "03 Research",
  reply_draft: "03 Research",
  blog_draft: "04 Content/Blog Drafts",
  press_release: "04 Content/Press",
  itinerary: "04 Content/Itineraries",
  ads_recommendation: "05 Ads & Analytics",
  analytics_report: "05 Ads & Analytics",
  icp_profile: "06 Strategy",
  messaging: "06 Strategy",
};

export const MIRROR_FORMATS = ["md", "pdf", "pptx", "docx"] as const;
export type MirrorFormat = (typeof MIRROR_FORMATS)[number];

/** Humans park stale files here; agents can never target it. */
const RESERVED_FOLDER = "99 archive";
const MAX_FOLDER_DEPTH = 3;
const MAX_TITLE_CHARS = 80;
const START_HERE_NAME = "00 START HERE.md";

let warnedBadDir = false;

/**
 * The mirror root, or null when the mirror is off. Env is read at call time
 * (same convention as the other tethr integrations) so the mount can come and
 * go without a restart. Under test the mirror is inert unless a test explicitly
 * opts in with TETHR_MIRROR_ALLOW_TEST=1 and a temp dir — the guard that keeps
 * every other suite from ever touching the real synced folder.
 */
export function mirrorDir(): string | null {
  if (
    (process.env.VITEST || process.env.NODE_ENV === "test") &&
    process.env.TETHR_MIRROR_ALLOW_TEST !== "1"
  ) {
    return null;
  }
  let dir = (process.env.TETHR_MIRROR_DIR ?? "").trim();
  if (!dir) return null;
  if (dir === "~" || dir.startsWith("~/")) dir = path.join(os.homedir(), dir.slice(1));
  if (!path.isAbsolute(dir) || !fs.existsSync(dir)) {
    if (!warnedBadDir) {
      warnedBadDir = true;
      logger.warn(
        { dir },
        "[tethr] TETHR_MIRROR_DIR is not an existing absolute directory — mirror off (is Google Drive mounted?)",
      );
    }
    return null;
  }
  warnedBadDir = false;
  return dir;
}

export function mirrorConfigured(): boolean {
  return mirrorDir() !== null;
}

/** Filesystem-safe file/folder name: NFC, no separators/reserved chars/control
 * chars, no leading dots (hidden/`..`), no trailing dots or spaces (Drive/
 * Windows compat), capped length. */
export function sanitizeTitleForFilename(title: string): string {
  const cleaned = title
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "")
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  return cleaned || "Untitled";
}

/**
 * Sanitize an agent's "file this under …" hint into a safe relative folder
 * path, or null if nothing survives. Each segment goes through the filename
 * sanitizer; the reserved archive folder and dot-paths are rejected outright.
 */
export function sanitizeFolderHint(hint: string | null | undefined): string | null {
  if (!hint) return null;
  const segments = String(hint)
    .split("/")
    .map((s) => sanitizeTitleForFilename(s))
    .filter((s) => s && s !== "Untitled")
    .slice(0, MAX_FOLDER_DEPTH);
  if (!segments.length) return null;
  if (segments[0].toLowerCase() === RESERVED_FOLDER) return null;
  return segments.join("/");
}

/**
 * Optional agent directives at the very top of a generated body:
 *   [file-under: 07 Competitor Analysis]
 *   [format: pdf]
 * Parsed + stripped by the worker before the output is created; the values
 * ride in output.meta and the overseer sees the destination in the approval.
 */
export function parseMirrorDirectives(body: string): {
  body: string;
  folder?: string;
  format?: MirrorFormat;
} {
  const lines = body.split("\n");
  let folder: string | undefined;
  let format: MirrorFormat | undefined;
  let consumed = 0;
  for (const line of lines.slice(0, 5)) {
    const m = line.trim().match(/^\[(file-under|format):\s*([^\]]+)\]$/i);
    if (!m) {
      if (line.trim() === "" && consumed > 0) {
        consumed += 1; // swallow the blank line after directives
        continue;
      }
      break;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "file-under") folder = value;
    else if ((MIRROR_FORMATS as readonly string[]).includes(value.toLowerCase())) {
      format = value.toLowerCase() as MirrorFormat;
    }
    consumed += 1;
  }
  return { body: lines.slice(consumed).join("\n").replace(/^\n+/, ""), folder, format };
}

function localDateStamp(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Relative target path (sans extension), or null when the kind doesn't mirror. */
export function mirrorRelPath(
  kind: TethrOutputKind,
  title: string,
  date: Date,
  folderHint?: string | null,
): string | null {
  const folder = sanitizeFolderHint(folderHint) ?? MIRROR_FOLDERS[kind] ?? null;
  if (!folder) return null;
  return `${folder}/${localDateStamp(date)} ${sanitizeTitleForFilename(title)}`;
}

export interface MirrorInput {
  outputId: string;
  kind: TethrOutputKind;
  title: string;
  body: string;
  agentTag?: string | null;
  publishedAt?: Date | null;
  /** Agent-chosen destination (meta.mirrorFolder), already overseer-visible. */
  folder?: string | null;
  /** Output format (meta.mirrorFormat); defaults to markdown. */
  format?: string | null;
}

/** The markdown projection: front matter (the `output:` uuid doubles as the
 * idempotency/ownership key) + heading + body. */
export function composeMirrorDoc(input: MirrorInput): string {
  const date = localDateStamp(input.publishedAt ?? new Date());
  return [
    "---",
    `agent: ${input.agentTag ?? "tethr"}`,
    `kind: ${input.kind}`,
    `date: ${date}`,
    `output: ${input.outputId}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body.trim(),
    "",
  ].join("\n");
}

/** Resolved path must stay under the root — belt-and-suspenders on top of the
 * sanitizers (pattern: storage/local-disk-provider resolveWithin). */
function resolveWithinRoot(root: string, rel: string): string {
  const resolved = path.resolve(root, rel);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`mirror path escapes the root: ${rel}`);
  }
  return resolved;
}

/** Same-dir dot-temp + atomic rename: Drive sync can never upload a partial
 * file at the final name, and the dot/tmp name is ignored while it exists. */
async function writeAtomic(absPath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tethr-mirror-${crypto.randomBytes(6).toString("hex")}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, absPath);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Does an existing markdown mirror file belong to this output? (Reads only the
 * front-matter head; the content never leaves this module.) */
async function ownsExistingFile(absPath: string, outputId: string): Promise<boolean> {
  try {
    const fh = await fsp.open(absPath, "r");
    try {
      const buf = Buffer.alloc(512);
      const { bytesRead } = await fh.read(buf, 0, 512, 0);
      return buf.subarray(0, bytesRead).toString("utf8").includes(`output: ${outputId}`);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export interface MirrorWriteResult {
  written: boolean;
  relPath?: string;
  format?: MirrorFormat;
  reason?: "not-configured" | "kind-unmapped";
}

/**
 * Project one published output into the shared folder. Never throws past its
 * boundary; on success records meta.mirror on the output row so a later human
 * delete is final (backfill won't resurrect).
 */
export async function mirrorPublishedOutput(db: Db, input: MirrorInput): Promise<MirrorWriteResult> {
  try {
    const root = mirrorDir();
    if (!root) return { written: false, reason: "not-configured" };
    const relBase = mirrorRelPath(input.kind, input.title, input.publishedAt ?? new Date(), input.folder);
    if (!relBase) return { written: false, reason: "kind-unmapped" };

    const requested = (input.format ?? "md").toLowerCase();
    let format: MirrorFormat = (MIRROR_FORMATS as readonly string[]).includes(requested)
      ? (requested as MirrorFormat)
      : "md";

    // Render. Non-md renderers live behind dynamic imports; any failure falls
    // back to markdown so a publish is never lost to a missing library.
    let data: string | Buffer;
    if (format === "md") {
      data = composeMirrorDoc(input);
    } else {
      try {
        const { renderMirrorFormat } = await import("./mirror-render.js");
        data = await renderMirrorFormat(format, input);
      } catch (err) {
        logger.warn(
          { format, err: err instanceof Error ? err.message : err },
          "[tethr] mirror renderer unavailable — falling back to markdown",
        );
        format = "md";
        data = composeMirrorDoc(input);
      }
    }

    // Collision policy: markdown files carry the output uuid, so a republish of
    // the SAME output overwrites its own file (latest wins; Drive keeps
    // versions) while a different output with the same date+title gets a
    // deterministic ` (<id8>)` suffix. Binary formats can't be probed, so they
    // take the suffix path whenever the plain name is occupied.
    let rel = `${relBase}.${format}`;
    let abs = resolveWithinRoot(root, rel);
    if (fs.existsSync(abs)) {
      const owns = format === "md" && (await ownsExistingFile(abs, input.outputId));
      if (!owns) {
        rel = `${relBase} (${input.outputId.slice(0, 8)}).${format}`;
        abs = resolveWithinRoot(root, rel);
      }
    }

    await writeAtomic(abs, data);

    // Track the projection on the output row (jsonb meta — no migration).
    // Read-modify-write is safe here: single process, one publish per output.
    const [row] = await db
      .select({ meta: tethrOutputs.meta })
      .from(tethrOutputs)
      .where(eq(tethrOutputs.id, input.outputId))
      .limit(1);
    if (row) {
      await db
        .update(tethrOutputs)
        .set({
          meta: {
            ...(row.meta ?? {}),
            mirror: { relPath: rel, at: new Date().toISOString(), format },
          },
        })
        .where(eq(tethrOutputs.id, input.outputId));
    }

    logger.info({ rel, format }, "[tethr] mirrored a published output to the shared folder");
    return { written: true, relPath: rel, format };
  } catch (err) {
    logger.warn({ err }, "[tethr] mirror write failed (publish unaffected)");
    return { written: false, reason: "not-configured" };
  }
}

/** One-time orientation doc for partners opening the folder cold. */
export async function ensureStartHere(): Promise<void> {
  const root = mirrorDir();
  if (!root) return;
  const abs = path.join(root, START_HERE_NAME);
  if (fs.existsSync(abs)) return;
  const doc = [
    "# 00 Tethr — the agent workspace",
    "",
    "This folder is written by Tethr, Wandr's marketing operations system.",
    "Every file here is a deliverable an agent produced AND a human approved —",
    "nothing lands here automatically without sign-off.",
    "",
    "How it works:",
    "- New files appear when an output is approved (Slack or the Tethr Queue).",
    "- Folders are organized by deliverable type (01 Briefs, 02 Documents, ...).",
    "- Feel free to move, rename, or delete anything — the system tolerates it",
    "  and keeps its own record. Park anything stale in 99 Archive.",
    "- Each markdown file starts with a small metadata block (agent, kind, date).",
    "",
    "Questions? Ask in #scout or tag @Tethr in Slack.",
    "",
  ].join("\n");
  await writeAtomic(abs, doc).catch(() => {});
}

export interface BackfillResult {
  scanned: number;
  written: number;
  skippedUpToDate: number;
  skippedUnmapped: number;
  failed: number;
}

/**
 * Project all previously-published deliverables. Filters:
 *  - status published AND driveNodeId set → real documents only (agent
 *    proposals / org changes are "published" but never wrote a doc);
 *  - meta.mirror unset (unless force) → human deletions stay deleted.
 */
export async function backfillMirror(
  db: Db,
  companyId: string,
  opts: { force?: boolean } = {},
): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, written: 0, skippedUpToDate: 0, skippedUnmapped: 0, failed: 0 };
  if (!mirrorConfigured()) return result;
  await ensureStartHere();
  const rows = await db
    .select()
    .from(tethrOutputs)
    .where(
      and(
        eq(tethrOutputs.companyId, companyId),
        eq(tethrOutputs.status, "published"),
        isNotNull(tethrOutputs.driveNodeId),
      ),
    );
  for (const row of rows) {
    result.scanned += 1;
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const kind = row.kind as TethrOutputKind;
    if (!MIRROR_FOLDERS[kind] && !sanitizeFolderHint(meta.mirrorFolder as string | undefined)) {
      result.skippedUnmapped += 1;
      continue;
    }
    if (meta.mirror && !opts.force) {
      result.skippedUpToDate += 1;
      continue;
    }
    const write = await mirrorPublishedOutput(db, {
      outputId: row.id,
      kind,
      title: row.title,
      body: row.body,
      agentTag: (meta.agentTag as string | undefined) ?? null,
      publishedAt: row.publishedAt ?? row.createdAt,
      folder: (meta.mirrorFolder as string | undefined) ?? null,
      format: (meta.mirrorFormat as string | undefined) ?? null,
    });
    if (write.written) result.written += 1;
    else result.failed += 1;
  }
  return result;
}

export interface MirrorTreeNode {
  name: string;
  kind: "folder" | "file";
  size?: number;
  modifiedAt?: string;
  children?: MirrorTreeNode[];
}

const TREE_MAX_DEPTH = 4;
const TREE_MAX_ENTRIES = 500;

/**
 * The live, stateless view of the shared folder for the UI: a fresh readdir
 * walk every call (nothing cached), so human deletes/moves/renames show up
 * immediately and can never break anything. Names/sizes/mtimes only — file
 * CONTENT is never served (write-only stays true for agents and the API).
 */
export async function mirrorTree(): Promise<{ enabled: boolean; dir?: string; tree?: MirrorTreeNode[] }> {
  const root = mirrorDir();
  if (!root) return { enabled: false };
  let budget = TREE_MAX_ENTRIES;
  async function walk(dir: string, depth: number): Promise<MirrorTreeNode[]> {
    if (depth > TREE_MAX_DEPTH || budget <= 0) return [];
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const nodes: MirrorTreeNode[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // dotfiles/temp/Drive internals
      if (budget-- <= 0) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        nodes.push({ name: e.name, kind: "folder", children: await walk(abs, depth + 1) });
      } else if (e.isFile()) {
        const st = await fsp.stat(abs).catch(() => null);
        nodes.push({
          name: e.name,
          kind: "file",
          size: st?.size,
          modifiedAt: st?.mtime?.toISOString(),
        });
      }
    }
    return nodes;
  }
  return { enabled: true, dir: root, tree: await walk(root, 1) };
}
