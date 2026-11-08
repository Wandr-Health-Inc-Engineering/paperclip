import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, ilike, or } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createDb, tethrIdeas, tethrNotifications, tethrRouteRuns } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import * as chats from "../tethr/chats.ts";
import { companyProfileService } from "../tethr/company.ts";
import { goalsService } from "../tethr/goals.ts";
import { getPace } from "../tethr/pace.ts";
import { getSetup, updateSetup } from "../tethr/setup.ts";
import {
  _resetWatchForTests,
  _watchStateForTests,
  hasSubstance,
  hear,
  ideasThreadId,
  NO_IDEA,
  prune,
  setBotUserIdForTests,
  settledConversations,
  sweepOutcomes,
  WATCH,
  watchTick,
} from "../tethr/watch.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 21: tethr watches Slack conversations, goals and quiet stretches, and
// offers ideas — in the thread, the main chat and the bell — at a pace that
// adapts to how people respond.

const MONDAY_10AM_ET = new Date("2026-11-09T15:00:00Z");
const msg = (text: string, o: { user?: string; channel?: string; thread?: string; ts?: string; type?: string; extra?: Record<string, unknown> } = {}) => ({
  type: "event_callback",
  event: {
    type: "message",
    channel_type: o.type ?? "channel",
    channel: o.channel ?? "CGROWTH",
    user: o.user ?? "UMARK001",
    text,
    ts: o.ts ?? `${Math.random()}`.slice(2, 12),
    ...(o.thread ? { thread_ts: o.thread } : {}),
    ...(o.extra ?? {}),
  },
});
const TALK = [
  "Should we push the malaria-secret-phrase guide to the travel clinics before spring break?",
  "Yes, but the clinics want something they can hand to patients, not a blog post link.",
  "Then a one-page printable plus a referral code per clinic, so we can count what comes in.",
];

beforeEach(() => _resetWatchForTests());

describe("tethr watch — hearing Slack", () => {
  it("hears people in channels tethr is in, and nothing else", () => {
    const t = MONDAY_10AM_ET.getTime();
    hear(msg("bot talking", { extra: { bot_id: "B1" } }), t);
    hear(msg("a DM to tethr is a request, not chatter", { type: "im" }), t);
    hear(msg("joined", { extra: { subtype: "channel_join" } }), t);
    hear(msg("   "), t);
    hear({ type: "url_verification" }, t);
    expect(_watchStateForTests().conversations.size).toBe(0);
    hear(msg("a real message in a private channel", { type: "group", channel: "CPRIV" }), t);
    hear(msg("and one in a group DM", { type: "mpim", channel: "GMPIM" }), t);
    hear(msg("a thread reply", { thread: "111.222" }), t);
    expect([..._watchStateForTests().conversations.keys()].sort()).toEqual(["CGROWTH:111.222", "CPRIV:main", "GMPIM:main"]);
  });

  it("stays out of a conversation where someone asked tethr directly", () => {
    setBotUserIdForTests("UBOT");
    const t = MONDAY_10AM_ET.getTime();
    hear(msg("<@UBOT> what's our churn?"), t);
    expect(_watchStateForTests().conversations.size).toBe(0);
    expect(_watchStateForTests().cooldownUntil.get("CGROWTH:main")).toBeGreaterThan(t);
  });

  it("forgets everything after two hours", () => {
    const t = MONDAY_10AM_ET.getTime();
    for (const line of TALK) hear(msg(line), t);
    prune(t + WATCH.maxAgeMs - 1);
    expect(_watchStateForTests().conversations.size).toBe(1);
    prune(t + WATCH.maxAgeMs);
    expect(_watchStateForTests().conversations.size).toBe(0);
  });

  it("waits for a conversation to settle, and skips small talk", () => {
    const t = MONDAY_10AM_ET.getTime();
    for (const line of ["hi", "morning", "yo"]) hear(msg(line, { channel: "CSMALL" }), t);
    for (const line of TALK) hear(msg(line), t);
    expect(settledConversations(t + WATCH.settleMs - 1)).toHaveLength(0);
    const settled = settledConversations(t + WATCH.settleMs);
    expect(settled.map((c) => c.key)).toEqual(["CGROWTH:main"]);
    expect(hasSubstance([{ user: "u", text: "ok", ts: "1", at: 0 }])).toBe(false);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr watch — ideas", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  const calls: Array<{ prompt: string; extraArgs: string[] }> = [];
  let reply = "Turn the guide into a one-page printable with a referral code per clinic, so each clinic's patients can be counted. It moves Partnerships & distribution. First step: draft the printable for the two clinics you named.";
  const posts: Array<{ channel?: string; threadTs?: string; text: string }> = [];
  const post = async (m: { channel?: string; threadTs?: string; text: string }) => {
    posts.push(m);
    return { ok: true };
  };
  const realFetch = globalThis.fetch;

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    calls.push({ prompt: String(ctx.context.tethrPrompt), extraArgs: ((ctx.config as Record<string, unknown>).extraArgs as string[]) ?? [] });
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: reply, is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };
  const paceFile = () => path.join(dir, "pace.json");
  const heardTalk = (t: number, channel = "CGROWTH") => {
    TALK.forEach((line, i) => hear(msg(line, { channel, ts: `1700000000.00000${i}`, user: i % 2 ? "UALEC001" : "UMARK001" }), t));
  };
  const appFor = async () => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };
      next();
    });
    app.use("/api", tethrRoutes(db));
    return app;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-watch-"));
    for (const [k, f] of Object.entries({
      TETHR_SETUP_FILE: "setup.json",
      TETHR_CHATS_FILE: "chats.json",
      TETHR_INTEGRATIONS_FILE: "integrations.json",
      TETHR_PAUSED_FILE: "paused.json",
      TETHR_OVERSEERS_FILE: "overseers.json",
      TETHR_PACE_FILE: "pace.json",
    })) process.env[k] = path.join(dir, f);
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("auth.test")) return new Response(JSON.stringify({ ok: true, user_id: "UBOT" }));
      if (u.includes("conversations.info")) return new Response(JSON.stringify({ ok: true, channel: { name: "growth" } }));
      return realFetch(url, init);
    }) as typeof fetch;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-watch-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    await companyProfileService(db).saveCompanyStep(companyId, { companyName: "Wandr Health", adminName: "Mark Karam", position: "coo", slackUserId: "UMARK001" });
    setAssistantRunnerForTests(assistantRunner(db, { execute: fakeExecute }));
  }, 60_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    delete process.env.SLACK_BOT_TOKEN;
    setAssistantRunnerForTests(null);
    resetAssistantRunnerForTests();
    await tempDb?.cleanup();
  });

  afterEach(() => {
    posts.length = 0;
    fs.rmSync(paceFile(), { force: true });
  });

  it("offers one idea from a settled conversation: in its thread, the main chat and the bell", async () => {
    const t = MONDAY_10AM_ET.getTime();
    heardTalk(t - 10 * 60 * 1000);
    const before = calls.length;
    const out = await watchTick(db, MONDAY_10AM_ET, { pollMs: 20, post });
    expect(out.looked).toBe("slack");
    expect(out.idea).toMatchObject({ source: "slack", origin: "#growth", status: "new", slackChannel: "CGROWTH", slackThreadTs: "1700000000.000002" });
    expect(out.idea!.title).toBe("Turn the guide into a one-page printable with a referral code per clinic, so each clinic's…");

    // The model got the conversation, with names; one-off, no session saved.
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.prompt).toContain("Mark (COO / Operations): Should we push the malaria-secret-phrase guide");
    expect(calls.at(-1)!.prompt).toContain("Teammate A: Yes, but the clinics want something");
    expect(calls.at(-1)!.prompt).toContain(NO_IDEA);
    expect(calls.at(-1)!.extraArgs).toContain("--no-session-persistence");
    expect(chats.getSession(companyId, ideasThreadId(companyId))).toBeNull();

    // Slack: a reply in that conversation's thread.
    expect(posts).toEqual([{ channel: "CGROWTH", threadTs: "1700000000.000002", text: expect.stringMatching(/^\*Idea from tethr\*\nTurn the guide/) }]);
    // The main chat: a card, and a note for the next turn.
    const [card] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, out.idea!.cardRunId!));
    expect(card).toMatchObject({ threadId: companyId, sourceKey: "tethr-idea", status: "done", requestText: "Idea from tethr · #growth" });
    expect((await chats.takeNotes(companyId, companyId)).some((n) => n.includes("one-page printable"))).toBe(true);
    // The bell.
    const bells = await db.select().from(tethrNotifications).where(and(eq(tethrNotifications.companyId, companyId), eq(tethrNotifications.kind, "idea")));
    expect(bells.length).toBe(1);

    // Nothing of the conversation itself is kept anywhere in tethr.
    const leaked = await db
      .select({ id: tethrRouteRuns.id })
      .from(tethrRouteRuns)
      .where(or(ilike(tethrRouteRuns.requestText, "%malaria-secret-phrase%"), ilike(tethrRouteRuns.resultText, "%malaria-secret-phrase%")));
    expect(leaked).toEqual([]);
    const [turn] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, out.idea!.routeRunId!));
    expect(turn.requestText).toBe("Idea check: a Slack conversation in #growth (3 messages)");

    // It doesn't speak up in the same conversation again right away.
    hear(msg("one more thought on the clinics and the printable referral codes, worth a look", { ts: "1700000000.000009" }), t + 60_000);
    const again = await watchTick(db, new Date(t + WATCH.settleMs + 120_000), { pollMs: 20, post });
    expect(again.looked).toBeNull();

    // A reply in tethr's thread counts as answering the idea.
    hear(msg("love it, doing this today", { thread: "1700000000.000002", user: "UALEC001" }), t + 5 * 60_000);
    await new Promise((r) => setTimeout(r, 200));
    const [answered] = await db.select().from(tethrIdeas).where(eq(tethrIdeas.id, out.idea!.id));
    expect(answered.status).toBe("answered");
    expect(getPace(companyId, getSetup(companyId).ideas).allowance).toBeCloseTo(1.25);
  });

  it("an idea check that finds nothing says nothing, and gives its turn back", async () => {
    reply = NO_IDEA;
    try {
      const t = MONDAY_10AM_ET.getTime();
      heardTalk(t - 10 * 60 * 1000, "CNOTHING");
      const out = await watchTick(db, MONDAY_10AM_ET, { pollMs: 20, post });
      expect(out).toEqual({ idea: null, looked: "slack" });
      expect(posts).toEqual([]);
      expect(getPace(companyId, getSetup(companyId).ideas, MONDAY_10AM_ET).bank).toBe(1);
    } finally {
      reply = "Turn the guide into a one-page printable. It moves Partnerships & distribution.";
    }
  });

  it("outside working hours, or with listening off, nothing is looked at", async () => {
    const sunday = new Date("2026-11-08T15:00:00Z");
    heardTalk(sunday.getTime() - 10 * 60 * 1000, "CWEEKEND");
    const before = calls.length;
    expect(await watchTick(db, sunday, { pollMs: 20, post })).toEqual({ idea: null, looked: null });
    expect(settledConversations(sunday.getTime() + 60_000)).toHaveLength(0); // dropped, not queued

    await updateSetup(companyId, (s) => ({ ...s, ideas: { ...s.ideas, slackListen: false } }));
    try {
      heardTalk(MONDAY_10AM_ET.getTime() - 10 * 60 * 1000, "COFF");
      const out = await watchTick(db, new Date(MONDAY_10AM_ET.getTime() + 3 * 3600_000), { pollMs: 20, post });
      expect(out.looked).not.toBe("slack");
    } finally {
      await updateSetup(companyId, (s) => ({ ...s, ideas: { ...s.ideas, slackListen: true } }));
    }
    expect(calls.filter((c) => c.prompt.includes("CWEEKEND") || c.prompt.includes("#weekend")).length).toBe(0);
    void before;
  });

  it("a goal behind pace twice gets an idea, sent to the admin directly", async () => {
    _resetWatchForTests();
    const svc = goalsService(db);
    const area = await svc.saveGoal(companyId, { title: "New customers" });
    const m = await svc.saveMetric(companyId, { goal_id: area.id, name: "New paying customers", unit: "count", baseline: 100, baseline_at: "2026-09-01", target: 200, target_date: "2027-03-01", method: "Stripe: first charges, 30 days" });
    await svc.recordMeasurement(companyId, m.id, { value: 101, at: "2026-10-15" });
    await svc.recordMeasurement(companyId, m.id, { value: 102, at: "2026-11-01" });
    const out = await watchTick(db, new Date("2026-11-10T15:00:00Z"), { pollMs: 20, post });
    expect(out.looked).toBe("goals");
    expect(out.idea).toMatchObject({ source: "goals", origin: "New paying customers" });
    expect(calls.at(-1)!.prompt).toContain("has been behind pace for the last two measurements");
    expect(posts.at(-1)).toMatchObject({ channel: "UMARK001" }); // a DM to the admin
    // Once a week per metric.
    _resetWatchForTests();
    const next = await watchTick(db, new Date("2026-11-11T15:00:00Z"), { pollMs: 20, post });
    expect(next.idea?.source).not.toBe("goals");
  });

  it("Useful and Not now tune the pace; ideas nobody answers become ignored", async () => {
    const app = await appFor();
    const ideas = await db.select().from(tethrIdeas).where(eq(tethrIdeas.companyId, companyId));
    const open = ideas.find((i) => i.status === "new")!;
    await request(app).post(`/api/tethr/${companyId}/ideas/${open.id}/feedback`).send({ verdict: "maybe" }).expect(400);
    const useful = await request(app).post(`/api/tethr/${companyId}/ideas/${open.id}/feedback`).send({ verdict: "useful" }).expect(200);
    expect(useful.body.status).toBe("useful");

    const stale = ideas.find((i) => i.status === "new" && i.id !== open.id);
    if (stale) {
      await sweepOutcomes(db, companyId, new Date(stale.createdAt.getTime() + WATCH.answerWindowMs + 1000));
      const [row] = await db.select().from(tethrIdeas).where(eq(tethrIdeas.id, stale.id));
      expect(row.status).toBe("ignored");
    }
    const list = await request(app).get(`/api/tethr/${companyId}/ideas`).expect(200);
    expect(list.body.length).toBeGreaterThan(0);
    // The chat's message list carries each idea card's idea.
    const runs = await request(app).get(`/api/tethr/${companyId}/chats/${companyId}/runs`).expect(200);
    const card = runs.body.find((r: { sourceKey: string | null }) => r.sourceKey === "tethr-idea");
    expect(card.idea).toMatchObject({ status: expect.any(String) });
  });
});
