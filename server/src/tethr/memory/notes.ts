import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { tethrMemoryNotes } from "@paperclipai/db";
import { ENTRY_DELIMITER, entryHash, oneLine, type MemoryTarget } from "../hermes/entries.js";
import { changeMemory, MemoryChangeError, memorySnapshot } from "../hermes/memory-layer.js";
import { getMemoryState } from "../hermes/state.js";
import { logFailure } from "../best-effort.js";
import { overlap } from "../learn/lessons.js";
import { HEALTH_REFUSAL, injectionReason, personalHealthReason } from "../screen.js";

// tethr's memory without a ceiling (2026-11-10). Every note lives in
// tethr_memory_notes for good, searchable with Postgres full-text search. The
// always-loaded set (Hermes's MEMORY.md / USER.md, or the built-in files) is a
// curated part of it: when it passes 85% of its size, status-like and stale
// notes move out until it's near 70% (pinned ones stay); notes that keep being
// recalled move back in. Saving never fails for space. Each turn, the notes that
// match the message are added to its prompt (relevantForTurn).

export type Note = typeof tethrMemoryNotes.$inferSelect;
export class NoteError extends Error {}

export const CORE_HIGH = 0.85;
export const CORE_LOW = 0.7;
/** A note recalled this often (and not status-like) earns its way into the always-loaded set. */
export const PROMOTE_AFTER_RECALLS = 3;
export const DUPLICATE_OVERLAP = 0.8;
export const TURN_NOTES = 6;
export const TURN_NOTE_CHARS = 1500;

/** Dates, money, ids, or words for a moment rather than a lasting fact. */
const STATUS_LIKE =
  /(\$\s?\d|\b\d{5,}\b|\b(19|20)\d\d\b|\b\d{1,2}\/\d{1,2}\b|\b(today|tomorrow|yesterday|this (week|month|quarter)|next (week|month)|currently|right now|as of|is live|went live|paused|launched|pending|in progress|on hold)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d)/i;
export const isStatusLike = (text: string): boolean => STATUS_LIKE.test(text);

const joinedLength = (texts: string[]): number => (texts.length ? texts.join(ENTRY_DELIMITER).length : 0);
const freshness = (n: Pick<Note, "updatedAt" | "lastRecalledAt">): number => Math.max(n.updatedAt.getTime(), n.lastRecalledAt?.getTime() ?? 0);

type CoreCandidate = Pick<Note, "id" | "text" | "pinned" | "inCore" | "status" | "recallCount" | "updatedAt" | "lastRecalledAt">;

/**
 * Which notes the always-loaded set should hold (pure). Keeps what's in it while
 * it fits; past `CORE_HIGH` of `limit`, moves out the least useful until it's
 * near `CORE_LOW`: never a pinned note while another can go, status-like before
 * lasting facts, the least recently saved or recalled first. With room to
 * spare, notes recalled often come back in.
 */
export function chooseCore(notes: CoreCandidate[], limit: number, prefer?: string): Set<string> {
  const active = notes.filter((n) => n.status === "active");
  const byId = new Map(active.map((n) => [n.id, n]));
  const set = new Set(active.filter((n) => n.inCore || n.pinned || n.id === prefer).map((n) => n.id));
  const size = () => joinedLength([...set].map((id) => byId.get(id)!.text));
  const low = Math.floor(limit * CORE_LOW);
  if (size() > limit * CORE_HIGH) {
    const order = [...set]
      .map((id) => byId.get(id)!)
      .sort((a, b) => Number(a.pinned) - Number(b.pinned) || Number(isStatusLike(b.text)) - Number(isStatusLike(a.text)) || freshness(a) - freshness(b));
    for (const n of order) {
      if (size() <= low) break;
      if (n.pinned && size() <= limit) break; // pinned notes go only when they alone don't fit
      set.delete(n.id);
    }
  }
  const earned = active
    .filter((n) => !set.has(n.id) && n.recallCount >= PROMOTE_AFTER_RECALLS && !isStatusLike(n.text))
    .sort((a, b) => (b.lastRecalledAt?.getTime() ?? 0) - (a.lastRecalledAt?.getTime() ?? 0));
  for (const n of earned) {
    if (joinedLength([...[...set].map((id) => byId.get(id)!.text), n.text]) > low) continue;
    set.add(n.id);
  }
  return set;
}

/** `text` with the first `part` (any case) replaced by `by`. */
export function replaceOnce(text: string, part: string, by: string): string {
  const at = text.toLowerCase().indexOf(part.toLowerCase());
  return at < 0 ? by : `${text.slice(0, at)}${by}${text.slice(at + part.length)}`;
}

/** Why a note can't be saved, or null (the same screens the always-loaded stores use). */
export function noteRefusal(text: string): string | null {
  if (!text) return "A note needs some text.";
  if (text.includes("§")) return 'A note can\'t contain "§".';
  if (personalHealthReason(text)) return HEALTH_REFUSAL;
  const injected = injectionReason(text);
  return injected ? `That reads like an instruction to tethr, not a fact to remember (${injected}).` : null;
}

export interface SaveInput {
  target: MemoryTarget;
  text: string;
  area?: string | null;
  /** "@tethr", an agent's tag, a person's name, "Memory page". */
  by: string;
  threadId?: string | null;
  runId?: string | null;
  /** An agent may change or remove only notes it saved. */
  agentTag?: string | null;
}

export interface SaveResult {
  note: Note;
  /** It matched a note that was already there (that note was updated, or left as it was). */
  duplicate: boolean;
}

/** One curation at a time per store (memory files and the table move together). */
const curating = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = curating.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  curating.set(key, next);
  void next.finally(() => {
    if (curating.get(key) === next) curating.delete(key);
  });
  return next;
}

export function notesService(db: Db) {
  const notes = tethrMemoryNotes;

  async function activeOf(companyId: string, target: MemoryTarget): Promise<Note[]> {
    return db
      .select()
      .from(notes)
      .where(and(eq(notes.companyId, companyId), eq(notes.target, target), eq(notes.status, "active")));
  }

  /**
   * The table follows the always-loaded files: a note there that the table
   * doesn't have (saved before this table, or by another way in) comes in; a
   * note the table thinks is loaded but isn't is marked as not loaded.
   */
  async function syncFromCore(companyId: string, target: MemoryTarget): Promise<void> {
    const entries = memorySnapshot(companyId).stores[target].entries;
    const rows = await activeOf(companyId, target);
    const byText = new Map(rows.map((r) => [r.text, r]));
    const provenance = getMemoryState(companyId).provenance ?? {};
    const inFile = new Set(entries.map((e) => e.text));
    for (const e of entries) {
      const row = byText.get(e.text);
      if (row) {
        if (!row.inCore) await db.update(notes).set({ inCore: true }).where(eq(notes.id, row.id));
        continue;
      }
      const p = provenance[entryHash(e.text)];
      await db.insert(notes).values({
        companyId,
        target,
        text: e.text,
        area: p?.area ?? null,
        savedBy: p?.by ?? "earlier",
        threadId: p?.threadId ?? null,
        runId: p?.runId ?? null,
        inCore: true,
        ...(p?.at ? { createdAt: new Date(p.at), updatedAt: new Date(p.at) } : {}),
      });
    }
    for (const r of rows) if (r.inCore && !inFile.has(r.text)) await db.update(notes).set({ inCore: false }).where(eq(notes.id, r.id));
  }

  /**
   * Bring the always-loaded set in line with the table: what fits, by usefulness
   * (chooseCore). Writes the difference through changeMemory (Hermes or the
   * built-in files), so Hermes's own checks still run on what enters it.
   */
  function curate(companyId: string, target: MemoryTarget, prefer?: string): Promise<void> {
    return serialized(`${companyId}:${target}`, async () => {
      await syncFromCore(companyId, target);
      const rows = await activeOf(companyId, target);
      const limit = memorySnapshot(companyId).stores[target].limit;
      const desired = chooseCore(rows, limit, prefer);
      const loaded = rows.filter((r) => r.inCore);
      const out = loaded.filter((r) => !desired.has(r.id));
      const into = rows.filter((r) => desired.has(r.id) && !r.inCore);
      if (out.length) {
        await changeMemory(companyId, target, out.map((r) => ({ action: "remove" as const, old_text: r.text })), { by: "curation" });
        for (const r of out) await db.update(notes).set({ inCore: false }).where(eq(notes.id, r.id));
      }
      for (const r of into) {
        try {
          await changeMemory(companyId, target, [{ action: "add", content: r.text }], {
            by: r.savedBy,
            at: r.createdAt.toISOString(),
            ...(r.threadId ? { threadId: r.threadId } : {}),
            ...(r.area ? { area: r.area } : {}),
          });
          await db.update(notes).set({ inCore: true }).where(eq(notes.id, r.id));
        } catch (err) {
          // It stays kept and searchable; it just isn't loaded every turn.
          if (!(err instanceof MemoryChangeError)) throw err;
        }
      }
    });
  }

  /** The active note `oldText` names: an exact match, else the one note containing it. */
  async function find(companyId: string, target: MemoryTarget, oldText: string): Promise<Note> {
    const wanted = oneLine(oldText).trim();
    const rows = await db
      .select()
      .from(notes)
      .where(and(eq(notes.companyId, companyId), eq(notes.target, target), eq(notes.status, "active"), ilike(notes.text, `%${wanted.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)))
      .limit(5);
    const exact = rows.find((r) => r.text === wanted);
    if (exact) return exact;
    if (rows.length === 1) return rows[0]!;
    throw new NoteError(rows.length ? `"${wanted.slice(0, 60)}" matches more than one note; quote more of the one you mean.` : `There's no note with "${wanted.slice(0, 60)}".`);
  }

  function mayChange(note: Note, agentTag: string | null | undefined): void {
    if (agentTag && note.savedBy !== agentTag) {
      throw new NoteError(`Tethr approval gate: blocked. ${agentTag} can change or remove only notes it saved; this one is ${note.savedBy}'s.`);
    }
  }

  /** Save a note. Never refused for space; a near-duplicate updates the note already there. */
  async function add(companyId: string, input: SaveInput): Promise<SaveResult> {
    const text = oneLine(input.text).trim();
    const refused = noteRefusal(text);
    if (refused) throw new NoteError(refused);
    // Notes that reached the memory file another way are in the table first, so they count as duplicates.
    await serialized(`${companyId}:${input.target}`, () => syncFromCore(companyId, input.target));
    const similar = await search(companyId, text, { target: input.target, limit: 8, includeCore: true });
    const twin = similar.find((n) => n.text === text || overlap(n.text, text) >= DUPLICATE_OVERLAP);
    if (twin) {
      // An agent doesn't overwrite someone else's note with its own wording.
      if (twin.text === text || (input.agentTag && twin.savedBy !== input.agentTag)) return { note: twin, duplicate: true };
      await db.update(notes).set({ text, savedBy: input.by, ...(input.area ? { area: input.area } : {}), updatedAt: new Date() }).where(eq(notes.id, twin.id));
      if (twin.inCore) await changeMemory(companyId, input.target, [{ action: "patch", old_text: twin.text, content: text }], { by: input.by }).catch(logFailure("patching a loaded note", { companyId }));
      await curate(companyId, input.target, twin.id);
      return { note: (await get(companyId, twin.id))!, duplicate: true };
    }
    const [row] = await db
      .insert(notes)
      .values({
        companyId,
        target: input.target,
        text,
        area: input.area ?? null,
        savedBy: input.by,
        threadId: input.threadId ?? null,
        runId: input.runId ?? null,
      })
      .returning();
    await curate(companyId, input.target, row!.id);
    return { note: (await get(companyId, row!.id))!, duplicate: false };
  }

  async function get(companyId: string, id: string): Promise<Note | null> {
    const [row] = await db.select().from(notes).where(and(eq(notes.companyId, companyId), eq(notes.id, id)));
    return row ?? null;
  }

  /**
   * Change a note. By id, `text` replaces it. By `oldText` (the memory tool, as
   * in Hermes): `text` replaces that part of the one note containing it, or the
   * whole note when `oldText` is all of it.
   */
  async function patch(companyId: string, input: { target: MemoryTarget; oldText?: string; id?: string; text: string; by: string; area?: string | null; agentTag?: string | null }): Promise<Note> {
    if (!input.id) await serialized(`${companyId}:${input.target}`, () => syncFromCore(companyId, input.target));
    const note = input.id ? await get(companyId, input.id) : await find(companyId, input.target, input.oldText ?? "");
    if (!note || note.status !== "active") throw new NoteError("That note isn't there any more.");
    mayChange(note, input.agentTag);
    const content = oneLine(input.text).trim();
    const wanted = oneLine(input.oldText ?? "").trim();
    const text = input.id || !wanted || note.text === wanted ? content : replaceOnce(note.text, wanted, content);
    const refused = noteRefusal(text);
    if (refused) throw new NoteError(refused);
    await db
      .update(notes)
      .set({ text, savedBy: input.by, ...(input.area !== undefined ? { area: input.area } : {}), updatedAt: new Date() })
      .where(eq(notes.id, note.id));
    if (note.inCore) {
      await changeMemory(companyId, note.target as MemoryTarget, [{ action: "patch", old_text: note.text, content: text }], {
        by: input.by,
        ...(input.area ? { area: input.area } : {}),
      });
    }
    await curate(companyId, note.target as MemoryTarget, note.id);
    return (await get(companyId, note.id))!;
  }

  /** Remove a note for good (a person or tethr asked to; curation never deletes). */
  async function remove(companyId: string, input: { target: MemoryTarget; oldText?: string; id?: string; agentTag?: string | null }): Promise<Note> {
    if (!input.id) await serialized(`${companyId}:${input.target}`, () => syncFromCore(companyId, input.target));
    const note = input.id ? await get(companyId, input.id) : await find(companyId, input.target, input.oldText ?? "");
    if (!note) throw new NoteError("That note isn't there any more.");
    mayChange(note, input.agentTag);
    if (note.inCore) await changeMemory(companyId, note.target as MemoryTarget, [{ action: "remove", old_text: note.text }], { by: "removed" });
    await db.delete(notes).where(eq(notes.id, note.id));
    await curate(companyId, note.target as MemoryTarget);
    return note;
  }

  /** Keep a note in every turn (or let curation decide again). */
  async function pin(companyId: string, id: string, pinned: boolean): Promise<Note> {
    const note = await get(companyId, id);
    if (!note || note.status !== "active") throw new NoteError("That note isn't there any more.");
    await db.update(notes).set({ pinned }).where(eq(notes.id, id));
    await curate(companyId, note.target as MemoryTarget, pinned ? id : undefined);
    return (await get(companyId, id))!;
  }

  /** No longer current: out of every turn and out of what turns are given, still searchable. */
  async function retire(companyId: string, id: string): Promise<Note> {
    const note = await get(companyId, id);
    if (!note) throw new NoteError("That note isn't there any more.");
    if (note.inCore) await changeMemory(companyId, note.target as MemoryTarget, [{ action: "remove", old_text: note.text }], { by: "retired" });
    await db.update(notes).set({ status: "retired", inCore: false, pinned: false, updatedAt: new Date() }).where(eq(notes.id, id));
    await curate(companyId, note.target as MemoryTarget);
    return (await get(companyId, id))!;
  }

  /** Notes matching `query`, best first (Postgres full-text search, any of its words; a substring when that finds nothing). */
  async function search(
    companyId: string,
    query: string,
    opts: { target?: MemoryTarget; limit?: number; includeCore?: boolean; includeRetired?: boolean; minShared?: number } = {},
  ): Promise<Array<Note & { shared: number }>> {
    const limit = Math.min(Math.max(opts.limit ?? 10, 1), 100);
    const filters = [
      sql`n.company_id = ${companyId}`,
      ...(opts.target ? [sql`n.target = ${opts.target}`] : []),
      ...(opts.includeRetired ? [] : [sql`n.status = 'active'`]),
      ...(opts.includeCore === false ? [sql`n.in_core = false`] : []),
    ];
    // Any of the query's words (stemmed, stop words dropped), ranked by how many a note shares.
    const rows = (await db.execute(sql`
      with q as (select tsvector_to_array(to_tsvector('english', ${query})) as lex),
           t as (select q.lex, (select string_agg(quote_literal(l), ' | ') from unnest(q.lex) l)::tsquery as tq from q)
      select n.id,
             (select count(*)::int from unnest(tsvector_to_array(n.search)) w where w = any(t.lex)) as shared,
             ts_rank(n.search, t.tq) as rank
      from tethr_memory_notes n, t
      where ${sql.join(filters, sql` and `)}
        and cardinality(t.lex) > 0
        and n.search @@ t.tq
      order by shared desc, rank desc, n.updated_at desc
      limit ${limit}
    `)) as unknown as Array<{ id: string; shared: number }> | { rows: Array<{ id: string; shared: number }> };
    const hits = (Array.isArray(rows) ? rows : rows.rows).filter((r) => Number(r.shared) >= (opts.minShared ?? 1));
    if (hits.length) {
      const found = await db.select().from(notes).where(and(eq(notes.companyId, companyId), sql`${notes.id} in (${sql.join(hits.map((h) => sql`${h.id}`), sql`, `)})`));
      const byId = new Map(found.map((f) => [f.id, f]));
      return hits.map((h) => ({ ...byId.get(h.id)!, shared: Number(h.shared) })).filter((n) => n.id);
    }
    const words = query.trim();
    if (words.length < 3 || words.length > 120) return [];
    const loose = await db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.companyId, companyId),
          ...(opts.target ? [eq(notes.target, opts.target)] : []),
          ...(opts.includeRetired ? [] : [eq(notes.status, "active")]),
          ...(opts.includeCore === false ? [eq(notes.inCore, false)] : []),
          ilike(notes.text, `%${words.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
        ),
      )
      .orderBy(desc(notes.updatedAt))
      .limit(limit);
    return loose.map((n) => ({ ...n, shared: 1 }));
  }

  /**
   * The notes a turn should see beside the always-loaded set: the best matches
   * for its message that aren't loaded already, up to TURN_NOTES and about
   * TURN_NOTE_CHARS. A long message needs two shared words, so one common word
   * doesn't pull in an unrelated note. Each one shown counts as recalled.
   */
  async function relevantForTurn(companyId: string, message: string): Promise<Note[]> {
    const text = message.slice(0, 2000);
    if (text.trim().length < 3) return [];
    const words = new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
    const hits = await search(companyId, text, { includeCore: false, limit: 20, minShared: words.size >= 6 ? 2 : 1 });
    const picked: Note[] = [];
    let chars = 0;
    for (const n of hits) {
      if (picked.length >= TURN_NOTES || chars + n.text.length > TURN_NOTE_CHARS) break;
      picked.push(n);
      chars += n.text.length;
    }
    if (picked.length) await markRecalled(companyId, picked);
    return picked;
  }

  /** Count a recall; a lasting note recalled often enough comes back into every turn. */
  async function markRecalled(companyId: string, picked: Note[]): Promise<void> {
    for (const n of picked) {
      await db
        .update(notes)
        .set({ recallCount: sql`${notes.recallCount} + 1`, lastRecalledAt: new Date() })
        .where(eq(notes.id, n.id));
    }
    const earned = picked.filter((n) => n.recallCount + 1 >= PROMOTE_AFTER_RECALLS && !isStatusLike(n.text));
    for (const target of new Set(earned.map((n) => n.target as MemoryTarget))) {
      void curate(companyId, target).catch(logFailure("curating memory after a recall", { companyId }));
    }
  }

  /** A page of notes for the Memory page. */
  async function list(
    companyId: string,
    opts: { target?: MemoryTarget; where?: "core" | "kept" | "retired" | "all"; limit?: number; offset?: number } = {},
  ): Promise<Note[]> {
    const where = opts.where ?? "all";
    return db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.companyId, companyId),
          ...(opts.target ? [eq(notes.target, opts.target)] : []),
          ...(where === "core" ? [eq(notes.inCore, true), eq(notes.status, "active")] : []),
          ...(where === "kept" ? [eq(notes.inCore, false), eq(notes.status, "active")] : []),
          ...(where === "retired" ? [eq(notes.status, "retired")] : []),
        ),
      )
      .orderBy(desc(notes.pinned), desc(notes.updatedAt), asc(notes.id))
      .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200))
      .offset(Math.max(opts.offset ?? 0, 0));
  }

  async function counts(companyId: string): Promise<{ core: number; kept: number; retired: number }> {
    const rows = await db
      .select({ inCore: notes.inCore, status: notes.status, n: sql<number>`count(*)::int` })
      .from(notes)
      .where(eq(notes.companyId, companyId))
      .groupBy(notes.inCore, notes.status);
    const sum = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((a, r) => a + Number(r.n), 0);
    return { core: sum((r) => r.status === "active" && r.inCore), kept: sum((r) => r.status === "active" && !r.inCore), retired: sum((r) => r.status === "retired") };
  }

  /** Boot: bring today's always-loaded notes into the table and curate (idempotent). */
  async function importAndCurate(companyId: string): Promise<void> {
    for (const target of ["company", "people"] as const) await curate(companyId, target);
  }

  return { add, get, patch, remove, pin, retire, search, relevantForTurn, markRecalled, list, counts, curate, importAndCurate, find };
}

/** Boot: every company's notes into the table, then curated. */
export async function healMemoryNotes(db: Db): Promise<number> {
  const { companies } = await import("@paperclipai/db");
  const rows = await db.select({ id: companies.id }).from(companies);
  for (const { id } of rows) await notesService(db).importAndCurate(id).catch(logFailure("bringing memory into the notes table", { companyId: id }));
  return rows.length;
}

