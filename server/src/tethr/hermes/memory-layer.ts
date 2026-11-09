import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serialize, writeAtomic } from "../atomic.js";
import { assistantHome, memoryPath } from "../assistant/workspace.js";
import { findHermes, HermesError, profileHome, runHelper } from "./bridge.js";
import { SKILL_CATEGORY } from "./helper.js";
import {
  applyOps,
  entryHash,
  formatEntries,
  HERMES_TARGET,
  MEMORY_COPY_MARKER,
  MEMORY_LIMITS,
  MEMORY_TARGETS,
  migrateFreeform,
  parseEntries,
  renderMemoryCopy,
  TARGET_FILE,
  usedChars,
  type MemoryOp,
  type MemorySnapshot,
  type MemoryTarget,
} from "./entries.js";
import { activeHermesProfile, getMemoryState, updateMemoryState, type Provenance } from "./state.js";

// tethr's long-term memory (phase 25): one interface over two stores.
// - Hermes (when its profile is set up): the entries are Hermes's MEMORY.md and
//   USER.md in tethr's profile, written through Hermes's own store (its lock,
//   injection scan and limits); conversations are searchable (recall) and skills
//   are kept there too.
// - Built-in (no Hermes): the same entry files in the instance dir, written
//   here. No search and no skills.
// Reading entries never starts Hermes: the files are read directly.

export type MemoryBackend = "hermes" | "builtin";

export function memoryBackend(companyId: string): MemoryBackend {
  return activeHermesProfile(companyId) ? "hermes" : "builtin";
}

/** Under tests, memory files are written only where the test pointed tethr
 * (never the real instance's assistant home or workspace). */
function testWithoutDirs(): boolean {
  return Boolean(process.env.VITEST) && !(process.env.TETHR_ASSISTANT_HOME && process.env.TETHR_WORKSPACE_DIR);
}

function builtinDir(): string {
  if (process.env.VITEST && !process.env.TETHR_ASSISTANT_HOME) return path.join(os.tmpdir(), `tethr-memory-builtin-${process.pid}`);
  return path.join(assistantHome(), "memory");
}

function storeFile(companyId: string, target: MemoryTarget): string {
  const profile = activeHermesProfile(companyId);
  return path.join(profile ? path.join(profileHome(profile), "memories") : builtinDir(), TARGET_FILE[target]);
}

function readEntries(companyId: string, target: MemoryTarget): string[] {
  try {
    return parseEntries(fs.readFileSync(storeFile(companyId, target), "utf8"));
  } catch {
    return [];
  }
}

export interface SkillInfo {
  name: string;
  description: string;
}

/** tethr's skills in Hermes (none with the built-in store). Read from the
 * profile's files, so listing them never starts Hermes. */
export function listSkills(companyId: string): SkillInfo[] {
  const profile = activeHermesProfile(companyId);
  if (!profile) return [];
  const dir = path.join(profileHome(profile), "skills", SKILL_CATEGORY);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
  const out: SkillInfo[] = [];
  for (const name of names.sort()) {
    try {
      const md = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
      const description = md.match(/^---[\s\S]*?^description:\s*(.+)$[\s\S]*?^---/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
      out.push({ name, description });
    } catch {
      // not a skill folder
    }
  }
  return out.slice(0, 40);
}

export function memorySnapshot(companyId: string): MemorySnapshot {
  const provenance = getMemoryState(companyId).provenance ?? {};
  const store = (target: MemoryTarget) => {
    const entries = readEntries(companyId, target);
    return {
      entries: entries.map((text) => {
        const p = provenance[entryHash(text)];
        return { text, ...(p ? { savedBy: p.by, savedAt: p.at, ...(p.threadId ? { threadId: p.threadId } : {}) } : {}) };
      }),
      used: usedChars(entries),
      limit: MEMORY_LIMITS[target],
    };
  };
  return {
    backend: memoryBackend(companyId),
    stores: { company: store("company"), people: store("people") },
    skills: listSkills(companyId),
  };
}

export class MemoryChangeError extends Error {}

/** Hermes's reply to a memory write (see its memory_tool). */
interface HermesMemoryReply {
  success: boolean;
  error?: string;
  usage?: string;
  patched_entries_after?: Record<string, string>;
}

/**
 * Apply changes to one store and record who made them. Returns a line for the
 * tool result. Throws MemoryChangeError when the change was refused (bad
 * match, over the limit, or Hermes's injection scan).
 */
export async function changeMemory(companyId: string, target: MemoryTarget, ops: MemoryOp[], by: Omit<Provenance, "at">): Promise<string> {
  const profile = activeHermesProfile(companyId);
  let saved: string[];
  let usage: string;
  if (profile) {
    const reply = await runHelper<HermesMemoryReply>(profile, "memory.apply", { target: HERMES_TARGET[target], operations: ops });
    if (!reply.success) throw new MemoryChangeError(reply.error ?? "Hermes didn't save that.");
    saved = [...ops.filter((o) => o.action === "add").map((o) => o.content!), ...Object.values(reply.patched_entries_after ?? {})];
    usage = reply.usage ?? "";
  } else {
    const file = storeFile(companyId, target);
    const result = await serialize(file, async () => {
      const applied = applyOps(readEntries(companyId, target), ops, MEMORY_LIMITS[target]);
      if (applied.ok) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await writeAtomic(file, formatEntries(applied.entries));
      }
      return applied;
    });
    if (!result.ok) throw new MemoryChangeError(result.error);
    saved = result.changed;
    const used = usedChars(readEntries(companyId, target));
    usage = `${Math.round((used / MEMORY_LIMITS[target]) * 100)}% — ${used.toLocaleString("en-US")}/${MEMORY_LIMITS[target].toLocaleString("en-US")} chars`;
  }
  // Who saved what, for the entries that exist now (removed ones drop out).
  const at = new Date().toISOString();
  const live = new Set(MEMORY_TARGETS.flatMap((t) => readEntries(companyId, t)).map(entryHash));
  await updateMemoryState(companyId, (s) => {
    const merged = { ...(s.provenance ?? {}), ...Object.fromEntries(saved.map((t) => [entryHash(t), { ...by, at }])) };
    return { ...s, provenance: Object.fromEntries(Object.entries(merged).filter(([hash]) => live.has(hash))) };
  });
  await writeMemoryCopy(companyId);
  return usage;
}

/** When Hermes is switched off: keep what it holds in the built-in store (call
 * before the switch, while the entries are still read from Hermes). */
export async function copyHermesIntoBuiltin(companyId: string): Promise<void> {
  if (!activeHermesProfile(companyId)) return;
  for (const target of MEMORY_TARGETS) {
    const file = path.join(builtinDir(), TARGET_FILE[target]);
    let have: string[] = [];
    try {
      have = parseEntries(await fsp.readFile(file, "utf8"));
    } catch {
      have = [];
    }
    const merged = [...have, ...readEntries(companyId, target).filter((e) => !have.includes(e))];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await serialize(file, () => writeAtomic(file, formatEntries(merged)));
  }
}

/** When Hermes is switched on: move what the built-in store holds into it. */
export async function moveBuiltinIntoHermes(companyId: string): Promise<{ moved: number }> {
  let moved = 0;
  for (const target of MEMORY_TARGETS) {
    const file = path.join(builtinDir(), TARGET_FILE[target]);
    let entries: string[] = [];
    try {
      entries = parseEntries(await fsp.readFile(file, "utf8"));
    } catch {
      continue;
    }
    const have = new Set(readEntries(companyId, target));
    const provenance = getMemoryState(companyId).provenance ?? {};
    for (const content of entries.filter((e) => !have.has(e))) {
      try {
        const was = provenance[entryHash(content)];
        await changeMemory(companyId, target, [{ action: "add", content }], was ? { by: was.by, threadId: was.threadId, runId: was.runId } : { by: "tethr (before Hermes)" });
        moved += 1;
      } catch {
        // stays in the built-in file
      }
    }
    await fsp.rename(file, `${file}.moved-to-hermes`).catch(() => {});
  }
  return { moved };
}

/** Rewrite the read-only Memory.md copy in the workspace (best effort). */
export async function writeMemoryCopy(companyId: string): Promise<void> {
  if (testWithoutDirs()) return;
  try {
    const file = memoryPath();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, renderMemoryCopy(memorySnapshot(companyId)));
  } catch {
    // Drive offline: the copy catches up on the next change
  }
}

/**
 * Turn the old free-form Memory.md into entries, once per company. The old file
 * is kept in the instance dir (never in Drive) and replaced by the copy.
 */
export async function migrateFreeformMemory(companyId: string): Promise<{ moved: number }> {
  if (getMemoryState(companyId).migratedAt || testWithoutDirs()) return { moved: 0 };
  let text = "";
  try {
    text = await fsp.readFile(memoryPath(), "utf8");
  } catch {
    text = "";
  }
  let moved = 0;
  if (text && !text.startsWith(MEMORY_COPY_MARKER)) {
    const found = migrateFreeform(text);
    for (const target of MEMORY_TARGETS) {
      const have = new Set(readEntries(companyId, target));
      const add = found[target].filter((e) => !have.has(e));
      // One by one, so an entry Hermes refuses (or one over the limit) doesn't block the rest.
      for (const content of add) {
        try {
          await changeMemory(companyId, target, [{ action: "add", content }], { by: "Memory.md (before Hermes)" });
          moved += 1;
        } catch {
          // left in the backup below
        }
      }
    }
    const backup = path.join(assistantHome(), "memory-backups", `Memory-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    await fsp.mkdir(path.dirname(backup), { recursive: true });
    await fsp.writeFile(backup, text, "utf8");
  }
  await updateMemoryState(companyId, (s) => ({ ...s, migratedAt: new Date().toISOString() }));
  await writeMemoryCopy(companyId);
  return { moved };
}

// ---- recall (Hermes only) ---------------------------------------------------

export interface RecallHit {
  sessionId: string;
  title: string | null;
  source: string | null;
  startedAt: number | null;
  snippet: string | null;
  user: string;
  assistant: string;
}

interface HelperHit {
  session_id: string;
  title: string | null;
  source: string | null;
  started_at: number | null;
  snippet: string | null;
  user: string;
  assistant: string;
}

const toHit = (h: HelperHit): RecallHit => ({
  sessionId: h.session_id,
  title: h.title,
  source: h.source,
  startedAt: h.started_at,
  snippet: h.snippet,
  user: h.user,
  assistant: h.assistant,
});

function requireProfile(companyId: string): string {
  const profile = activeHermesProfile(companyId);
  if (!profile) throw new HermesError("Searching past conversations needs Hermes memory (Integrations → Memory).");
  return profile;
}

/** Search past conversations. `sources` null = every chat (tethr); an agent passes its own. */
export async function searchPast(companyId: string, query: string, opts: { sources: string[] | null; limit?: number }): Promise<RecallHit[]> {
  const profile = requireProfile(companyId);
  const res = await runHelper<{ hits: HelperHit[] }>(profile, "sessions.search", { query, sources: opts.sources, limit: opts.limit ?? 5 });
  return (res.hits ?? []).map(toHit);
}

/** One past turn and up to two before it in the same chat. */
export async function readPast(companyId: string, sessionId: string, opts: { sources: string[] | null }): Promise<RecallHit[]> {
  const profile = requireProfile(companyId);
  const res = await runHelper<{ turns: HelperHit[] }>(profile, "sessions.read", { session_id: sessionId, sources: opts.sources });
  return (res.turns ?? []).map(toHit);
}

// ---- skills (Hermes only) -----------------------------------------------------

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Hermes keeps skill descriptions this short (they're listed in every prompt). */
export const SKILL_DESCRIPTION_MAX = 60;

export async function viewSkill(companyId: string, name: string): Promise<{ name: string; description: string; content: string } | null> {
  const res = await runHelper<{ found: boolean; name?: string; description?: string; content?: string }>(requireProfile(companyId), "skills.view", { name });
  return res.found ? { name: res.name ?? name, description: res.description ?? "", content: res.content ?? "" } : null;
}

export function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n${body.trim()}\n`;
}

export async function saveSkill(companyId: string, skill: { name: string; description: string; body: string }): Promise<void> {
  const res = await runHelper<{ success: boolean; error?: string }>(requireProfile(companyId), "skills.save", {
    name: skill.name,
    content: skillMarkdown(skill.name, skill.description, skill.body),
  });
  if (!res.success) throw new MemoryChangeError(res.error ?? "Hermes didn't save that skill.");
  await writeMemoryCopy(companyId);
}

export async function deleteSkill(companyId: string, name: string): Promise<void> {
  const res = await runHelper<{ success: boolean; error?: string }>(requireProfile(companyId), "skills.delete", { name });
  if (!res.success) throw new MemoryChangeError(res.error ?? "Hermes didn't remove that skill.");
  await writeMemoryCopy(companyId);
}

// ---- status -------------------------------------------------------------------

export async function hermesInstalled(): Promise<boolean> {
  return (await findHermes()) !== null;
}
