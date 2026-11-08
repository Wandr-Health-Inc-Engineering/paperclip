import fsp from "node:fs/promises";
import path from "node:path";
import { writeNewFile } from "../atomic.js";
import { OFFICE_KINDS, officeText, type OfficeKind } from "../office-text.js";
import { workspaceWriteRefusal } from "./policy.js";
import { FILES_DIR } from "./workspace.js";

// Files Mark attaches to a chat message (phase 19.1). Uploads land in the
// workspace at files/uploads/<date>/<name> (so they sync to Drive like the
// files tethr makes), and the message carries one marker line per file:
//   [Attached file: files/uploads/2026-11-07/report.pdf]
// Claude reads them with its Read tool (relative to its workspace cwd); the chat
// UI strips the markers from the bubble and shows chips instead.

export const ATTACH_LIMITS = { bytes: 20 * 1024 * 1024, files: 6 };
const UPLOADS = "uploads";
const MARKER = /^\[Attached file: (files\/uploads\/[^\]\n]+)\]$/;

/** Types the chat can read: images, PDFs and text through Claude's Read tool,
 * and Word, Excel and PowerPoint through a text copy saved beside them. */
const READABLE = new Set([
  "png", "jpg", "jpeg", "gif", "webp",
  "pdf",
  "docx", "xlsx", "pptx",
  "txt", "md", "markdown", "csv", "tsv", "json", "html", "htm", "xml", "yaml", "yml", "log", "ics", "rtf",
]);

export function attachmentKind(name: string): "image" | "pdf" | "office" | "text" {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if ((OFFICE_KINDS as string[]).includes(ext)) return "office";
  return "text";
}

/** The text copy of an Office attachment sits beside it: plan.docx → plan.docx.md. */
export const textCopyName = (name: string) => `${name}.md`;

/** A safe file name for an upload, or why it can't be attached. */
export function attachmentName(original: string): { name: string } | { error: string } {
  const base = path.basename(String(original ?? "").replace(/\\/g, "/")).normalize("NFC");
  const ext = path.extname(base).slice(1).toLowerCase();
  if (!READABLE.has(ext)) {
    return { error: "tethr reads images, PDFs, Word, Excel and PowerPoint files, and text files (Markdown, CSV, JSON…). Export other files to one of those first." };
  }
  const stem = base
    .slice(0, base.length - ext.length - 1)
    .replace(/[^A-Za-z0-9 _.()+-]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return { name: `${stem || "file"}.${ext}` };
}

function dateDir(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Save an upload into the workspace. Returns its workspace-relative path. */
export async function saveAttachment(
  workspaceDir: string,
  original: string,
  data: Buffer,
  now: Date = new Date(),
): Promise<{ path: string; name: string; size: number; kind: ReturnType<typeof attachmentKind> } | { error: string }> {
  if (data.length > ATTACH_LIMITS.bytes) return { error: "That file is over 20 MB." };
  const named = attachmentName(original);
  if ("error" in named) return named;
  // Office files: read the text out first, so a file the chat couldn't use is refused now.
  const office = path.extname(named.name).slice(1).toLowerCase() as OfficeKind;
  let text: string | null = null;
  if ((OFFICE_KINDS as string[]).includes(office)) {
    try {
      text = officeText(office, data);
    } catch (err) {
      return { error: `tethr couldn't read ${named.name} (${err instanceof Error ? err.message : "not a readable file"}). Export it to PDF and attach that.` };
    }
  }
  const dir = path.join(workspaceDir, FILES_DIR, UPLOADS, dateDir(now));
  // Same rules as the chat's own writes: never a dot path or a Claude config file.
  if (workspaceWriteRefusal(path.join(dir, named.name), workspaceDir)) return { error: "That file name isn't allowed." };
  // A new file every time: two uploads with the same name (two pasted
  // screenshots, both "image.png") each keep their own copy.
  let name: string;
  try {
    name = await writeNewFile(dir, named.name, data, (abs) => !workspaceWriteRefusal(abs, workspaceDir));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't save that file." };
  }
  if (text !== null) {
    const header = `<!-- The text of ${name}, saved by tethr so the chat can read it. -->\n\n`;
    await writeNewFile(dir, textCopyName(name), header + text, (abs) => !workspaceWriteRefusal(abs, workspaceDir)).catch(() => {});
  }
  const abs = path.join(dir, name);
  return { path: path.relative(workspaceDir, abs).split(path.sep).join("/"), name, size: data.length, kind: attachmentKind(name) };
}

/** Check the attachment paths a message names: uploads that exist, at most 6. */
export async function validateAttachments(workspaceDir: string, raw: unknown): Promise<string[] | { error: string }> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return { error: "attachments must be a list" };
  if (raw.length > ATTACH_LIMITS.files) return { error: `Attach at most ${ATTACH_LIMITS.files} files to one message.` };
  const root = path.resolve(workspaceDir, FILES_DIR, UPLOADS);
  const out: string[] = [];
  for (const item of raw) {
    const rel = typeof item === "string" ? item.trim() : "";
    const abs = path.resolve(workspaceDir, rel);
    const inside = path.relative(root, abs);
    if (!rel || !MARKER.test(`[Attached file: ${rel}]`) || !inside || inside.startsWith("..") || path.isAbsolute(inside)) {
      return { error: "An attachment isn't one of your uploads." };
    }
    if (!(await exists(abs))) return { error: `${path.basename(rel)} is no longer there; attach it again.` };
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/** The message text Claude sees: Mark's words, then one marker line per file. */
export function withAttachments(text: string, files: string[]): string {
  const body = text.trim() || (files.length === 1 ? "See the attached file." : "See the attached files.");
  return files.length ? `${body}\n\n${files.map((f) => `[Attached file: ${f}]`).join("\n")}` : body;
}

/** Split a stored message into Mark's words and the files he attached. */
export function splitAttachments(requestText: string): { text: string; files: string[] } {
  const lines = requestText.split("\n");
  const files: string[] = [];
  while (lines.length) {
    const m = MARKER.exec(lines[lines.length - 1].trim());
    if (!m) break;
    files.unshift(m[1]);
    lines.pop();
  }
  return { text: files.length ? lines.join("\n").replace(/\s+$/, "") : requestText, files };
}

/** Where a workspace file shows in the chat's side panel (relative to 00 Tethr), or null. */
export function panelPathFor(rel: string, workspaceDir: string, mirrorRoot: string | null): string | null {
  if (!mirrorRoot) return null;
  const abs = path.resolve(workspaceDir, rel);
  const inside = path.relative(path.resolve(mirrorRoot), abs);
  return inside && !inside.startsWith("..") && !path.isAbsolute(inside) ? inside.split(path.sep).join("/") : null;
}
