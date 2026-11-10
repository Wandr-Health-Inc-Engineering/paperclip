import { describe, expect, it } from "vitest";
import type { TethrNotification } from "@/api/tethr";
import { actionsFor, kindWord, tapAction } from "./TethrBell";

const staged = (outputStatus?: string | null): TethrNotification => ({
  id: "n1",
  kind: "approval",
  title: "@tethr staged org output for review",
  body: null,
  href: "/queue/0b0a0c0d-0000-4000-8000-000000000001",
  agentTag: "@tethr",
  readAt: null,
  createdAt: "2026-11-09T07:42:21.971Z",
  ...(outputStatus === undefined ? {} : { outputStatus }),
});

describe("the bell's actions", () => {
  it("asks for a decision only while the card is still open", () => {
    expect(actionsFor(staged("gated")).pendingOutputId).toBe("0b0a0c0d-0000-4000-8000-000000000001");
    expect(actionsFor(staged("changes_requested")).pendingOutputId).toBeTruthy();
    for (const closed of ["rejected", "approved", "published", null]) {
      expect(actionsFor(staged(closed))).toEqual({ viewLabel: "Open Needs you", viewTo: "/queue" });
    }
  });
});

describe("tapping a notification", () => {
  const note = (over: Partial<TethrNotification>): TethrNotification => ({ ...staged("gated"), ...over });

  it("goes straight to what it's about; only a card that still waits opens the decide popup", () => {
    expect(tapAction(note({ kind: "run", title: "@writer finished WD-8: Drafts", href: "/chat?focus=r1" }))).toEqual({ kind: "go", to: "/chat?focus=r1" });
    expect(tapAction(note({ kind: "idea", title: "Idea: a partner page", href: "/chat?focus=r2" }))).toEqual({ kind: "go", to: "/chat?focus=r2" });
    expect(tapAction(staged("gated"))).toEqual({ kind: "decide" });
    expect(tapAction(staged("approved"))).toEqual({ kind: "go", to: "/queue" });
    expect(tapAction(note({ kind: "system", title: "Something happened", href: null }))).toEqual({ kind: "read" });
  });

  it("names its kind in a word a person would use", () => {
    expect(kindWord("run")).toBe("report");
    expect(kindWord("approval")).toBe("approval");
    expect(kindWord("whatever")).toBe("whatever");
  });
});
