import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, tethrDecisions, tethrInboxItems, tethrMembers, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import {
  calibrate,
  decideWithJev,
  decisionMode,
  decisionStore,
  kindStats,
  resolveDecision,
  setDecisionMode,
  spentThisMonth,
} from "../tethr/decide/decide.ts";
import { AUTO_MIN_DECISIONS } from "../tethr/decide/kinds.ts";
import { destinationFolders, INBOX_DIR, inboxService, protectedFolder } from "../tethr/inbox/pipeline.ts";
import { readFileText } from "../tethr/inbox/read.ts";
import { inboxStore } from "../tethr/inbox/store.ts";
import { needsPersonReason, secretReason } from "../tethr/screen.ts";
import type { JevAnswer, JevQuestion, JevResponse } from "../tethr/jev.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 26.2 + 26.3: the decision service (Jev, the record, calibration,
// earning and losing Automatic, the spend cap) and the Inbox (intake, the check
// on the Mac, one Jev request, suggest or file, put back, tell or hand off,
// rules learned from corrections).

describe("decisions: the confidence bar", () => {
  const rows = (spec: Array<[number, boolean]>) => spec.map(([confidence, right]) => ({ confidence, right }));
  it("is the lowest confidence where at least 95% of picks were right", () => {
    const r = rows([...Array.from({ length: 20 }, (_, i): [number, boolean] => [0.99 - i * 0.01, true]), [0.7, false], [0.6, false], [0.5, true]]);
    // At 0.7: 20 of 21 right (95.2%); lower, it falls under 95%.
    expect(calibrate(r)).toBeCloseTo(0.7, 5);
  });
  it("is out of reach when Jev is wrong too often at the top", () => {
    expect(calibrate(rows([[0.99, false], [0.98, true], [0.97, false], [0.96, true], [0.95, true]]))).toBe(Infinity);
    expect(calibrate(rows([[0.9, true]]))).toBe(Infinity); // fewer than 5
  });
});

describe("the check on the Mac", () => {
  it("stops card numbers and keys, and passes ordinary numbers", () => {
    expect(secretReason("Card 4242 4242 4242 4242 exp 12/30")).toContain("payment card");
    expect(secretReason("key: sk_live_abcdefghijklmnop1234")).toContain("Stripe");
    expect(secretReason("-----BEGIN PRIVATE KEY-----\nabc")).toContain("private key");
    expect(secretReason("Invoice 2026-118, order 4242 4242 4242 4241, total $1,240.00")).toBeNull();
    expect(secretReason("Call +1 415 555 0100")).toBeNull();
    expect(needsPersonReason("Sarah Jones was diagnosed with malaria after her trip.")).toContain("health");
    expect(needsPersonReason("Malaria pills are our top seller in March.")).toBeNull();
  });
});

describe("reading a file", () => {
  it("reads text and judges a PDF by name when it can't read it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-read-"));
    fs.writeFileSync(path.join(dir, "notes.md"), "# Partner notes\nTwo clinics.");
    fs.writeFileSync(path.join(dir, "scan.pdf"), "%PDF-1.4 not really");
    fs.writeFileSync(path.join(dir, "photo.png"), "x");
    expect(await readFileText(path.join(dir, "notes.md"))).toEqual({ text: "# Partner notes\nTwo clinics.", how: "text" });
    process.env.TETHR_PDFTOTEXT = "/nonexistent/pdftotext";
    expect(await readFileText(path.join(dir, "scan.pdf"))).toEqual({ text: null, how: "name" });
    delete process.env.TETHR_PDFTOTEXT;
    expect((await readFileText(path.join(dir, "photo.png"))).how).toBe("name");
  });

  it("never files into its Inbox, the archive, its workspace or a hidden folder", () => {
    expect(protectedFolder("00 Inbox")).toBe(true);
    expect(protectedFolder("99 Archive/2026")).toBe(true);
    expect(protectedFolder("tethr/files")).toBe(true);
    expect(protectedFolder("05 Finance/.git")).toBe(true);
    expect(protectedFolder("05 Finance/Invoices")).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

type Ask = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResponse>;

/** A stand-in Jev: answers each question with the option whose label matches `picks`, at `confidence`. */
function fakeJev(picks: Record<string, string>, confidence = 0.8, seen: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = []): Ask {
  return async (state, questions) => {
    seen.push({ state, questions });
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      if (q.type !== "choice") continue;
      const keys = Object.keys(q.criteria);
      const want = picks[id];
      const key = keys.find((k) => (q.criteria[k] ?? "").startsWith(want ?? "\u0000")) ?? keys[0];
      const rest = keys.filter((k) => k !== key);
      answers[id] = {
        type: "choice",
        choice: key,
        confidence,
        probabilities: Object.fromEntries([[key, confidence], ...rest.map((k, i) => [k, (1 - confidence) / (i + 2)])]),
      };
    }
    return { model: "jev-test", answers, usage: { input_tokens: 1000, output_tokens: 0 }, costUsd: 0.0001 };
  };
}

describePg("decisions and the Inbox", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  let drive!: string;
  const told: Array<{ who: string; text: string }> = [];
  let clock = new Date("2026-11-09T18:00:00Z");
  const later = (ms: number) => (clock = new Date(clock.getTime() + ms));

  const PICKS = { inbox_type: "invoice", inbox_destination: "05 Finance / Invoices", inbox_notify: "Sam", inbox_urgency: "this week" };
  const svc = (ask: Ask, confidence?: number) =>
    inboxService(db, { ask: ask as never, now: clock, tell: async (_db, _c, who, text) => void told.push({ who, text }) });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-inbox-"));
    drive = path.join(dir, "00 Tethr");
    for (const f of ["01 Briefs", "05 Finance/Invoices", "05 Finance/Contracts", "Partners", "99 Archive", "tethr/files", ".hidden"]) fs.mkdirSync(path.join(drive, f), { recursive: true });
    process.env.TETHR_MIRROR_DIR = drive;
    process.env.TETHR_MIRROR_ALLOW_TEST = "1";
    process.env.TETHR_DECISIONS_FILE = path.join(dir, "decisions.json");
    process.env.TETHR_INBOX_FILE = path.join(dir, "inbox.json");
    process.env.TETHR_CHATS_FILE = path.join(dir, "chats.json");
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_WORKSPACE_DIR = path.join(drive, "tethr");
    process.env.TYPESAFE_API_KEY = "test-key";
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-inbox-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    await db.insert(tethrMembers).values({ companyId, name: "Sam", position: "growth", role: "admin" });
  }, 60_000);

  afterAll(async () => {
    delete process.env.TETHR_MIRROR_ALLOW_TEST;
    delete process.env.TYPESAFE_API_KEY;
    await tempDb?.cleanup();
  });

  beforeEach(() => {
    told.length = 0;
  });

  const drop = (name: string, text: string) => {
    fs.mkdirSync(path.join(drive, INBOX_DIR), { recursive: true });
    const abs = path.join(drive, INBOX_DIR, name);
    fs.writeFileSync(abs, text);
    const old = new Date(clock.getTime() - 60_000);
    fs.utimesSync(abs, old, old);
  };

  it("lists the real folders, never the protected ones", async () => {
    expect(await destinationFolders(drive)).toEqual(["01 Briefs", "05 Finance", "05 Finance/Contracts", "05 Finance/Invoices", "Partners"]);
  });

  it("waits until a file stops changing, then suggests where it goes", async () => {
    const seen: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = [];
    drop("acme-invoice-118.txt", "Invoice 118 from Acme Clinic. Total $1,240. Due Dec 1.");
    expect(await svc(fakeJev(PICKS, 0.8, seen)).scan(companyId)).toEqual([]); // first look: watching
    later(31_000);
    const [item] = await svc(fakeJev(PICKS, 0.8, seen)).scan(companyId);
    expect(item.status).toBe("suggested");
    expect(item.suggestion).toMatchObject({ type: "invoice", destination: "05 Finance / Invoices", notify: "Sam", urgency: "this week" });
    expect(item.suggestion!.alternatives).toHaveLength(2);
    // One request, four questions, the file's text, the real folders.
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].questions).sort()).toEqual(["inbox_destination", "inbox_notify", "inbox_type", "inbox_urgency"]);
    expect(JSON.stringify(seen[0].state)).toContain("Invoice 118 from Acme Clinic");
    const dests = Object.values((seen[0].questions.inbox_destination as { criteria: Record<string, string> }).criteria).join(" | ");
    expect(dests).not.toMatch(/Archive|Inbox|tethr/);
    // A card in the main chat, and four decisions on the record.
    const [card] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, item.cardRunId!));
    expect(card).toMatchObject({ sourceKey: "tethr-inbox", threadId: companyId });
    expect(await db.select().from(tethrDecisions).where(eq(tethrDecisions.subjectId, item.id))).toHaveLength(4);
    // Nothing is filed while it's a suggestion.
    expect(fs.existsSync(path.join(drive, INBOX_DIR, "acme-invoice-118.txt"))).toBe(true);

    // The person files it where Jev said, and tells Sam: both accepted.
    const filed = await svc(fakeJev(PICKS)).fileTo(companyId, item.id, "05 Finance / Invoices", { by: "a person" });
    expect(filed).toMatchObject({ status: "filed", filedTo: "05 Finance/Invoices/acme-invoice-118.txt" });
    expect(fs.existsSync(path.join(drive, "05 Finance/Invoices/acme-invoice-118.txt"))).toBe(true);
    await svc(fakeJev(PICKS)).routeTo(companyId, item.id, "Sam", {});
    expect(told).toEqual([{ who: "Sam", text: '"acme-invoice-118.txt" came into tethr\'s Inbox and is filed in 05 Finance / Invoices.' }]);
    const outcomes = await db.select({ kind: tethrDecisions.kind, outcome: tethrDecisions.outcome }).from(tethrDecisions).where(eq(tethrDecisions.subjectId, item.id));
    expect(Object.fromEntries(outcomes.map((o) => [o.kind, o.outcome]))).toEqual({
      "inbox.type": "dropped",
      "inbox.destination": "accepted",
      "inbox.notify": "accepted",
      "inbox.urgency": "dropped",
    });
    expect(inboxStore.get(companyId).folders?.["05 Finance/Invoices"]?.samples).toEqual(["acme-invoice-118.txt"]);
  });

  it("sends nothing to Jev for a file a person has to see first", async () => {
    let asked = 0;
    drop("card.txt", "Please charge 4242 4242 4242 4242 for the order.");
    later(31_000);
    await svc(async (...a) => (asked++, fakeJev(PICKS)(...a))).scan(companyId);
    later(31_000);
    const [item] = await svc(async (...a) => (asked++, fakeJev(PICKS)(...a))).scan(companyId);
    expect(asked).toBe(0);
    expect(item).toMatchObject({ status: "needs_person" });
    expect(item.note).toContain("payment card");
    expect(item.suggestion).toBeNull();
  });

  it("learns a rule from two corrections, and gives it to Jev from then on", async () => {
    const wrong = { ...PICKS, inbox_destination: "01 Briefs" };
    const ids: string[] = [];
    for (const name of ["acme-invoice-119.txt", "acme-invoice-120.txt"]) {
      const item = await svc(fakeJev(wrong)).create(companyId, { source: "chat", relPath: `${INBOX_DIR}/${name}`, name, size: 10 });
      fs.writeFileSync(path.join(drive, INBOX_DIR, name), "Invoice from Acme");
      await svc(fakeJev(wrong)).process(companyId, item.id);
      await svc(fakeJev(wrong)).fileTo(companyId, item.id, "05 Finance / Invoices", { by: "a person" });
      ids.push(item.id);
    }
    const [d] = await db.select().from(tethrDecisions).where(eq(tethrDecisions.subjectId, ids[0]));
    const dest = (await db.select().from(tethrDecisions).where(eq(tethrDecisions.subjectId, ids[0]))).find((r) => r.kind === "inbox.destination")!;
    expect(dest).toMatchObject({ outcome: "corrected", correctedTo: "05 Finance / Invoices" });
    expect(d).toBeTruthy();
    const rules = inboxStore.get(companyId).rules ?? [];
    expect(rules).toEqual([expect.objectContaining({ text: "Invoices go to 05 Finance / Invoices", status: "proposed" })]);
    await svc(fakeJev(wrong)).decideRule(companyId, rules[0].id, true);
    const seen: Array<{ state: unknown; questions: Record<string, JevQuestion> }> = [];
    const item = await svc(fakeJev(PICKS, 0.8, seen)).create(companyId, { source: "chat", relPath: `${INBOX_DIR}/x.txt`, name: "x.txt", size: 1 });
    fs.writeFileSync(path.join(drive, INBOX_DIR, "x.txt"), "Invoice");
    await svc(fakeJev(PICKS, 0.8, seen)).process(companyId, item.id);
    expect((seen[0].state as { filing_rules: string[] }).filing_rules).toEqual(["Invoices go to 05 Finance / Invoices"]);
  });

  it("files on its own only once a kind has earned Automatic, puts it back, and loses Automatic after two undos", async () => {
    await expect(setDecisionMode(db, companyId, "inbox.destination", "auto")).rejects.toThrow(`Needs ${AUTO_MIN_DECISIONS}`);
    await expect(setDecisionMode(db, companyId, "inbox.type", "auto")).rejects.toThrow("never runs on its own");
    // Twenty accepted answers earn it.
    for (let i = 0; i < AUTO_MIN_DECISIONS; i++) {
      const r = await decideWithJev(db, companyId, { label: `f${i}`, state: {}, asks: [{ kind: "inbox.destination", instructions: "?", options: [{ key: "a", label: "A", description: "A" }, { key: "b", label: "B", description: "B" }] }] }, { ask: fakeJev({}, 0.97) as never });
      if (!r.ok) throw new Error(r.detail);
      await resolveDecision(db, companyId, r.results["inbox.destination"].decisionId, "accepted");
    }
    await setDecisionMode(db, companyId, "inbox.destination", "auto");
    const stats = (await kindStats(db, companyId)).find((s) => s.key === "inbox.destination")!;
    // Earlier tests' answers count too (one accepted, two corrected): 21 of 23 is over 90%.
    expect(stats.backtest).toMatch(/what you went with in 21 of the last 23/);
    expect(stats.autoBlocked).toBeNull();

    const autoFile = async (name: string) => {
      const item = await svc(fakeJev(PICKS, 0.99)).create(companyId, { source: "drive", relPath: `${INBOX_DIR}/${name}`, name, size: 1 });
      fs.writeFileSync(path.join(drive, INBOX_DIR, name), "Invoice");
      return svc(fakeJev(PICKS, 0.99)).process(companyId, item.id);
    };
    const a = await autoFile("auto-1.txt");
    expect(a).toMatchObject({ status: "filed", filedBy: "tethr (automatic)", filedTo: "05 Finance/Invoices/auto-1.txt" });
    const back = await svc(fakeJev(PICKS)).putBack(companyId, a.id);
    expect(back).toMatchObject({ status: "suggested", relPath: `${INBOX_DIR}/auto-1.txt` });
    expect(decisionMode(companyId, "inbox.destination")).toBe("auto");
    const b = await autoFile("auto-2.txt");
    await svc(fakeJev(PICKS)).putBack(companyId, b.id);
    expect(decisionMode(companyId, "inbox.destination")).toBe("suggest");
    expect(decisionStore.get(companyId).demoted?.map((d) => d.kind)).toEqual(["inbox.destination"]);
  });

  it("hands a file to nobody without Jev when it's off, over the cap, or down", async () => {
    await decisionStore.update(companyId, (s) => ({ ...s, monthlyCapUsd: 0 }));
    const r = await decideWithJev(db, companyId, { label: "x", state: {}, asks: [{ kind: "inbox.type", instructions: "?", options: [{ key: "a", label: "A", description: null }, { key: "b", label: "B", description: null }] }] }, { ask: fakeJev({}) as never });
    expect(r).toMatchObject({ ok: false, reason: "over_cap" });
    await decisionStore.update(companyId, (s) => ({ ...s, monthlyCapUsd: 5 }));
    expect(await spentThisMonth(db, companyId)).toBeGreaterThan(0);
    const down = await decideWithJev(db, companyId, { label: "x", state: {}, asks: [{ kind: "inbox.type", instructions: "?", options: [{ key: "a", label: "A", description: null }, { key: "b", label: "B", description: null }] }] }, {
      ask: (async () => {
        throw new Error("down");
      }) as never,
    });
    expect(down).toMatchObject({ ok: false, reason: "jev_error" });
    const off = await decideWithJev(db, companyId, { label: "x", state: {}, asks: [{ kind: "report.urgency", instructions: "?", options: [{ key: "a", label: "A", description: null }, { key: "b", label: "B", description: null }] }] }, { ask: fakeJev({}) as never });
    expect(off).toMatchObject({ ok: false, reason: "off" });
  });

  it("serves the Inbox to people, files only into real folders, and copies a chat upload in", async () => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const appFor = (actor: Record<string, unknown>) => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", tethrRoutes(db));
      return app;
    };
    const mark = appFor({ type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true });
    const agent = appFor({ type: "agent", agentId: "a1", companyId });
    const list = await request(mark).get(`/api/tethr/${companyId}/inbox`).expect(200);
    expect(list.body.connected).toBe(true);
    expect(list.body.folders).toContain("05 Finance / Invoices");
    const open = list.body.open.find((i: { status: string }) => i.status === "suggested");
    await request(agent).post(`/api/tethr/${companyId}/inbox/${open.id}/file`).send({ destination: "Partners" }).expect(403);
    await request(mark).post(`/api/tethr/${companyId}/inbox/${open.id}/file`).send({ destination: "../../etc" }).expect(409);
    await request(mark).post(`/api/tethr/${companyId}/inbox/${open.id}/file`).send({ destination: "99 Archive" }).expect(409);
    await request(mark).post(`/api/tethr/${companyId}/inbox/file-this`).send({ path: "../CLAUDE.md" }).expect(409);
    fs.mkdirSync(path.join(drive, "tethr/files/uploads"), { recursive: true });
    fs.writeFileSync(path.join(drive, "tethr/files/uploads/brief.md"), "Partner brief for the clinics");
    process.env.TYPESAFE_API_KEY = "";
    const taken = await request(mark).post(`/api/tethr/${companyId}/inbox/file-this`).send({ path: "files/uploads/brief.md" }).expect(200);
    process.env.TYPESAFE_API_KEY = "test-key";
    expect(taken.body).toMatchObject({ source: "chat", status: "needs_person", relPath: `${INBOX_DIR}/brief.md` });
    expect(taken.body.note).toContain("Jev isn't set up");
    expect(fs.existsSync(path.join(drive, "tethr/files/uploads/brief.md"))).toBe(true); // the chat keeps its copy
    const [row] = await db.select().from(tethrInboxItems).where(eq(tethrInboxItems.id, taken.body.id));
    expect(JSON.stringify(row)).not.toContain("Partner brief for the clinics"); // content is never stored
  });
});
