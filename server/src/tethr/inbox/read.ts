import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { OFFICE_KINDS, officeText, type OfficeKind } from "../office-text.js";

// What tethr can read of a file in its Inbox (phase 26.3): plain text, Word,
// Excel and PowerPoint (office-text.ts), and PDFs through pdftotext (first 5
// pages) when it's installed. Images and anything else: the name only.

const run = promisify(execFile);
const TEXT = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".log", ".yml", ".yaml", ".html", ".htm", ".xml", ".text"]);
export const READ_LIMITS = { bytes: 20 * 1024 * 1024, chars: 40_000, pdfPages: 5 } as const;

export interface FileText {
  /** The text tethr could read, or null when it judges by the name only. */
  text: string | null;
  how: "text" | "office" | "pdf" | "name";
}

async function pdfText(abs: string): Promise<string | null> {
  const bin = process.env.TETHR_PDFTOTEXT || "pdftotext";
  try {
    const { stdout } = await run(bin, ["-q", "-l", String(READ_LIMITS.pdfPages), "-enc", "UTF-8", abs, "-"], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch {
    return null; // not installed, or a PDF it can't read
  }
}

export async function readFileText(abs: string): Promise<FileText> {
  const stat = await fsp.stat(abs);
  if (!stat.isFile() || stat.size > READ_LIMITS.bytes) return { text: null, how: "name" };
  const ext = path.extname(abs).toLowerCase();
  const clip = (t: string) => t.replace(/\u0000/g, "").slice(0, READ_LIMITS.chars);
  if (TEXT.has(ext)) return { text: clip(await fsp.readFile(abs, "utf8")), how: "text" };
  const office = ext.slice(1) as OfficeKind;
  if (OFFICE_KINDS.includes(office)) {
    try {
      return { text: clip(officeText(office, await fsp.readFile(abs))), how: "office" };
    } catch {
      return { text: null, how: "name" };
    }
  }
  if (ext === ".pdf") {
    const text = await pdfText(abs);
    return text && text.trim() ? { text: clip(text), how: "pdf" } : { text: null, how: "name" };
  }
  return { text: null, how: "name" };
}
