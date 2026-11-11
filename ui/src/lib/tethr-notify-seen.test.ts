import { describe, expect, it } from "vitest";
import type { TethrNotification } from "@/api/tethr";
import { seenInChat } from "./tethr-notify-seen";

const n = (id: string, href: string | null, readAt: string | null = null): TethrNotification => ({ id, kind: "run", title: id, body: null, href, agentTag: null, readAt, createdAt: "" });

const main = { threadId: "main", mainThreadId: "main", runIds: new Set(["r1"]), outputIds: new Set(["o1"]) };

describe("notifications about what's on screen", () => {
  // Mark, 2026-11-10: "Notifications should be dismissed since I am already in the right chat for the notification".
  it("counts a card, a turn or the chat itself as seen while that chat is open", () => {
    const list = [
      n("card", "/queue/o1"),
      n("turn", "/chat?focus=r1"),
      n("chat", "/chat"),
      n("other-card", "/queue/o9"),
      n("other-turn", "/chat?focus=r9"),
      n("side-chat", "/chat?chat=side&focus=r1"),
      n("growth", "/growth"),
      n("already", "/queue/o1", "2026-11-10T00:00:00Z"),
      n("nolink", null),
    ];
    expect(seenInChat(list, main)).toEqual(["card", "turn", "chat"]);
  });

  it("matches an agent's or side chat's own links", () => {
    const side = { threadId: "side", mainThreadId: "main", runIds: new Set(["r2"]), outputIds: new Set<string>() };
    expect(seenInChat([n("a", "/chat?chat=side"), n("b", "/chat?chat=side&focus=r2"), n("c", "/chat"), n("d", "/WD/chat?chat=side")], side)).toEqual(["a", "b", "d"]);
  });
});
