import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseDotenv } from "dotenv";
import { resolvePaperclipEnvPath } from "../paths.js";
import { serialize, writeAtomic } from "./atomic.js";

// The Environment page (phase 19.2): read and edit the instance .env file that
// tethr loads at boot (~/.paperclip/instances/default/.env), like a hosting
// dashboard's environment variables. Values never leave this module except
// through an explicit reveal (a POST, so a web page can't pull one with a plain
// link). Saving also sets process.env, so settings read on demand (e.g.
// TYPESAFE_API_KEY) work right away; ones read at boot need a restart.

export function envFilePath(): string {
  return process.env.TETHR_ENV_FILE || resolvePaperclipEnvPath();
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const LINE_KEY = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=/;
const MAX_VALUE = 8_192;

/** Keys the server itself depends on: editable, but the UI asks first. */
export function isCoreKey(key: string): boolean {
  return /^(PAPERCLIP_|BETTER_AUTH_|DATABASE_URL$|PORT$|HOST$|NODE_ENV$)/.test(key);
}

/** Names that usually hold a secret (shown masked; everything is masked anyway). */
export function looksSecret(key: string): boolean {
  return /(KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL|PRIVATE|_SA_|AUTH)/i.test(key);
}

export interface EnvEntry {
  key: string;
  /** Has a non-empty value in the file. */
  set: boolean;
  length: number;
  secret: boolean;
  core: boolean;
  /** Spans several lines in the file: read-only here. */
  multiline: boolean;
  /** The running server uses the same value as the file. */
  active: boolean;
}

async function readText(): Promise<string> {
  try {
    return await fsp.readFile(envFilePath(), "utf8");
  } catch {
    return "";
  }
}

/** Every key in the file (in file order), with no values. */
export async function listEnv(): Promise<{ path: string; exists: boolean; entries: EnvEntry[] }> {
  const file = envFilePath();
  const text = await readText();
  const values = parseDotenv(text);
  const seen = new Set<string>();
  const entries: EnvEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE_KEY.exec(line);
    if (!m || seen.has(m[1]) || !(m[1] in values)) continue;
    seen.add(m[1]);
    const value = values[m[1]] ?? "";
    entries.push({
      key: m[1],
      set: value.length > 0,
      length: value.length,
      secret: looksSecret(m[1]),
      core: isCoreKey(m[1]),
      multiline: value.includes("\n"),
      active: (process.env[m[1]] ?? "") === value,
    });
  }
  return { path: file, exists: fs.existsSync(file), entries };
}

/** One value, for an explicit reveal. */
export async function readEnvValue(key: string): Promise<string | null> {
  if (!KEY.test(key)) return null;
  const values = parseDotenv(await readText());
  return key in values ? (values[key] ?? "") : null;
}

/** How a value is written so dotenv reads it back exactly, or why it can't be. */
export function formatEnvValue(value: string): string | { error: string } {
  if (/[\r\n\0]/.test(value)) return { error: "Values must be a single line." };
  if (value.length > MAX_VALUE) return { error: "That value is too long (over 8,000 characters)." };
  if (/^[A-Za-z0-9_\-.:/@+=,%~*!?^&]*$/.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (!value.includes('"')) return `"${value}"`;
  return { error: "A value can't contain all three kinds of quote marks." };
}

export function validEnvKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

/** Set (add or replace) one key in the file, keeping every other line as is. */
export async function setEnv(key: string, value: string): Promise<{ ok: true } | { error: string }> {
  if (!validEnvKey(key)) return { error: "Names use letters, digits and underscores, and can't start with a digit." };
  const formatted = formatEnvValue(value);
  if (typeof formatted !== "string") return formatted;
  const file = envFilePath();
  const result = await serialize(file, async () => {
    const text = await readText();
    if (parseDotenv(text)[key]?.includes("\n")) return { error: `${key} spans several lines in the file; edit it there.` };
    const lines = text ? text.split(/\r?\n/) : [];
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    let replaced = false;
    const out: string[] = [];
    for (const line of lines) {
      const m = LINE_KEY.exec(line);
      if (m && m[1] === key) {
        if (replaced) continue; // a duplicate later line would override ours: drop it
        out.push(`${key}=${formatted}`);
        replaced = true;
      } else out.push(line);
    }
    if (!replaced) out.push(`${key}=${formatted}`);
    await writeAtomic(file, `${out.join("\n")}\n`);
    await fsp.chmod(file, 0o600).catch(() => {});
    return { ok: true as const };
  });
  if ("ok" in result) process.env[key] = value;
  return result;
}

/** Remove one key from the file (and from the running server). */
export async function deleteEnv(key: string): Promise<{ ok: true } | { error: string }> {
  if (!validEnvKey(key)) return { error: "That isn't a setting name." };
  const file = envFilePath();
  const result = await serialize(file, async () => {
    const text = await readText();
    if (parseDotenv(text)[key]?.includes("\n")) return { error: `${key} spans several lines in the file; edit it there.` };
    const lines = text.split(/\r?\n/);
    const out = lines.filter((line) => LINE_KEY.exec(line)?.[1] !== key);
    if (out.length === lines.length) return { error: `${key} isn't in the file.` };
    await writeAtomic(file, out.join("\n"));
    await fsp.chmod(file, 0o600).catch(() => {});
    return { ok: true as const };
  });
  if ("ok" in result) delete process.env[key];
  return result;
}

export interface EnvSuggestion {
  key: string;
  description: string;
}

let examplePath: string | null | undefined;
function findExample(): string | null {
  if (examplePath !== undefined) return examplePath;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../../../.env.example"), path.resolve(process.cwd(), ".env.example"), path.resolve(process.cwd(), "../.env.example")];
  examplePath = candidates.find((p) => fs.existsSync(p)) ?? null;
  return examplePath;
}

/** Settings tethr knows about (from the repo's .env.example) with their notes. */
export function parseEnvExample(text: string): EnvSuggestion[] {
  const out: EnvSuggestion[] = [];
  let notes: string[] = [];
  let lastWasKey = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      notes = [];
      lastWasKey = false;
      continue;
    }
    if (line.startsWith("#")) {
      // A comment after a key starts the next key's notes; keys listed together share theirs.
      if (lastWasKey) notes = [];
      lastWasKey = false;
      const note = line.replace(/^#+\s?/, "");
      if (!/^-{3,}/.test(note)) notes.push(note);
      continue;
    }
    const m = LINE_KEY.exec(line);
    if (m && KEY.test(m[1]) && !out.some((s) => s.key === m[1])) {
      out.push({ key: m[1], description: notes.join(" ").replace(/\s+/g, " ").trim() });
    }
    lastWasKey = true;
  }
  return out;
}

export async function envSuggestions(): Promise<EnvSuggestion[]> {
  const file = findExample();
  if (!file) return [];
  try {
    return parseEnvExample(await fsp.readFile(file, "utf8"));
  } catch {
    return [];
  }
}
