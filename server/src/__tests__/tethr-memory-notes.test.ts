import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, tethrMemoryNotes } from "@paperclipai/db";
import { chooseCore, isStatusLike, replaceOnce, CORE_HIGH, CORE_LOW, PROMOTE_AFTER_RECALLS } from "../tethr/memory/notes.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Memory without a ceiling (2026-11-10, Mark: "I don't want a cap like this. The
// system needs to truly be working for months and keep learning"). Every note is
// kept in tethr_memory_notes; the always-loaded set is curated from it.

const note = (id: string, text: string, over: Partial<{ pinned: boolean; inCore: boolean; recallCount: number; daysAgo: number; recalledDaysAgo: number }> = {}) => ({
  id,
  text,
  pinned: over.pinned ?? false,
  inCore: over.inCore ?? true,
  status: "active",
  recallCount: over.recallCount ?? 0,
  updatedAt: new Date(Date.now() - (over.daysAgo ?? 0) * 86_400_000),
  lastRecalledAt: over.recalledDaysAgo === undefined ? null : new Date(Date.now() - over.recalledDaysAgo * 86_400_000),
});

describe("the always-loaded set", () => {
  it("patches the part a note was quoted by, as Hermes does", () => {
    expect(replaceOnce("Most search traffic lands on the Peru page", "the peru page", "the Peru and Kenya pages")).toBe("Most search traffic lands on the Peru and Kenya pages");
    expect(replaceOnce("abc", "zzz", "new")).toBe("new");
  });

  it("tells status from lasting facts", () => {
    expect(isStatusLike("Campaign 24459419164 is live at $30/day")).toBe(true);
    expect(isStatusLike("Paused the spring campaign on 11/10")).toBe(true);
    expect(isStatusLike("Wandr sells travel prescriptions through a licensed telehealth visit")).toBe(false);
    expect(isStatusLike("Mark prefers short answers with one recommendation")).toBe(false);
  });

  it("keeps what fits, moves status and stale notes out past 85%, never a pinned one, and lands near 70%", () => {
    const filler = (n: number) => "x".repeat(n);
    const notes = [
      note("pinned-old", `Pinned fact ${filler(900)}`, { pinned: true, daysAgo: 90 }),
      note("status", `Campaign 12345678 is live ${filler(900)}`, { daysAgo: 1 }),
      note("old-fact", `An old lasting fact ${filler(900)}`, { daysAgo: 60 }),
      note("new-fact", `A fresh lasting fact ${filler(900)}`, { daysAgo: 0 }),
      note("mid-fact", `A middling lasting fact ${filler(900)}`, { daysAgo: 20 }),
      note("recent-fact", `Another recent fact ${filler(900)}`, { daysAgo: 2 }),
    ];
    const limit = 6000;
    const kept = chooseCore(notes, limit);
    const size = [...kept].map((id) => notes.find((n) => n.id === id)!.text).join("\n§\n").length;
    expect(size).toBeLessThanOrEqual(limit * CORE_LOW);
    expect(kept.has("pinned-old")).toBe(true);
    expect(kept.has("status")).toBe(false); // status goes first, though it's recent
    expect(kept.has("old-fact")).toBe(false); // then the stalest
    expect(kept.has("new-fact")).toBe(true);
    // Under the high mark nothing moves.
    expect(chooseCore(notes.slice(0, 3), limit).size).toBe(3);
    expect(CORE_HIGH).toBeGreaterThan(CORE_LOW);
  });

  it("brings a lasting note back in once it keeps being recalled, while there's room", () => {
    const notes = [
      note("core", "A lasting fact in every turn", {}),
      note("useful", "Partners refer about one order a month", { inCore: false, recallCount: PROMOTE_AFTER_RECALLS, recalledDaysAgo: 0 }),
      note("status", "Campaign 9876543 paused on 11/10", { inCore: false, recallCount: 9, recalledDaysAgo: 0 }),
      note("rare", "A note recalled once", { inCore: false, recallCount: 1 }),
    ];
    const kept = chooseCore(notes, 6000);
    expect([...kept].sort()).toEqual(["core", "useful"]);
  });
});

/** Words no other note shares (so notes aren't merged as near-duplicates). */
const distinct = (seed: number, count: number) => Array.from({ length: count }, (_, j) => `k${seed}q${j}`).join(" ");

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("notes kept for good, searched and pulled into turns", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-notes-"));
    for (const [env, name] of [
      ["TETHR_MEMORY_FILE", "memory.json"],
      ["TETHR_CHATS_FILE", "chats.json"],
      ["TETHR_INTEGRATIONS_FILE", "integrations.json"],
      ["TETHR_SETUP_FILE", "setup.json"],
      ["TETHR_GROWTH_MAP_FILE", "map.json"],
    ] as const) {
      process.env[env] = path.join(dir, name);
    }
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-notes-");
    db = createDb(tempDb.connectionString);
    const { seedTethrCore } = await import("../tethr/seed/tethr-core.ts");
    companyId = (await seedTethrCore(db)).companyId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("brings the notes already in memory into the table once, with who saved them", async () => {
    const { changeMemory } = await import("../tethr/hermes/memory-layer.ts");
    const { notesService } = await import("../tethr/memory/notes.ts");
    await changeMemory(companyId, "company", [{ action: "add", content: "Wandr sells travel prescriptions through a licensed visit." }], { by: "Sam" });
    await notesService(db).importAndCurate(companyId);
    await notesService(db).importAndCurate(companyId);
    const rows = await db.select().from(tethrMemoryNotes).where(eq(tethrMemoryNotes.companyId, companyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ savedBy: "Sam", inCore: true, target: "company" });
  });

  it("never refuses a note for space: the always-loaded set stays lean and everything is kept", async () => {
    const { notesService } = await import("../tethr/memory/notes.ts");
    const { memorySnapshot } = await import("../tethr/hermes/memory-layer.ts");
    const svc = notesService(db);
    const topics = ["referral partners", "clinic pricing", "malaria season", "search ads", "email nurture", "landing pages", "travel insurers", "blog topics", "pharmacy partners", "visit pricing", "spring travel", "altitude trips", "student travel", "cruise lines", "safari travel", "conference travel", "corporate travel", "family trips", "backpackers", "retirees"];
    for (const [i, topic] of topics.entries()) {
      const status = i % 4 === 0 ? ` Campaign ${1_000_000 + i} went live at $30/day.` : "";
      await svc.add(companyId, { target: "company", text: `About ${topic}: ${distinct(i, 55)}.${status}`, by: "@tethr" });
    }
    const snapshot = memorySnapshot(companyId).stores.company;
    expect(snapshot.used).toBeLessThanOrEqual(snapshot.limit * CORE_HIGH);
    const counts = await svc.counts(companyId);
    expect(counts.core + counts.kept).toBe(21);
    expect(counts.kept).toBeGreaterThan(0);
    // Status notes left first.
    const rows = await db.select().from(tethrMemoryNotes).where(and(eq(tethrMemoryNotes.companyId, companyId), eq(tethrMemoryNotes.inCore, true)));
    expect(rows.some((r) => /went live/.test(r.text))).toBe(false);
    // The table and the file agree.
    expect(rows.map((r) => r.text).sort()).toEqual(snapshot.entries.map((e) => e.text).sort());
  });

  it("finds notes by meaning-ish words, pulls the right ones into a turn, and merges a near-duplicate", async () => {
    const { notesService } = await import("../tethr/memory/notes.ts");
    const svc = notesService(db);
    const { note: budgetNote } = await svc.add(companyId, { target: "company", text: "Mark approved a $1,200 a month test budget for Google search ads.", by: "@tethr" });
    const hits = await svc.search(companyId, "what is our google ads budget");
    expect(hits[0]!.text).toContain("$1,200");
    // More notes push the always-loaded set over its mark; the status-like budget note moves out first.
    for (let i = 100; i < 112; i++) await svc.add(companyId, { target: "company", text: `Lasting note ${i}: ${distinct(i, 55)}.`, by: "@tethr" });
    expect((await svc.get(companyId, budgetNote.id))!.inCore).toBe(false);
    // A turn about the budget gets it (it's status-like, so it isn't loaded every turn).
    const forTurn = await svc.relevantForTurn(companyId, "How much should we spend on Google search ads next month?");
    expect(forTurn.map((n) => n.text)).toContain("Mark approved a $1,200 a month test budget for Google search ads.");
    expect(forTurn.length).toBeLessThanOrEqual(6);
    expect((await svc.relevantForTurn(companyId, "Tell me a joke about penguins and icebergs please"))).toEqual([]);
    // Saying it again in other words updates the note instead of adding another.
    const again = await svc.add(companyId, { target: "company", text: "Mark approved a $1,200 a month test budget for Google search ads, starting in December.", by: "@tethr" });
    expect(again.duplicate).toBe(true);
    const budget = await svc.search(companyId, "test budget google search ads");
    expect(budget.filter((n) => /test budget/.test(n.text))).toHaveLength(1);
  });

  it("lets an agent change only its own notes, and a person pin, retire and remove", async () => {
    const { notesService, NoteError } = await import("../tethr/memory/notes.ts");
    const svc = notesService(db);
    const { note } = await svc.add(companyId, { target: "company", text: "The clinic partner program pays per completed visit.", by: "@partners", agentTag: "@partners" });
    await expect(svc.patch(companyId, { target: "company", oldText: "clinic partner program", text: "Changed by another agent.", by: "@paid-ads", agentTag: "@paid-ads" })).rejects.toThrow(NoteError);
    const mine = await svc.patch(companyId, { target: "company", oldText: "clinic partner program", text: "The clinic partner program pays $20 per completed visit.", by: "@partners", agentTag: "@partners" });
    expect(mine.text).toContain("$20");
    const pinned = await svc.pin(companyId, note.id, true);
    expect(pinned).toMatchObject({ pinned: true, inCore: true });
    const retired = await svc.retire(companyId, note.id);
    expect(retired).toMatchObject({ status: "retired", inCore: false });
    expect((await svc.search(companyId, "clinic partner program", { includeRetired: true })).map((n) => n.id)).toContain(note.id);
    expect((await svc.search(companyId, "clinic partner program")).map((n) => n.id)).not.toContain(note.id);
    await svc.remove(companyId, { target: "company", id: note.id });
    expect(await svc.get(companyId, note.id)).toBeNull();
  });
});
