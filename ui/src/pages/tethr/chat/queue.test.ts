import { describe, expect, it } from "vitest";
import type { TethrChatRun } from "@/api/tethr";
import { waitingBehind } from "./queue";

const TERMINAL = new Set(["done", "gated", "failed", "stopped"]);
const run = (id: string, status: string, over: Partial<TethrChatRun> = {}): TethrChatRun =>
  ({ id, status, invocationSource: "chat", sourceKey: null, requestText: id, hops: [], outputs: [], ...over }) as TethrChatRun;

describe("which messages wait in the tray", () => {
  it("a person's queued messages behind a turn that's still going, in order", () => {
    const runs = [run("a", "done"), run("b", "running"), run("c", "queued"), run("d", "queued")];
    expect(waitingBehind(runs, TERMINAL).map((r) => r.id)).toEqual(["c", "d"]);
  });

  it("not the turn at the head of the line, even while it waits for a free slot", () => {
    expect(waitingBehind([run("a", "done"), run("b", "queued")], TERMINAL)).toEqual([]);
    expect(waitingBehind([run("a", "queued"), run("b", "queued")], TERMINAL).map((r) => r.id)).toEqual(["b"]);
  });

  it("never a turn tethr started, a card, or anything already finished", () => {
    const runs = [
      run("a", "running"),
      run("b", "queued", { sourceKey: "chat-system" }),
      run("c", "done", { sourceKey: "tethr-agent-report" }),
      run("d", "queued"),
    ];
    expect(waitingBehind(runs, TERMINAL).map((r) => r.id)).toEqual(["d"]);
    expect(waitingBehind([run("a", "done"), run("b", "done")], TERMINAL)).toEqual([]);
  });
});
