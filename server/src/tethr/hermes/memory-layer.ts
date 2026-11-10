import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serialize, writeAtomic } from "../atomic.js";
import { assistantHome, memoryPath } from "../assistant/workspace.js";
import { HEALTH_REFUSAL, injectionReason, personalHealthReason } from "../screen.js";
import { findHermes, HermesError, profileHome, readProfileConfig, runHelper } from "./bridge.js";
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

/** The built-in store: one folder per company (an instance can hold several). */
function builtinDir(companyId: string): string {
  const root = process.env.VITEST && !process.env.TETHR_ASSISTANT_HOME ? path.join(os.tmpdir(), `tethr-memory-builtin-${process.pid}`) : path.join(assistantHome(), "memory");
  return path.join(root, companyId);
}

const builtinFile = (companyId: string, target: MemoryTarget) => path.join(builtinDir(companyId), TARGET_FILE[target]);

function storeFile(companyId: string, target: MemoryTarget): string {
  const profile = activeHermesProfile(companyId);
  return profile ? path.join(profileHome(profile), "memories", TARGET_FILE[target]) : builtinFile(companyId, target);
}

function readEntriesAt(file: string): string[] {
  try {
    return parseEntries(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

const readEntries = (companyId: string, target: MemoryTarget) => readEntriesAt(storeFile(companyId, target));

/** How many characters each store holds. Hermes enforces its profile's own
 * limits, so those are the ones shown (the defaults if the config can't be read). */
function limitsFor(companyId: string): Record<MemoryTarget, number> {
  const profile = activeHermesProfile(companyId);
  if (!profile) return MEMORY_LIMITS;
  const config = readProfileConfig(profile);
  const read = (key: string, fallback: number) => Number(config.match(new RegExp(`^\\s*${key}:\\s*(\\d+)\\s*$`, "m"))?.[1]) || fallback;
  return { company: read("memory_char_limit", MEMORY_LIMITS.company), people: read("user_char_limit", MEMORY_LIMITS.people) };
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
  const limits = limitsFor(companyId);
  const store = (target: MemoryTarget) => {
    const entries = readEntries(companyId, target);
    return {
      entries: entries.map((text) => {
        const p = provenance[entryHash(text)];
        return {
          text,
          ...(p ? { savedBy: p.by, savedAt: p.at, ...(p.threadId ? { threadId: p.threadId } : {}), ...(p.area ? { area: p.area } : {}) } : {}),
        };
      }),
      used: usedChars(entries),
      limit: limits[target],
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
  /** Operation number (1-based) → the note a patch changed, and what it became. */
  patched_entries?: Record<string, string>;
  patched_entries_after?: Record<string, string>;
}

/** Hermes's refusal in plain words (its own text names internal checks). */
export function plainHermesRefusal(error: string | undefined): string {
  const text = (error ?? "").replace(/^Operation \d+:\s*/, "").trim();
  const pattern = text.match(/threat pattern '([^']+)'/)?.[1];
  if (pattern) {
    return `Hermes won't keep this note: it reads like an instruction, not a fact (its "${pattern.replace(/_/g, " ")}" check). Reword it as a plain fact.`;
  }
  return text || "Hermes didn't save that.";
}

/** Why a note may not be saved, or null. Every way into memory (the chat's tool,
 * the Memory page, a migration, a switch between stores) passes through here. */
function saveRefusal(content: string, backend: MemoryBackend): string | null {
  if (personalHealthReason(content)) return HEALTH_REFUSAL;
  // Hermes scans for hidden instructions itself; the built-in store checks here.
  const injected = backend === "builtin" ? injectionReason(content) : null;
  return injected ? `That reads like an instruction to tethr, not a fact to remember (${injected}).` : null;
}

/**
 * Apply changes to one store and record who made them. Returns a line for the
 * tool result. Throws MemoryChangeError when the change was refused (a person's
 * health information, hidden instructions, a bad match, or over the limit).
 * `by.at` keeps an entry's original date when it's being moved between stores.
 */
export async function changeMemory(companyId: string, target: MemoryTarget, ops: MemoryOp[], by: Omit<Provenance, "at"> & { at?: string }): Promise<string> {
  const profile = activeHermesProfile(companyId);
  const limit = limitsFor(companyId)[target];
  for (const op of ops) {
    const refusal = op.content ? saveRefusal(op.content, profile ? "hermes" : "builtin") : null;
    if (refusal) throw new MemoryChangeError(refusal);
  }
  let added: string[];
  let patched: Array<{ before: string; after: string }>;
  let usage: string;
  if (profile) {
    const reply = await runHelper<HermesMemoryReply>(profile, "memory.apply", { target: HERMES_TARGET[target], operations: ops });
    if (!reply.success) throw new MemoryChangeError(plainHermesRefusal(reply.error));
    added = ops.filter((o) => o.action === "add").map((o) => o.content!);
    patched = Object.entries(reply.patched_entries_after ?? {}).map(([op, after]) => ({ before: reply.patched_entries?.[op] ?? "", after }));
    usage = reply.usage ?? "";
  } else {
    const file = storeFile(companyId, target);
    const result = await serialize(file, async () => {
      const applied = applyOps(readEntries(companyId, target), ops, limit);
      if (applied.ok) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await writeAtomic(file, formatEntries(applied.entries));
      }
      return applied;
    });
    if (!result.ok) throw new MemoryChangeError(result.error);
    added = ops.filter((o) => o.action === "add").map((o) => o.content!);
    patched = result.patched;
    const used = usedChars(readEntries(companyId, target));
    usage = `${Math.round((used / limit) * 100)}% — ${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")} chars`;
  }
  // Who saved what, for the entries that exist now (removed ones drop out). A
  // patched note with no area given keeps the growth-map area it had, note by note.
  const { at: keptAt, ...who } = by;
  const at = keptAt ?? new Date().toISOString();
  const live = new Set(MEMORY_TARGETS.flatMap((t) => readEntries(companyId, t)).map(entryHash));
  await updateMemoryState(companyId, (s) => {
    const before = s.provenance ?? {};
    const keptArea = (text: string) => (who.area === undefined && before[entryHash(text)]?.area ? { area: before[entryHash(text)]!.area } : {});
    const merged = {
      ...before,
      ...Object.fromEntries(added.map((t) => [entryHash(t), { ...who, at }])),
      ...Object.fromEntries(patched.map((p) => [entryHash(p.after), { ...who, ...keptArea(p.before), at }])),
    };
    return { ...s, provenance: Object.fromEntries(Object.entries(merged).filter(([hash]) => live.has(hash))) };
  });
  await writeMemoryCopy(companyId);
  return usage;
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

type NotMoved = NonNullable<ReturnType<typeof getMemoryState>["notMoved"]>[number];

async function recordNotMoved(companyId: string, items: NotMoved[]): Promise<void> {
  if (!items.length) return;
  await updateMemoryState(companyId, (s) => ({ ...s, notMoved: [...(s.notMoved ?? []), ...items].slice(-200) }));
}

/** Notes waiting on the Memory page because they couldn't be moved. */
export function notMovedNotes(companyId: string): NotMoved[] {
  return getMemoryState(companyId).notMoved ?? [];
}

export async function dismissNotMoved(companyId: string, index: number | "all"): Promise<void> {
  await updateMemoryState(companyId, (s) => ({ ...s, notMoved: index === "all" ? [] : (s.notMoved ?? []).filter((_, i) => i !== index) }));
}

/**
 * Switching Hermes off (call BEFORE the switch, while Hermes is still read):
 * the built-in store becomes exactly what Hermes holds, and what Hermes held is
 * remembered as the base for merging back (mergeBuiltinIntoHermes).
 */
export async function copyHermesIntoBuiltin(companyId: string): Promise<void> {
  if (!activeHermesProfile(companyId)) return;
  const base: Partial<Record<MemoryTarget, string[]>> = {};
  for (const target of MEMORY_TARGETS) {
    const entries = readEntries(companyId, target);
    const file = builtinFile(companyId, target);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Anything already there is older than what Hermes holds: kept aside, never merged in.
    if (fs.existsSync(file)) await fsp.rename(file, `${file}.before-${stamp()}`);
    await serialize(file, () => writeAtomic(file, formatEntries(entries)));
    base[target] = entries.map(entryHash);
  }
  await updateMemoryState(companyId, (s) => ({ ...s, offBase: base }));
}

/**
 * Switching Hermes on (call AFTER the switch, once Hermes is the active store):
 * what the built-in store holds goes into Hermes.
 * - A note the built-in store has and Hermes doesn't is added (with who saved it
 *   and when).
 * - A note Hermes held at switch-off that a person has since removed or changed
 *   in the built-in store is removed from Hermes, so it doesn't come back.
 * - A note that can't be added (Hermes refuses it, or its limit is reached) is
 *   kept in the "not moved" list on the Memory page, never dropped.
 * The built-in files are kept beside the store under a dated name.
 */
export async function mergeBuiltinIntoHermes(companyId: string): Promise<{ moved: number; notMoved: number }> {
  const state = getMemoryState(companyId);
  const provenance = state.provenance ?? {}; // read once: each write below prunes it to the active store
  let moved = 0;
  const failed: NotMoved[] = [];
  for (const target of MEMORY_TARGETS) {
    const file = builtinFile(companyId, target);
    if (!fs.existsSync(file)) continue;
    const builtin = readEntriesAt(file);
    const inHermes = readEntries(companyId, target);
    const base = new Set(state.offBase?.[target] ?? []);
    for (const gone of inHermes.filter((e) => base.has(entryHash(e)) && !builtin.includes(e))) {
      await changeMemory(companyId, target, [{ action: "remove", old_text: gone }], { by: "Memory page" }).catch(() => undefined);
    }
    for (const content of builtin.filter((e) => !inHermes.includes(e))) {
      const was = provenance[entryHash(content)];
      try {
        await changeMemory(companyId, target, [{ action: "add", content }], was ?? { by: "tethr (before Hermes)" });
        moved += 1;
      } catch (err) {
        failed.push({ target, text: content, reason: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
      }
    }
    await fsp.rename(file, `${file}.moved-${stamp()}`).catch(() => {});
  }
  await recordNotMoved(companyId, failed);
  await updateMemoryState(companyId, (s) => ({ ...s, offBase: undefined }));
  return { moved, notMoved: failed.length };
}

/** Rewrite the read-only Memory.md copy in the workspace (best effort). A file
 * there that tethr didn't write (the old free-form Memory.md, not yet turned
 * into entries) is never overwritten: migrateFreeformMemory handles it first. */
export async function writeMemoryCopy(companyId: string): Promise<void> {
  if (testWithoutDirs()) return;
  try {
    const file = memoryPath();
    const existing = await fsp.readFile(file, "utf8").catch((err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? null : undefined));
    if (existing === undefined) return; // unreadable right now: leave it alone
    if (existing !== null && existing.trim() && !existing.startsWith(MEMORY_COPY_MARKER)) return;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await writeAtomic(file, renderMemoryCopy(memorySnapshot(companyId)));
  } catch {
    // Drive offline: the copy catches up on the next change
  }
}

/**
 * Turn an old free-form Memory.md into entries: once per file. The workspace
 * can sit in Drive or, when Drive isn't there, in the instance folder, so the
 * record is kept per path: a Memory.md that shows up later (Drive came back) is
 * still migrated. The original is backed up outside Drive BEFORE anything else,
 * and a note that can't be saved goes to the "not moved" list.
 */
export async function migrateFreeformMemory(companyId: string): Promise<{ moved: number }> {
  if (testWithoutDirs()) return { moved: 0 };
  const file = memoryPath();
  if (getMemoryState(companyId).migrated?.[file]) return { moved: 0 };
  let text: string | null;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return { moved: 0 }; // can't read it now: try again next time
    text = null;
  }
  let moved = 0;
  if (text !== null && text.trim() && !text.startsWith(MEMORY_COPY_MARKER)) {
    const backup = path.join(assistantHome(), "memory-backups", `Memory-${stamp()}.md`);
    await fsp.mkdir(path.dirname(backup), { recursive: true });
    await fsp.writeFile(backup, text, "utf8");
    const found = migrateFreeform(text);
    const failed: NotMoved[] = [];
    for (const target of MEMORY_TARGETS) {
      const have = new Set(readEntries(companyId, target));
      // One by one, so a note that's refused (or over the limit) doesn't block the rest.
      for (const content of found[target].filter((e) => !have.has(e))) {
        try {
          await changeMemory(companyId, target, [{ action: "add", content }], { by: "Memory.md (before entries)" });
          moved += 1;
        } catch (err) {
          failed.push({ target, text: content, reason: err instanceof Error ? err.message : String(err), at: new Date().toISOString() });
        }
      }
    }
    await recordNotMoved(companyId, failed);
    // The original is safe in the backup: the copy can take its place.
    await writeAtomic(file, renderMemoryCopy(memorySnapshot(companyId)));
  }
  await updateMemoryState(companyId, (s) => ({ ...s, migrated: { ...(s.migrated ?? {}), [file]: new Date().toISOString() } }));
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
  if (personalHealthReason(`${skill.description}\n${skill.body}`)) throw new MemoryChangeError(HEALTH_REFUSAL);
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
