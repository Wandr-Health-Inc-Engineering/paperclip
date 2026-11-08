import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, ilike, or } from "drizzle-orm";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { createDb, tethrIdeas, tethrNotifications, tethrRouteRuns, type Db } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { assistantRunner, resetAssistantRunnerForTests, setAssistantRunnerForTests } from "../tethr/assistant/runner.ts";
import * as chats from "../tethr/chats.ts";
import { companyProfileService } from "../tethr/company.ts";
import { goalsService } from "../tethr/goals.ts";
import { getPace } from "../tethr/pace.ts";
import { getSetup, updateSetup } from "../tethr/setup.ts";
import { HOUR, MINUTE } from "../tethr/time.ts";
import { deliverIdea, hasSubstance, ideasThreadId, ideaTitle, NO_IDEA, sweepOutcomes, WATCH, Watcher } from "../tethr/watch.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 21: tethr watches Slack conversations, goals and quiet stretches, and
// offers ideas — in the thread, the main chat and the bell — at a pace that
// adapts to how people respond.

const MONDAY_10AM_ET = new Date("2026-11-09T15:00:00Z");
const SUNDAY_10AM_ET = new Date("2026-11-08T15:00:00Z");
const TALK = [
  "Should we push the malaria-secret-phrase guide to the travel clinics before spring break?",
  "Yes, but the clinics want something they can hand to patients, not a blog post link.",
  "Then a one-page printable plus a referral code per clinic, so we can count what comes in.",
];

function slackMessage(text: string, o: { user?: string; channel?: string; thread?: string; ts?: string; type?: string; extra?: Record<string, unknown> } = {}) {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel_type: o.type ?? "channel",
      channel: o.channel ?? "CGROWTH",
      user: o.user ?? "UMARK001",
      text,
      ts: o.ts ?? "1700000000.000100",
      ...(o.thread ? { thread_ts: o.thread } : {}),
      ...(o.extra ?? {}),
    },
  };
}

/** Mark and Alec talk in a channel, `minutesAgo` before `now`. */
function hearTalk(watcher: Watcher, now: Date, channel = "CGROWTH", minutesAgo = 10) {
  const at = now.getTime() - minutesAgo * MINUTE;
  TALK.forEach((line, i) => watcher.hear(slackMessage(line, { channel, ts: `1700000000.00000${i}`, user: i % 2 ? "UALEC001" : "UMARK001" }), at));
}

describe("tethr watch — hearing Slack", () => {
  const watcher = (botUserId: string | null = null) => new Watcher({} as Db, { botUserId });

  it("hears people in channels tethr is in, and nothing else", () => {
    const w = watcher();
    const t = MONDAY_10AM_ET.getTime();
    w.hear(slackMessage("bot talking", { extra: { bot_id: "B1" } }), t);
    w.hear(slackMessage("a DM to tethr is a request, not chatter", { type: "im" }), t);
    w.hear(slackMessage("joined", { extra: { subtype: "channel_join" } }), t);
    w.hear(slackMessage("   "), t);
    w.hear({ type: "url_verification" }, t);
    expect(w.state.conversations.size).toBe(0);

    w.hear(slackMessage("a real message in a private channel", { type: "group", channel: "CPRIV" }), t);
    w.hear(slackMessage("and one in a group DM", { type: "mpim", channel: "GMPIM" }), t);
    w.hear(slackMessage("a thread reply", { thread: "111.222" }), t);
    expect([...w.state.conversations.keys()].sort()).toEqual(["CGROWTH:111.222", "CPRIV:main", "GMPIM:main"]);
  });

  it("stays out of a conversation where someone asked tethr directly", () => {
    const w = watcher("UBOT");
    const t = MONDAY_10AM_ET.getTime();
    w.hear(slackMessage("<@UBOT> what's our churn?"), t);
    expect(w.state.conversations.size).toBe(0);
    expect(w.state.cooldownUntil.get("CGROWTH:main")).toBeGreaterThan(t);
  });

  it("forgets everything after two hours", () => {
    const w = watcher();
    hearTalk(w, MONDAY_10AM_ET, "CGROWTH", 0);
    const t = MONDAY_10AM_ET.getTime();
    w.forgetOld(t + WATCH.maxAgeMs - 1);
    expect(w.state.conversations.size).toBe(1);
    w.forgetOld(t + WATCH.maxAgeMs);
    expect(w.state.conversations.size).toBe(0);
  });

  it("waits for a conversation to settle, and skips small talk", () => {
    const w = watcher();
    const t = MONDAY_10AM_ET.getTime();
    for (const line of ["hi", "morning", "yo"]) w.hear(slackMessage(line, { channel: "CSMALL" }), t);
    hearTalk(w, MONDAY_10AM_ET, "CGROWTH", 0);
    expect(w.settledConversations(t + WATCH.settleMs - 1)).toHaveLength(0);
    expect(w.settledConversations(t + WATCH.settleMs).map((c) => c.key)).toEqual(["CGROWTH:main"]);
    expect(hasSubstance([{ user: "u", text: "ok", ts: "1", at: 0 }])).toBe(false);
  });

  it("titles an idea with its first sentence, cut at a word when long", () => {
    expect(ideaTitle("Short idea. More detail.")).toBe("Short idea.");
    const long = ideaTitle(`${"word ".repeat(40)}end.`);
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("word…")).toBe(true);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr watch — ideas", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let dir!: string;
  const IDEA = "Turn the guide into a one-page printable with a referral code per clinic, so each clinic's patients can be counted. It moves Partnerships & distribution. First step: draft the printable for the two clinics you named.";
  let modelReply = IDEA;
  const modelCalls: Array<{ prompt: string; extraArgs: string[] }> = [];
  const slackPosts: Array<{ channel?: string; threadTs?: string; text: string }> = [];
  const post = async (m: { channel?: string; threadTs?: string; text: string }) => {
    slackPosts.push(m);
    return { ok: true };
  };
  const realFetch = globalThis.fetch;

  const fakeExecute = async (ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> => {
    modelCalls.push({ prompt: String(ctx.context.tethrPrompt), extraArgs: ((ctx.config as Record<string, unknown>).extraArgs as string[]) ?? [] });
    await ctx.onLog("stdout", JSON.stringify({ type: "result", result: modelReply, is_error: false }) + "\n");
    return { exitCode: 0, signal: null, timedOut: false, summary: "ok" };
  };
  const newWatcher = () => new Watcher(db, { post, pollMs: 20, botUserId: "UBOT" });
  const allowIdeas = () => updateSetup(companyId, (s) => ({ ...s, steps: { ...s.steps, rhythm: new Date().toISOString() } }));
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
    for (const [envKey, file] of Object.entries({
      TETHR_SETUP_FILE: "setup.json",
      TETHR_CHATS_FILE: "chats.json",
      TETHR_INTEGRATIONS_FILE: "integrations.json",
      TETHR_PAUSED_FILE: "paused.json",
      TETHR_OVERSEERS_FILE: "overseers.json",
      TETHR_PACE_FILE: "pace.json",
    })) process.env[envKey] = path.join(dir, file);
    process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("conversations.info")) return new Response(JSON.stringify({ ok: true, channel: { name: "growth" } }));
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
    slackPosts.length = 0;
    modelReply = IDEA;
    fs.rmSync(path.join(dir, "pace.json"), { force: true });
  });

  it("neither listens nor offers ideas before setup's ideas step", async () => {
    const watcher = newWatcher();
    hearTalk(watcher, MONDAY_10AM_ET, "CBEFORE");
    const callsBefore = modelCalls.length;
    expect(await watcher.tick(MONDAY_10AM_ET)).toEqual({ idea: null, looked: null });
    expect(watcher.state.conversations.size).toBe(0);
    expect(modelCalls.length).toBe(callsBefore);
    await allowIdeas();
  });

  it("offers one idea from a settled conversation: in its thread, the main chat and the bell", async () => {
    const watcher = newWatcher();
    hearTalk(watcher, MONDAY_10AM_ET);
    const out = await watcher.tick(MONDAY_10AM_ET);
    expect(out.looked).toBe("slack");
    expect(out.idea).toMatchObject({ source: "slack", origin: "#growth", status: "new", slackChannel: "CGROWTH", slackThreadTs: "1700000000.000002" });
    expect(out.idea!.title).toBe("Turn the guide into a one-page printable with a referral code per clinic, so each clinic's…");

    // The model got the conversation, with names; one-off, no session saved.
    const call = modelCalls.at(-1)!;
    expect(call.prompt).toContain("Mark (COO / Operations): Should we push the malaria-secret-phrase guide");
    expect(call.prompt).toContain("Teammate A: Yes, but the clinics want something");
    expect(call.prompt).toContain(NO_IDEA);
    expect(call.extraArgs).toContain("--no-session-persistence");
    expect(chats.getSession(companyId, ideasThreadId(companyId))).toBeNull();

    expect(slackPosts).toEqual([{ channel: "CGROWTH", threadTs: "1700000000.000002", text: expect.stringMatching(/^\*Idea from tethr\*\nTurn the guide/) }]);
    const [card] = await db.select().from(tethrRouteRuns).where(eq(tethrRouteRuns.id, out.idea!.cardRunId!));
    expect(card).toMatchObject({ threadId: companyId, sourceKey: "tethr-idea", status: "done", requestText: "Idea from tethr · #growth" });
    expect((await chats.takeNotes(companyId, companyId)).some((n) => n.includes("one-page printable"))).toBe(true);
    const bells = await db.select().from(tethrNotifications).where(and(eq(tethrNotifications.companyId, companyId), eq(tethrNotifications.kind, "idea")));
    expect(bells.length).toBeGreaterThan(0);
  });

  it("keeps nothing of the conversation it heard, only the idea", async () => {
    const watcher = newWatcher();
    hearTalk(watcher, MONDAY_10AM_ET, "CPRIVACY");
    await watcher.tick(MONDAY_10AM_ET);
    const leaked = await db
      .select({ id: tethrRouteRuns.id })
      .from(tethrRouteRuns)
      .where(or(ilike(tethrRouteRuns.requestText, "%malaria-secret-phrase%"), ilike(tethrRouteRuns.resultText, "%malaria-secret-phrase%")));
    expect(leaked).toEqual([]);
    const checks = await db.select({ text: tethrRouteRuns.requestText }).from(tethrRouteRuns).where(eq(tethrRouteRuns.threadId, ideasThreadId(companyId)));
    expect(checks.map((c) => c.text)).toContain("Idea check: a Slack conversation in #growth (3 messages)");
  });

  it("doesn't speak up in the same conversation again right away, and a reply in its thread answers the idea", async () => {
    const watcher = newWatcher();
    hearTalk(watcher, MONDAY_10AM_ET, "CREPLY");
    const first = await watcher.tick(MONDAY_10AM_ET);
    expect(first.idea).not.toBeNull();

    const later = new Date(MONDAY_10AM_ET.getTime() + WATCH.settleMs + 2 * MINUTE);
    watcher.hear(
      slackMessage("one more thought on the clinics and the printable referral codes, worth a look", { channel: "CREPLY", ts: "1700000000.000009" }),
      MONDAY_10AM_ET.getTime() + MINUTE,
    );
    expect((await watcher.tick(later)).looked).toBeNull();

    watcher.hear(slackMessage("love it, doing this today", { channel: "CREPLY", thread: "1700000000.000002", user: "UALEC001" }), MONDAY_10AM_ET.getTime() + 5 * MINUTE);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const [answered] = await db.select().from(tethrIdeas).where(eq(tethrIdeas.id, first.idea!.id));
    expect(answered.status).toBe("answered");
    expect(getPace(companyId, getSetup(companyId).ideas).allowance).toBeCloseTo(1.25);
  });

  it("an idea check that finds nothing says nothing, and gives its turn back", async () => {
    modelReply = NO_IDEA;
    const watcher = newWatcher();
    hearTalk(watcher, MONDAY_10AM_ET, "CNOTHING");
    expect(await watcher.tick(MONDAY_10AM_ET)).toEqual({ idea: null, looked: "slack" });
    expect(slackPosts).toEqual([]);
    expect(getPace(companyId, getSetup(companyId).ideas, MONDAY_10AM_ET).bank).toBe(1);
  });

  it("outside working hours it looks at nothing and drops what it heard", async () => {
    const watcher = newWatcher();
    hearTalk(watcher, SUNDAY_10AM_ET, "CWEEKEND");
    const callsBefore = modelCalls.length;
    expect(await watcher.tick(SUNDAY_10AM_ET)).toEqual({ idea: null, looked: null });
    expect(modelCalls.length).toBe(callsBefore);
    expect(watcher.settledConversations(SUNDAY_10AM_ET.getTime() + MINUTE)).toHaveLength(0);
  });

  it("with listening off, Slack conversations are never looked at", async () => {
    await updateSetup(companyId, (s) => ({ ...s, ideas: { ...s.ideas, slackListen: false } }));
    try {
      const watcher = newWatcher();
      hearTalk(watcher, MONDAY_10AM_ET, "COFF");
      const out = await watcher.tick(MONDAY_10AM_ET);
      expect(out.looked).not.toBe("slack");
      expect(watcher.state.conversations.get("COFF:main")!.evaluatedAt).toBe(0);
    } finally {
      await updateSetup(companyId, (s) => ({ ...s, ideas: { ...s.ideas, slackListen: true } }));
    }
  });

  it("a goal behind pace twice gets an idea, sent to the admin directly, once a week", async () => {
    const svc = goalsService(db);
    const area = await svc.saveGoal(companyId, { title: "New customers" });
    const metric = await svc.saveMetric(companyId, {
      goal_id: area.id,
      name: "New paying customers",
      unit: "count",
      baseline: 100,
      baseline_at: "2026-09-01",
      target: 200,
      target_date: "2027-03-01",
      method: "Stripe: first charges, 30 days",
    });
    await svc.recordMeasurement(companyId, metric.id, { value: 101, at: "2026-10-15" });
    await svc.recordMeasurement(companyId, metric.id, { value: 102, at: "2026-11-01" });
    const out = await newWatcher().tick(new Date("2026-11-10T15:00:00Z"));
    expect(out).toMatchObject({ looked: "goals", idea: { source: "goals", origin: "New paying customers" } });
    expect(modelCalls.at(-1)!.prompt).toContain("has been behind pace for the last two measurements");
    expect(slackPosts.at(-1)).toMatchObject({ channel: "UMARK001" });

    const nextDay = await newWatcher().tick(new Date("2026-11-11T15:00:00Z"));
    expect(nextDay.idea?.source).not.toBe("goals");
  });

  it("Useful and Not now are recorded and tune the pace", async () => {
    const app = await appFor();
    const deliver = (body: string) => deliverIdea(db, { companyId, source: "quiet", origin: "a quiet few days", body, runId: null }, new Date(), { post });
    const useful = await deliver("Try a referral code per clinic.");
    const notNow = await deliver("Write a partner one-pager.");

    await request(app).post(`/api/tethr/${companyId}/ideas/${useful.id}/feedback`).send({ verdict: "maybe" }).expect(400);
    expect((await request(app).post(`/api/tethr/${companyId}/ideas/${useful.id}/feedback`).send({ verdict: "useful" }).expect(200)).body.status).toBe("useful");
    expect(getPace(companyId, getSetup(companyId).ideas).allowance).toBeCloseTo(1.25);
    expect((await request(app).post(`/api/tethr/${companyId}/ideas/${notNow.id}/feedback`).send({ verdict: "not_now" }).expect(200)).body.status).toBe("not_now");
    expect(getPace(companyId, getSetup(companyId).ideas).allowance).toBeCloseTo(1.25 * 0.7);

    const runs = await request(app).get(`/api/tethr/${companyId}/chats/${companyId}/runs`).expect(200);
    const card = runs.body.find((r: { id: string }) => r.id === useful.cardRunId);
    expect(card.idea).toMatchObject({ id: useful.id, status: "useful" });
  });

  it("an idea nobody answers becomes ignored after a day; a main-chat message soon after one answers it", async () => {
    const created = new Date("2026-11-02T15:00:00Z");
    const deliver = (body: string) => deliverIdea(db, { companyId, source: "quiet", origin: "a quiet few days", body, runId: null }, created, { post });
    const ignored = await deliver("Idea nobody answers.");
    await sweepOutcomes(db, companyId, new Date(created.getTime() + WATCH.answerWindowMs + MINUTE));
    expect((await db.select().from(tethrIdeas).where(eq(tethrIdeas.id, ignored.id)))[0].status).toBe("ignored");

    const answered = await deliver("Idea someone answers in the chat.");
    await db.insert(tethrRouteRuns).values({
      companyId,
      requestText: "let's do that",
      invocationSource: "chat",
      threadId: companyId,
      status: "done",
      hops: [],
      createdAt: new Date(created.getTime() + HOUR),
    });
    await sweepOutcomes(db, companyId, new Date(created.getTime() + 2 * HOUR));
    expect((await db.select().from(tethrIdeas).where(eq(tethrIdeas.id, answered.id)))[0].status).toBe("answered");
  });
});
