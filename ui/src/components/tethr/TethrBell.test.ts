import { describe, expect, it } from "vitest";
import type { TethrNotification } from "@/api/tethr";
import { actionsFor } from "./TethrBell";

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
