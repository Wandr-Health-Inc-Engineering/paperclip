import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, tethrRouteRuns } from "@paperclipai/db";
import { listSideChats, mainThreadId } from "../chats.js";
import { stableThreadId } from "../ids.js";
import { MINUTE } from "../time.js";
import { teamService } from "../team.js";
import { runHelper } from "./bridge.js";
import { activeHermesProfile, getMemoryState, updateMemoryState } from "./state.js";

// Every finished chat turn goes into Hermes (phase 25), so recall can find it
// later: the person's message and tethr's answer, never tool results (raw email
// or Slack content), never private turns (the watcher's idea check reads other
// people's Slack words). Each tethr chat is one Hermes lineage: a turn's parent
// is the chat's previous turn. One import at a time; the ledger in
// tethr-memory.json means a turn is imported once.

const BATCH = 25;
const BACKFILL_LIMIT = 3000;
const USER_MAX = 6000;
const SYSTEM_MAX = 2000;
const ANSWER_MAX = 12000;

type RunRow = typeof tethrRouteRuns.$inferSelect;

/** Where a chat's turns go in Hermes: an agent's chats are their own source, so
 * an agent's recall searches only its own work. */
export function agentSource(tag: string): string {
  return `tethr-agent-${tag.replace(/^@/, "")}`;
}
export const TETHR_SOURCE = "tethr";

/** Turns worth remembering: finished chat turns with an answer, outside the Ideas chat. */
export function indexable(row: Pick<RunRow, "companyId" | "invocationSource" | "status" | "resultText" | "llmProvider" | "threadId">): boolean {
  return (
    row.invocationSource === "chat" &&
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
  const member = await teamService(db).byThread(companyId, threadId).catch(() => null);
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

/** The import record for one turn. */
export function turnRecord(row: RunRow, info: ChatInfo) {
  const system = row.sourceKey === "chat-system";
  const asked = system ? `(tethr) ${clip(row.requestText, SYSTEM_MAX)}` : clip(row.requestText, USER_MAX);
  const createdAt = row.createdAt.getTime() / 1000;
  return {
    key: row.id,
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

const pending = new Set<string>();
let draining: Promise<void> | null = null;

/** Queue a finished turn for import (no-op unless the company uses Hermes). */
export function indexTurnSoon(db: Db, runId: string, companyId: string): void {
  if (!activeHermesProfile(companyId)) return;
  pending.add(runId);
  void drainIndex(db);
}

/** Import everything queued (one drain at a time). Resolves when it's done. */
export function drainIndex(db: Db): Promise<void> {
  if (draining) return draining;
  draining = (async () => {
    try {
      while (pending.size) {
        const ids = [...pending].slice(0, BATCH);
        for (const id of ids) pending.delete(id);
        await importRuns(db, ids);
      }
    } finally {
      draining = null;
    }
  })();
  return draining;
}

async function importRuns(db: Db, runIds: string[]): Promise<void> {
  const rows = await db.select().from(tethrRouteRuns).where(inArray(tethrRouteRuns.id, runIds));
  const byCompany = new Map<string, RunRow[]>();
  for (const row of rows) byCompany.set(row.companyId, [...(byCompany.get(row.companyId) ?? []), row]);
  for (const [companyId, list] of byCompany) {
    const profile = activeHermesProfile(companyId);
    if (!profile) continue;
    const state = getMemoryState(companyId);
    const fresh = list
      .filter((r) => indexable(r) && !state.imported?.[r.id])
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (!fresh.length) continue;
    const cache = new Map<string, ChatInfo>();
    // A turn's parent: the chat's previous turn, from this batch or already in Hermes.
    const lastKey = new Map<string, string>();
    const turns = [];
    for (const row of fresh) {
      const threadId = row.threadId ?? row.id;
      const record = turnRecord(row, await chatInfo(db, companyId, threadId, cache));
      const inBatch = lastKey.get(threadId);
      turns.push(inBatch ? { ...record, parent_key: inBatch } : { ...record, parent: state.lastByThread?.[threadId] ?? null });
      lastKey.set(threadId, row.id);
    }
    try {
      const res = await runHelper<{ results: Array<{ key: string; session_id?: string; error?: string }> }>(profile, "sessions.import", { turns });
      const ok = res.results.filter((r) => r.session_id);
      const failed = res.results.find((r) => r.error);
      await updateMemoryState(companyId, (s) => {
        const imported = { ...(s.imported ?? {}) };
        const lastByThread = { ...(s.lastByThread ?? {}) };
        for (const r of ok) {
          imported[r.key] = r.session_id!;
          const row = fresh.find((f) => f.id === r.key);
          if (row) lastByThread[row.threadId ?? row.id] = r.session_id!;
        }
        return { ...s, imported, lastByThread, lastImportAt: new Date().toISOString(), lastImportError: failed?.error ?? null };
      });
    } catch (err) {
      // Left out of the ledger: the next backfill tries them again.
      await updateMemoryState(companyId, (s) => ({ ...s, lastImportError: err instanceof Error ? err.message : String(err) }));
    }
  }
}

/** Queue every finished turn not yet in Hermes (newest BACKFILL_LIMIT). Returns how many. */
export async function backfillIndex(db: Db, companyId: string): Promise<number> {
  if (!activeHermesProfile(companyId)) return 0;
  const imported = getMemoryState(companyId).imported ?? {};
  const rows = await db
    .select({
      id: tethrRouteRuns.id,
      companyId: tethrRouteRuns.companyId,
      invocationSource: tethrRouteRuns.invocationSource,
      status: tethrRouteRuns.status,
      resultText: tethrRouteRuns.resultText,
      llmProvider: tethrRouteRuns.llmProvider,
      threadId: tethrRouteRuns.threadId,
    })
    .from(tethrRouteRuns)
    .where(and(eq(tethrRouteRuns.companyId, companyId), eq(tethrRouteRuns.invocationSource, "chat"), eq(tethrRouteRuns.status, "done")))
    .orderBy(desc(tethrRouteRuns.createdAt))
    .limit(BACKFILL_LIMIT);
  const todo = rows.filter((r) => indexable(r) && !imported[r.id]);
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
    for (const c of list) await backfillIndex(db, c.id).catch(() => 0);
    await drainIndex(db).catch(() => {});
  };
  setTimeout(() => void tick(), 30_000).unref?.();
  timer = setInterval(() => void tick(), 10 * MINUTE);
  timer.unref?.();
}
