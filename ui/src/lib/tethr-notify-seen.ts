import type { TethrNotification } from "@/api/tethr";

// A notification about something already on your screen isn't news (Mark,
// 2026-11-10: "the notifications show up even though I am in chat right there").
// While a chat is open in front of you, its notifications are marked read: a
// card shown in it (/queue/<output>), a turn in it (/chat?…focus=<run>), or the
// chat itself (/chat for the main chat, /chat?chat=<thread> for another).

export interface ChatOnScreen {
  threadId: string;
  /** The main chat's thread id (a bare /chat link means it). */
  mainThreadId: string;
  runIds: Set<string>;
  outputIds: Set<string>;
}

/** Ids of unread notifications that point at what's on screen in this chat. */
export function seenInChat(notifications: TethrNotification[], view: ChatOnScreen): string[] {
  return notifications.filter((n) => !n.readAt && n.href && pointsHere(n.href, view)).map((n) => n.id);
}

function pointsHere(href: string, view: ChatOnScreen): boolean {
  let url: URL;
  try {
    url = new URL(href, "http://tethr.local");
  } catch {
    return false;
  }
  const queue = url.pathname.match(/\/queue\/([^/]+)$/);
  if (queue) return view.outputIds.has(decodeURIComponent(queue[1]!));
  if (!/\/chat$/.test(url.pathname)) return false;
  const thread = url.searchParams.get("chat") ?? view.mainThreadId;
  if (thread !== view.threadId) return false;
  const focus = url.searchParams.get("focus");
  return focus ? view.runIds.has(focus) : true;
}
