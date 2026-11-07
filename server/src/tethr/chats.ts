import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

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

interface ChatsFile {
  [companyId: string]: { sideChats: SideChat[] };
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

async function writeFile(data: ChatsFile): Promise<void> {
  const file = configPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf8");
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
export async function addSideChat(companyId: string, threadId: string, title: string): Promise<SideChat> {
  const data = readFile();
  const list = data[companyId]?.sideChats ?? [];
  const existing = list.find((c) => c.threadId === threadId);
  if (existing) return existing;
  const chat: SideChat = { threadId, title: chatTitle(title), createdAt: new Date().toISOString() };
  data[companyId] = { sideChats: [chat, ...list] };
  await writeFile(data);
  return chat;
}

/** Drop a side chat from the list. Its runs are untouched. */
export async function removeSideChat(companyId: string, threadId: string): Promise<boolean> {
  const data = readFile();
  const list = data[companyId]?.sideChats ?? [];
  const next = list.filter((c) => c.threadId !== threadId);
  if (next.length === list.length) return false;
  data[companyId] = { sideChats: next };
  await writeFile(data);
  return true;
}
