import fsp from "node:fs/promises";
import path from "node:path";
import { FILES_DIR } from "./workspace.js";

// The chat tools' files/ folder: where tools read their inputs from and save
// what they make. Every path is confined to files/ and never a dot path.

/** A path the chat named ("files/x.csv", "./files/x.csv" or "x.csv") inside
 * files/, or why it isn't allowed (`label` names the input in that message). */
export function resolveInFiles(workspaceDir: string, raw: string, label = "the file"): { abs: string; rel: string } | { error: string } {
  const rel = raw.trim().replace(/^\.?\/?files\//, "");
  const root = path.resolve(workspaceDir, FILES_DIR);
  const abs = path.resolve(root, rel);
  const inside = path.relative(root, abs);
  if (!rel || !inside || inside.startsWith("..") || path.isAbsolute(inside) || inside.split(path.sep).some((p) => p.startsWith("."))) {
    return { error: `${label} must be a file in ./files/.` };
  }
  return { abs, rel: inside.split(path.sep).join("/") };
}

/** The text of a file in files/, or why it can't be read. */
export async function readTextInFiles(
  workspaceDir: string,
  raw: string,
  maxBytes: number,
  label = "the file",
): Promise<{ text: string; rel: string } | { error: string }> {
  const target = resolveInFiles(workspaceDir, raw, label);
  if ("error" in target) return target;
  let stat;
  try {
    stat = await fsp.stat(target.abs);
  } catch {
    return { error: `There's no file called ${target.rel} in ./files/.` };
  }
  if (!stat.isFile()) return { error: `${target.rel} isn't a file.` };
  if (stat.size > maxBytes) return { error: `${target.rel} is too big (over ${Math.round(maxBytes / 1_000_000)} MB).` };
  return { text: await fsp.readFile(target.abs, "utf8"), rel: target.rel };
}

/** A safe file name with the given extension, from what the chat asked for. */
export function safeFileName(raw: unknown, ext: string, fallback: string): string {
  const base = typeof raw === "string" ? path.basename(raw.trim()) : "";
  const stem = base
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9 _.()-]+/g, "-")
    .replace(/^[.\s-]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${stem || fallback}.${ext}`;
}
