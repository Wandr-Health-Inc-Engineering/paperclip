import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { serialize, writeAtomic } from "../atomic.js";

// What tethr keeps about its memory layer (phase 25), per company, in the
// instance-dir tethr-memory.json: which store holds memory, Hermes's profile
// name, which chat turns are already in Hermes (so none is imported twice), and
// who saved each entry.

export interface Provenance {
  /** "@tethr", an agent's tag, or a person's name. */
  by: string;
  at: string;
  threadId?: string;
  runId?: string;
}

export interface CompanyMemoryState {
  /** Set by "Set up Hermes memory" (or the rollout). Absent = the built-in store. */
  hermesProfile?: string;
  /** A person turned Hermes off for this company (memory falls back to built-in). */
  hermesOff?: boolean;
  /** A random id written into the profile folder when tethr made it. The import
   * ledger below belongs to that folder: a different or missing id means the
   * profile was replaced, and the ledger starts over. */
  profileId?: string;
  /** tethr may start Hermes's background service to save conversations (default yes). */
  wakeGateway?: boolean;
  /** Entries Hermes held when it was switched off (hashes): the base for merging
   * what a person changed while it was off when it's switched on again. */
  offBase?: Partial<Record<"company" | "people", string[]>>;
  /** Notes that couldn't be moved into the active store (a switch or the Memory.md
   * migration), with why. Shown on the Memory page until a person deals with them. */
  notMoved?: Array<{ target: "company" | "people"; text: string; reason: string; at: string }>;
  /** Free-form Memory.md files already turned into entries, by absolute path. */
  migrated?: Record<string, string>;
  /** Before per-path records: the first migration's time (kept for old records). */
  migratedAt?: string;
  /** Chat run id → Hermes session id ("skipped:…" = deliberately not imported). */
  imported?: Record<string, string>;
  /** Thread id → its newest imported turn (the lineage parent of the next one). */
  lastByThread?: Record<string, string | { session: string; at: number }>;
  lastImportAt?: string;
  lastImportError?: string | null;
  /** Entry hash (entries.ts entryHash) → who saved it. */
  provenance?: Record<string, Provenance>;
}

interface FileShape {
  [companyId: string]: CompanyMemoryState;
}

function configPath(): string {
  if (process.env.TETHR_MEMORY_FILE) return process.env.TETHR_MEMORY_FILE;
  // A test that didn't pick a file never touches the real instance's record.
  if (process.env.VITEST) return path.join(os.tmpdir(), `tethr-memory-test-${process.pid}.json`);
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-memory.json");
}

function readFile(): FileShape {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as FileShape) : {};
  } catch {
    return {};
  }
}

export function getMemoryState(companyId: string): CompanyMemoryState {
  return readFile()[companyId] ?? {};
}

/** Serialized read-modify-write of one company's record (atomic write). */
export function updateMemoryState(companyId: string, fn: (s: CompanyMemoryState) => CompanyMemoryState): Promise<CompanyMemoryState> {
  const file = configPath();
  return serialize(file, async () => {
    const data = readFile();
    const next = fn({ ...(data[companyId] ?? {}) });
    data[companyId] = next;
    await writeAtomic(file, JSON.stringify(data, null, 2));
    return next;
  });
}

/** The Hermes profile memory uses for this company, or null for the built-in store. */
export function activeHermesProfile(companyId: string): string | null {
  const s = getMemoryState(companyId);
  return s.hermesProfile && !s.hermesOff ? s.hermesProfile : null;
}
