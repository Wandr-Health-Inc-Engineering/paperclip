#!/usr/bin/env node
// Tethr Command Center — a local, double-clickable viewer/manager for the
// "00 Tethr" Google Drive folder. Same idea as the Wandr Social Command Center:
// a tiny local-first web app you open in the browser to read the Markdown files
// nicely and organize them (new folder, rename, move, archive) — WITHOUT opening
// the Tethr web app. It operates directly on the synced folder on disk, so what
// you see is exactly what's in Google Drive, and your changes sync back.
//
//   node server.mjs            (or double-click start.command)
//
// Zero dependencies (Node >= 20 built-ins only). Binds loopback only. Every path
// is confined to the 00 Tethr root — no traversal, names sanitized. "Delete" is a
// soft move to "99 Archive", never a hard delete (mirrors the Tethr Drive rules).

import { createServer } from "node:http";
import { readFile, readdir, stat, mkdir, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative, sep, extname, basename } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.TETHR_CC_PORT) || 4848;
const HOST = "127.0.0.1"; // loopback only — never exposed off this machine
const ARCHIVE_FOLDER = "99 Archive";
const MAX_TEXT_BYTES = 1024 * 1024; // 1MB preview cap
const TEXT_EXTS = new Set([
  ".md", ".markdown", ".txt", ".json", ".csv", ".yml", ".yaml", ".html", ".htm",
  ".css", ".js", ".ts", ".log", ".xml", ".sh", ".env",
]);

// ---- Resolve the 00 Tethr folder (matches the Tethr server's mirror dir) -----

function resolveRoot() {
  const fromEnv = process.env.TETHR_MIRROR_DIR?.trim();
  if (fromEnv) return fromEnv;
  // Fall back to the value in the Paperclip instance .env, then the known path.
  try {
    const envFile = join(homedir(), ".paperclip", "instances", "default", ".env");
    if (existsSync(envFile)) {
      const line = readFileSync(envFile, "utf8").split(/\r?\n/).find((l) => l.startsWith("TETHR_MIRROR_DIR="));
      if (line) return line.slice("TETHR_MIRROR_DIR=".length).trim();
    }
  } catch {
    // ignore
  }
  return join(
    homedir(),
    "Library/CloudStorage/GoogleDrive-contact@travelwithwandr.com/My Drive/00 Tethr",
  );
}

const ROOT = resolve(resolveRoot());

// ---- Root confinement (every path op goes through this) ----------------------

/** Resolve a client-supplied relative path and guarantee it stays under ROOT. */
function resolveWithinRoot(relPath) {
  const cleaned = String(relPath ?? "")
    .split(/[\\/]+/)
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join(sep);
  const abs = resolve(ROOT, cleaned);
  const rel = relative(ROOT, abs);
  if (rel.startsWith("..") || resolve(ROOT, rel) !== abs) {
    throw new HttpError(400, "Path escapes the 00 Tethr folder");
  }
  return abs;
}

/** Sanitize a single new name (no separators, no dotfiles, length capped). */
function sanitizeName(name) {
  const cleaned = String(name ?? "")
    .replace(/[\\/]/g, " ")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 120);
  if (!cleaned) throw new HttpError(400, "A name is required");
  return cleaned;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---- Directory walk (folders + files, dotfiles + app dir hidden) -------------

async function buildTree(absDir, relDir, depth) {
  const entries = await readdir(absDir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // hide .DS_Store etc.
    const abs = join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        kind: "folder",
        name: entry.name,
        path: rel,
        children: depth > 0 ? await buildTree(abs, rel, depth - 1) : [],
      });
    } else if (entry.isFile()) {
      let size = 0;
      let mtime = 0;
      try {
        const s = await stat(abs);
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        // ignore unreadable
      }
      nodes.push({ kind: "file", name: entry.name, path: rel, size, mtime, ext: extname(entry.name).toLowerCase() });
    }
  }
  // Folders first, then files; each alphabetized (matches the folder's own view).
  nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1));
  return nodes;
}

// ---- API handlers ------------------------------------------------------------

async function apiTree() {
  return { root: ROOT, tree: await buildTree(ROOT, "", 6) };
}

async function apiFile(relPath) {
  const abs = resolveWithinRoot(relPath);
  let s;
  try {
    s = await stat(abs);
  } catch {
    return { kind: "missing" };
  }
  if (s.isDirectory()) return { kind: "missing" };
  const ext = extname(abs).toLowerCase();
  if (!TEXT_EXTS.has(ext)) return { kind: "binary", name: basename(abs), ext };
  if (s.size > MAX_TEXT_BYTES) return { kind: "toolarge", name: basename(abs), size: s.size };
  const content = await readFile(abs, "utf8");
  return { kind: "text", name: basename(abs), ext, content, mtime: s.mtimeMs };
}

async function apiFolder(body) {
  const parent = resolveWithinRoot(body.parent ?? "");
  const name = sanitizeName(body.name);
  const target = join(parent, name);
  resolveWithinRoot(relative(ROOT, target)); // re-confine
  if (existsSync(target)) throw new HttpError(409, "A folder with that name already exists");
  await mkdir(target, { recursive: false });
  return { ok: true, path: relative(ROOT, target) };
}

async function apiRename(body) {
  const abs = resolveWithinRoot(body.path);
  if (abs === ROOT) throw new HttpError(400, "Can't rename the root");
  const name = sanitizeName(body.name);
  const target = join(dirname(abs), name);
  if (existsSync(target) && target !== abs) throw new HttpError(409, "Something with that name already exists here");
  await rename(abs, target);
  return { ok: true, path: relative(ROOT, target) };
}

async function apiMove(body) {
  const abs = resolveWithinRoot(body.path);
  const destDir = resolveWithinRoot(body.dest ?? "");
  if (abs === ROOT) throw new HttpError(400, "Can't move the root");
  const ds = await stat(destDir).catch(() => null);
  if (!ds?.isDirectory()) throw new HttpError(400, "Destination is not a folder");
  // Prevent moving a folder into itself/a descendant.
  const withinSelf = destDir === abs || destDir.startsWith(abs + sep);
  if (withinSelf) throw new HttpError(400, "Can't move a folder into itself");
  const target = join(destDir, basename(abs));
  if (existsSync(target)) throw new HttpError(409, "That name already exists in the destination");
  await rename(abs, target);
  return { ok: true, path: relative(ROOT, target) };
}

async function apiArchive(body) {
  const abs = resolveWithinRoot(body.path);
  if (abs === ROOT) throw new HttpError(400, "Can't archive the root");
  const archiveDir = join(ROOT, ARCHIVE_FOLDER);
  if (abs === archiveDir || abs.startsWith(archiveDir + sep)) throw new HttpError(400, "Already in the archive");
  await mkdir(archiveDir, { recursive: true });
  let target = join(archiveDir, basename(abs));
  if (existsSync(target)) {
    // Never clobber — suffix with a short timestamp-free counter.
    const base = basename(abs, extname(abs));
    const ext = extname(abs);
    let n = 2;
    while (existsSync(join(archiveDir, `${base} (${n})${ext}`))) n += 1;
    target = join(archiveDir, `${base} (${n})${ext}`);
  }
  await rename(abs, target);
  return { ok: true, path: relative(ROOT, target) };
}

// ---- Static file serving -----------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safe = urlPath.split(/[\\/]+/).filter((s) => s && s !== "..").join(sep);
  const file = join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const body = await readFile(file);
  res.writeHead(200, { "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream" }).end(body);
}

// ---- Request routing ---------------------------------------------------------

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const path = url.pathname;
    if (!path.startsWith("/api/")) return serveStatic(req, res);

    if (req.method === "GET" && path === "/api/tree") return sendJson(res, 200, await apiTree());
    if (req.method === "GET" && path === "/api/file") return sendJson(res, 200, await apiFile(url.searchParams.get("path")));

    if (req.method === "POST") {
      const body = await readBody(req);
      if (path === "/api/folder") return sendJson(res, 200, await apiFolder(body));
      if (path === "/api/rename") return sendJson(res, 200, await apiRename(body));
      if (path === "/api/move") return sendJson(res, 200, await apiMove(body));
      if (path === "/api/archive") return sendJson(res, 200, await apiArchive(body));
    }
    sendJson(res, 404, { error: "Unknown endpoint" });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err?.message ?? "Server error" });
  }
});

// Single-writer: if the port is taken, another instance is already running.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.log(`Tethr Command Center already running at http://${HOST}:${PORT}`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

if (!existsSync(ROOT)) {
  console.error(`00 Tethr folder not found at:\n  ${ROOT}\nSet TETHR_MIRROR_DIR to your synced folder and retry.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Tethr Command Center → http://${HOST}:${PORT}`);
  console.log(`Folder: ${ROOT}`);
});
