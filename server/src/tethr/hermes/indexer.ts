import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, tethrRouteRuns } from "@paperclipai/db";
import { listSideChats, mainThreadId } from "../chats.js";
import { stableThreadId } from "../ids.js";
import { logFailure } from "../best-effort.js";
import { personalHealthReason } from "../screen.js";
import { MINUTE } from "../time.js";
import { teamService } from "../team.js";
import { readProfileId, runHelper, writeProfileId } from "./bridge.js";
import { activeHermesProfile, getMemoryState, updateMemoryState, type CompanyMemoryState } from "./state.js";

// Every finished chat turn goes into Hermes (phase 25), so recall can find it
// later: the person's message and tethr's answer. Never tool results (raw email
// or Slack content), never private turns or what came out of them (the watcher's
// idea check reads other people's Slack words), never a turn that ties a person
// to a health detail. Each tethr chat is one Hermes lineage: a turn's parent is
// the chat's previous turn. One import at a time, oldest first. A turn always
// gets the same Hermes id, and the ledger in tethr-memory.json records what's
// in, so nothing is imported twice even when a batch is cut short.

const BATCH = 25;
const BACKFILL_LIMIT = 3000;
const USER_MAX = 6000;
const SYSTEM_MAX = 2000;
const ANSWER_MAX = 12000;

/** Ledger values for turns deliberately left out. */
const SKIPPED = "skipped:";
export const isImported = (ledgerValue: string | undefined) => Boolean(ledgerValue) && !ledgerValue!.startsWith(SKIPPED);

export const GATEWAY_WAITING = "Hermes's background service isn't running, so new conversations are waiting to be saved.";

type RunRow = typeof tethrRouteRuns.$inferSelect;

/** Where a chat's turns go in Hermes: an agent's chats are their own source, so
 * an agent's recall searches only its own work. */
export function agentSource(tag: string): string {
  return `tethr-agent-${tag.replace(/^@/, "")}`;
}
export const TETHR_SOURCE = "tethr";

/**
 * Turns worth remembering: finished turns the chat runner ran (a person's
 * message, or a turn tethr started), with an answer, outside the Ideas chat.
 * Cards written straight into a chat (ideas, agent reports) are not turns: an
 * idea comes out of a private turn, and a report is already in its agent's chat.
 */
export function indexable(row: Pick<RunRow, "companyId" | "invocationSource" | "status" | "resultText" | "llmProvider" | "threadId" | "sourceKey">): boolean {
  return (
    row.invocationSource === "chat" &&
    (row.sourceKey === null || row.sourceKey === "chat-system") &&
    row.status === "done" &&
    Boolean(row.resultText?.trim()) &&
    row.llmProvider !== "throttle" &&
    row.threadId !== stableThreadId("ideas", row.companyId)
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stamp(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

interface ChatInfo {
  name: string;
  source: string;
}

async function chatInfo(db: Db, companyId: string, threadId: string, cache: Map<string, ChatInfo>): Promise<ChatInfo> {
  const hit = cache.get(threadId);
  if (hit) return hit;
  let info: ChatInfo;
  // A lookup that fails throws: an agent's turn must never be filed as tethr's.
  const member = await teamService(db).byThread(companyId, threadId);
  if (member) info = { name: member.tag, source: agentSource(member.tag) };
  else if (threadId === mainThreadId(companyId)) info = { name: "tethr · main chat", source: TETHR_SOURCE };
  else if (threadId === stableThreadId("operations", companyId)) info = { name: "tethr · Operations", source: TETHR_SOURCE };
  else {
    const side = listSideChats(companyId).find((c) => c.threadId === threadId);
    info = { name: side ? `tethr · ${side.title}` : "tethr · chat", source: TETHR_SOURCE };
  }
  cache.set(threadId, info);
  return info;
}

/** The import record for one turn. `hex` makes its Hermes id the same every time. */
export function turnRecord(row: RunRow, info: ChatInfo) {
  const system = row.sourceKey === "chat-system";
  const asked = system ? `(tethr) ${clip(row.requestText, SYSTEM_MAX)}` : clip(row.requestText, USER_MAX);
  const createdAt = row.createdAt.getTime() / 1000;
  return {
    key: row.id,
    hex: row.id.replace(/-/g, "").slice(0, 12),
    source: info.source,
    title: `${info.name} · ${stamp(row.createdAt)} · ${row.id.slice(0, 6)}`,
    started_at: createdAt,
    ended_at: row.updatedAt.getTime() / 1000,
    messages: [
      { role: "user", content: asked, timestamp: createdAt },
      { role: "assistant", content: clip(row.resultText ?? "", ANSWER_MAX), timestamp: row.updatedAt.getTime() / 1000 },
    ],
  };
}

/** Run ids waiting to be imported, oldest first (a Set keeps insertion order). */
const pending = new Set<string>();
let draining: Promise<void> | null = null;

/** Queue a finished turn for import (no-op unless the company uses Hermes). */
export function indexTurnSoon(db: Db, runId: string, companyId: string): void {
  if (!activeHermesProfile(companyId)) return;
  pending.add(runId);
  void drainIndex(db).catch(logFailure("adding a chat turn to Hermes", { runId }));
}

async function drainLoop(db: Db): Promise<void> {
  while (pending.size) {
    const ids = [...pending].slice(0, BATCH);
    for (const id of ids) pending.delete(id);
    await importRuns(db, ids);
  }
}

/** Import everything queued (one drain at a time). Resolves when it's done. The
 * flag is cleared in a .finally attached AFTER it's set (an empty queue settles
 * at once, and clearing it inside the loop would leave it set for good), and a
 * turn queued while a drain was finishing starts the next one. */
export function drainIndex(db: Db): Promise<void> {
  if (!draining) {
    draining = drainLoop(db).finally(() => {
      draining = null;
      if (pending.size) void drainIndex(db).catch(logFailure("adding chat turns to Hermes"));
    });
  }
  return draining;
}

/**
 * The ledger belongs to one profile folder, named by the id tethr wrote into it.
 * A folder that was deleted and remade, or a different Hermes, holds none of
 * what the ledger lists, so the ledger starts over (imports are repeat-safe).
 * A profile from before ids existed is adopted as it is.
 */
async function ledgerFor(companyId: string, profile: string): Promise<CompanyMemoryState> {
  const state = getMemoryState(companyId);
  const onDisk = readProfileId(profile);
  if (onDisk && onDisk === state.profileId) return state;
  if (!onDisk && !state.profileId) {
    const id = await writeProfileId(profile);
    return updateMemoryState(companyId, (s) => ({ ...s, profileId: id }));
  }
  const id = onDisk ?? (await writeProfileId(profile));
  return updateMemoryState(companyId, (s) => ({ ...s, profileId: id, imported: {}, lastByThread: {} }));
}

interface Tail {
  session: string;
  at: number;
}
const tailOf = (v: string | Tail | undefined): Tail | null => (!v ? null : typeof v === "string" ? { session: v, at: 0 } : v);

interface ImportReply {
  gateway?: "up" | "absent";
  results: Array<{ key: string; session_id?: string; error?: string }>;
}

async function importRuns(db: Db, runIds: string[]): Promise<void> {
  const rows = await db.select().from(tethrRouteRuns).where(inArray(tethrRouteRuns.id, runIds));
  const byCompany = new Map<string, RunRow[]>();
  for (const row of rows) byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row]);
  for (const [companyId, list] of byCompany) {
    const profile = activeHermesProfile(companyId);
    if (!profile) continue;
    try {
      await importForCompany(db, companyId, profile, list);
    } catch (err) {
      // Left out of the ledger: the next catch-up tries them again.
      logFailure("adding chat turns to Hermes", { companyId, turns: list.length })(err);
      await updateMemoryState(companyId, (s) => ({ ...s, lastImportError: err instanceof Error ? err.message : String(err) }));
    }
  }
}

async function importForCompany(db: Db, companyId: string, profile: string, list: RunRow[]): Promise<void> {
  const state = await ledgerFor(companyId, profile);
  const fresh = list.filter((r) => indexable(r) && !state.imported?.[r.id]).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (!fresh.length) return;

  // A turn that ties a person to a health detail is never saved for search.
  const skipped = fresh.filter((r) => personalHealthReason(`${r.requestText}\n${r.resultText ?? ""}`));
  const keep = fresh.filter((r) => !skipped.includes(r));

  // Each turn's parent is its chat's previous turn: one earlier in this batch,
  // or the newest one already in Hermes. A turn older than that newest one (it
  // failed to import the first time) joins without becoming the chat's tail.
  const cache = new Map<string, ChatInfo>();
  const tails = new Map<string, { key?: string; session?: string; at: number }>();
  const turns = [];
  for (const row of keep) {
    const threadId = row.threadId ?? row.id;
    const at = row.createdAt.getTime();
    const tail = tails.get(threadId) ?? tailOf(state.lastByThread?.[threadId]);
    const record = turnRecord(row, await chatInfo(db, companyId, threadId, cache));
    const parent = tail && tail.at <= at ? ("key" in tail && tail.key ? { parent_key: tail.key } : { parent: tail.session ?? null }) : { parent: null };
    turns.push({ ...record, ...parent });
    if (!tail || at >= tail.at) tails.set(threadId, { key: row.id, at });
  }

  const reply: ImportReply = turns.length
    ? await runHelper<ImportReply>(profile, "sessions.import", { turns, wake: state.wakeGateway !== false })
    : { gateway: "up", results: [] };
  const waiting = reply.gateway === "absent";
  const done = new Map(reply.results.filter((r) => r.session_id).map((r) => [r.key, r.session_id!]));
  const failed = reply.results.find((r) => r.error);

  await updateMemoryState(companyId, (s) => {
    const imported = { ...(s.imported ?? {}) };
    const lastByThread = { ...(s.lastByThread ?? {}) };
    for (const row of skipped) imported[row.id] = `${SKIPPED}health`;
    for (const row of keep) {
      const session = done.get(row.id);
      if (!session) continue;
      imported[row.id] = session;
      const threadId = row.threadId ?? row.id;
      const at = row.createdAt.getTime();
      const tail = tailOf(lastByThread[threadId]);
      if (!tail || at >= tail.at) lastByThread[threadId] = { session, at };
    }
    return {
      ...s,
      imported,
      lastByThread,
      ...(done.size ? { lastImportAt: new Date().toISOString() } : {}),
      lastImportError: waiting ? GATEWAY_WAITING : (failed?.error ?? null),
    };
  });
}

/** Queue every finished turn not yet in Hermes (the newest BACKFILL_LIMIT), oldest first. Returns how many. */
export async function backfillIndex(db: Db, companyId: string): Promise<number> {
  const profile = activeHermesProfile(companyId);
  if (!profile) return 0;
  const imported = (await ledgerFor(companyId, profile)).imported ?? {};
  const rows = await db
    .select({
      id: tethrRouteRuns.id,
      companyId: tethrRouteRuns.companyId,
      invocationSource: tethrRouteRuns.invocationSource,
      status: tethrRouteRuns.status,
      resultText: tethrRouteRuns.resultText,
      llmProvider: tethrRouteRuns.llmProvider,
      threadId: tethrRouteRuns.threadId,
      sourceKey: tethrRouteRuns.sourceKey,
      createdAt: tethrRouteRuns.createdAt,
    })
    .from(tethrRouteRuns)
    .where(and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.invocationSource, "chat"), eq(tethrRouteRuns.status, "done")))
    .orderBy(desc(tethrRouteRuns.createdAt))
    .limit(BACKFILL_LIMIT);
  const todo = rows.filter((r) => indexable(r) && !imported[r.id]).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const r of todo) pending.add(r.id);
  return todo.length;
}

let timer: NodeJS.Timeout | null = null;

/** Boot: catch up every company that uses Hermes, then again every 10 minutes
 * (turns that failed to import are retried this way). */
export function startMemoryIndexer(db: Db): void {
  if (timer || process.env.VITEST) return;
  const tick = async () => {
    const list = await db.select({ id: companies.id }).from(companies).catch(() => []);
    for (const c of list) await backfillIndex(db, c.id).catch(logFailure("checking for chat turns to add to Hermes", { companyId: c.id }));
    await drainIndex(db).catch(logFailure("adding chat turns to Hermes"));
  };
  setTimeout(() => void tick(), 30_000).unref?.();
  timer = setInterval(() => void tick(), 10 * MINUTE);
  timer.unref?.();
}
