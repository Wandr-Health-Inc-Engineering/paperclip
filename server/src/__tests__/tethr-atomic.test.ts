import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serialize, writeAtomic } from "../tethr/atomic.js";
import { addNote, addSideChat, getSession, listSideChats, setSession, takeNotes } from "../tethr/chats.js";

// The instance-dir JSON stores under concurrency: no lost updates, no torn files.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-atomic-"));
  process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
});
afterEach(() => {
  delete process.env.TETHR_CHATS_FILE;
  fs.rmSync(dir, { recursive: true, force: true });
});

const C = "7c92c0f9-8ab4-4cb5-aa88-f01ef5dd0705";

describe("tethr atomic stores", () => {
  it("serializes work per key, even when a step fails", async () => {
    const order: number[] = [];
    const slow = (n: number, ms: number, fail = false) =>
      serialize("k", async () => {
        await new Promise((r) => setTimeout(r, ms));
        order.push(n);
        if (fail) throw new Error("boom");
        return n;
      });
    const results = await Promise.allSettled([slow(1, 30), slow(2, 1, true), slow(3, 1)]);
    expect(order).toEqual([1, 2, 3]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("writes with unique temp names (parallel writers never collide)", async () => {
    const file = path.join(dir, "x.json");
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeAtomic(file, JSON.stringify({ i }))));
    expect(() => JSON.parse(fs.readFileSync(file, "utf8"))).not.toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps every concurrent chat update (sessions, notes, side chats)", async () => {
    await Promise.all([
      ...Array.from({ length: 10 }, (_, i) =>
        setSession(C, `t${i}`, { sessionId: `s${i}`, sessionParams: null, lastTurnAt: "now", contextTokens: i }),
      ),
      ...Array.from({ length: 10 }, (_, i) => addNote(C, "main", `note ${i}`)),
      ...Array.from({ length: 5 }, (_, i) => addSideChat(C, `side${i}`, `Side ${i}`)),
    ]);
    for (let i = 0; i < 10; i++) expect(getSession(C, `t${i}`)?.sessionId).toBe(`s${i}`);
    expect((await takeNotes(C, "main")).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `note ${i}`).sort());
    expect(listSideChats(C)).toHaveLength(5);
  });
});
