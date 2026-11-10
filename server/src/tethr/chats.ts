import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { serialize, writeAtomic } from "./atomic.js";

// Chat-first Console (phase 17, Mark's model): one ongoing MAIN chat with
// @tethr, plus SIDE chats he opens on purpose for a focused task or side
// project.
//
// - The main chat is a normal routing thread whose threadId is the company id
//   itself. That makes it stable across devices with no storage: a run id can
//   never equal a company id, and routing only ever reads threadId to load the
//   last few turns as context (bounded to 5, trimmed).
// - Side chats are ordinary threads (threadId = the first run's id). Which
//   threads count as side chats is human-owned local config in the instance dir
//   (same pattern as the throttle / overseer roster / drive mounts), so one-off
//   requests from before the chat UI don't flood the list. Removing a side chat
//   only drops it from the list; its runs stay in Activity.

export interface SideChat {
  threadId: string;
  title: string;
  /** ISO timestamp the side chat was opened. */
  createdAt: string;
}

/** Phase 18: the Claude Code session a chat thread resumes. */
export interface ChatSession {
  sessionId: string | null;
  sessionParams: Record<string, unknown> | null;
  lastTurnAt: string;
  /** Rough size of the conversation context after the last turn (input + cached tokens). */
  contextTokens: number;
  /** The persona + skill it was made with (persona.ts instructionsFingerprint). */
  instructions?: string;
}

interface CompanyChats {
  sideChats: SideChat[];
  sessions?: Record<string, ChatSession>;
  /** Notes to prepend to a thread's next turn (e.g. "Mark rejected …"). */
  notes?: Record<string, string[]>;
  /** Threads whose session has read connector data (Gmail, Slack, …): from then
   * on, opening web pages needs Mark's approval (it could carry that data out). */
  tainted?: Record<string, string>;
  /** Phase 26.1: which chat a Slack conversation drives, by its Slack source key
   * ("slack:im:D…" for a DM, "slack:C…:<thread ts>" for a channel thread). */
  slackLinks?: Record<string, string>;
}

interface ChatsFile {
  [companyId: string]: CompanyChats;
}

const TITLE_MAX = 60;

function configPath(): string {
  if (process.env.TETHR_CHATS_FILE) return process.env.TETHR_CHATS_FILE;
  return path.resolve(resolvePaperclipInstanceRoot(), "tethr-chats.json");
}

function readFile(): ChatsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as ChatsFile) : {};
  } catch {
    return {};
  }
}

/** Serialized read-modify-write of the file (atomic write). `fn` mutates the
 * freshly read data and says whether anything changed. Concurrent turns and
 * approvals never drop each other's updates, and a reader never sees a
 * half-written file (which used to read as {} and wipe everything). */
function mutate<T>(fn: (data: ChatsFile) => { value: T; changed: boolean }): Promise<T> {
  const file = configPath();
  return serialize(file, async () => {
    const data = readFile();
    const { value, changed } = fn(data);
    if (changed) await writeAtomic(file, JSON.stringify(data, null, 2));
    return value;
  });
}

/** The main chat's thread id: the company id (see header). */
export function mainThreadId(companyId: string): string {
  return companyId;
}

/** A short side-chat title from its first message: first line, single-spaced, ≤60 chars. */
export function chatTitle(request: string): string {
  const firstLine = request.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const clean = firstLine.replace(/\s+/g, " ").trim();
  if (!clean) return "Side chat";
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…` : clean;
}

export function listSideChats(companyId: string): SideChat[] {
  return readFile()[companyId]?.sideChats ?? [];
}

export function isSideChat(companyId: string, threadId: string): boolean {
  return listSideChats(companyId).some((c) => c.threadId === threadId);
}

/** Register a thread as a side chat (idempotent: an existing entry is returned as-is). */
export function addSideChat(companyId: string, threadId: string, title: string): Promise<SideChat> {
  return mutate((data) => {
    const list = data[companyId]?.sideChats ?? [];
    const existing = list.find((c) => c.threadId === threadId);
    if (existing) return { value: existing, changed: false };
    const chat: SideChat = { threadId, title: chatTitle(title), createdAt: new Date().toISOString() };
    data[companyId] = { ...(data[companyId] ?? { sideChats: [] }), sideChats: [chat, ...list] };
    return { value: chat, changed: true };
  });
}

// ---- Phase 18: per-thread Claude sessions + next-turn notes ----------------

export function getSession(companyId: string, threadId: string): ChatSession | null {
  return readFile()[companyId]?.sessions?.[threadId] ?? null;
}

export function setSession(companyId: string, threadId: string, session: ChatSession): Promise<void> {
  return mutate((data) => {
    const c = data[companyId] ?? { sideChats: [] };
    data[companyId] = { ...c, sessions: { ...(c.sessions ?? {}), [threadId]: session } };
    return { value: undefined, changed: true };
  });
}

export function clearSession(companyId: string, threadId: string): Promise<void> {
  return mutate((data) => {
    const c = data[companyId];
    if (!c?.sessions?.[threadId]) return { value: undefined, changed: false };
    const { [threadId]: _dropped, ...rest } = c.sessions;
    data[companyId] = { ...c, sessions: rest };
    return { value: undefined, changed: true };
  });
}

export function addNote(companyId: string, threadId: string, note: string): Promise<void> {
  return mutate((data) => {
    const c = data[companyId] ?? { sideChats: [] };
    const notes = c.notes ?? {};
    data[companyId] = { ...c, notes: { ...notes, [threadId]: [...(notes[threadId] ?? []), note] } };
    return { value: undefined, changed: true };
  });
}

/** Read and clear the notes waiting for a thread's next turn. */
export function takeNotes(companyId: string, threadId: string): Promise<string[]> {
  return mutate((data) => {
    const c = data[companyId];
    const list = c?.notes?.[threadId] ?? [];
    if (!list.length || !c) return { value: [], changed: false };
    const { [threadId]: _taken, ...rest } = c.notes ?? {};
    data[companyId] = { ...c, notes: rest };
    return { value: list, changed: true };
  });
}

/** The chat a Slack conversation drives, if it has one (phase 26.1). */
export function slackLinkedThread(companyId: string, sourceKey: string): string | null {
  return readFile()[companyId]?.slackLinks?.[sourceKey] ?? null;
}

/** Remember which chat a Slack conversation drives. */
export function linkSlackThread(companyId: string, sourceKey: string, threadId: string): Promise<void> {
  return mutate((data) => {
    const c = data[companyId] ?? { sideChats: [] };
    if (c.slackLinks?.[sourceKey] === threadId) return { value: undefined, changed: false };
    data[companyId] = { ...c, slackLinks: { ...(c.slackLinks ?? {}), [sourceKey]: threadId } };
    return { value: undefined, changed: true };
  });
}

/** Has this thread's session read connector data? (See CompanyChats.tainted.) */
export function isTainted(companyId: string, threadId: string): boolean {
  return Boolean(readFile()[companyId]?.tainted?.[threadId]);
}

export function markTainted(companyId: string, threadId: string): Promise<void> {
  if (isTainted(companyId, threadId)) return Promise.resolve();
  return mutate((data) => {
    const c = data[companyId] ?? { sideChats: [] };
    if (c.tainted?.[threadId]) return { value: undefined, changed: false };
    data[companyId] = { ...c, tainted: { ...(c.tainted ?? {}), [threadId]: new Date().toISOString() } };
    return { value: undefined, changed: true };
  });
}

/** "Start over" for a thread: a fresh session that hasn't seen connector data. */
export function clearTaint(companyId: string, threadId: string): Promise<void> {
  return mutate((data) => {
    const c = data[companyId];
    if (!c?.tainted?.[threadId]) return { value: undefined, changed: false };
    const { [threadId]: _cleared, ...rest } = c.tainted;
    data[companyId] = { ...c, tainted: rest };
    return { value: undefined, changed: true };
  });
}

/** Drop a side chat from the list. Its runs are untouched. */
export function removeSideChat(companyId: string, threadId: string): Promise<boolean> {
  return mutate((data) => {
    const list = data[companyId]?.sideChats ?? [];
    const next = list.filter((c) => c.threadId !== threadId);
    if (next.length === list.length) return { value: false, changed: false };
    data[companyId] = { ...(data[companyId] ?? { sideChats: [] }), sideChats: next };
    return { value: true, changed: true };
  });
}

/** Hand a thread's session, notes and taint over to another thread, and drop
 * `from` from the side-chat list. Only fills in what `to` doesn't have yet, so
 * it never overwrites the target's own state. Used to fold the old goals
 * interview side chat into an empty main chat. */
export function moveThreadState(companyId: string, from: string, to: string): Promise<void> {
  return mutate((data) => {
    const c = data[companyId];
    if (!c) return { value: undefined, changed: false };
    const sessions = { ...(c.sessions ?? {}) };
    const notes = { ...(c.notes ?? {}) };
    const tainted = { ...(c.tainted ?? {}) };
    if (sessions[from] && !sessions[to]) sessions[to] = sessions[from];
    if (notes[from]?.length) notes[to] = [...(notes[to] ?? []), ...notes[from]];
    if (tainted[from] && !tainted[to]) tainted[to] = tainted[from];
    delete sessions[from];
    delete notes[from];
    delete tainted[from];
    data[companyId] = { ...c, sideChats: c.sideChats.filter((s) => s.threadId !== from), sessions, notes, tainted };
    return { value: undefined, changed: true };
  });
}
