import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, companies, costEvents, createDb, routines, routineTriggers, tethrAgentProfiles, tethrDriveNodes, tethrMemories } from "@paperclipai/db";
import { orgService } from "../tethr/org.ts";
import { routingService } from "../tethr/routing.ts";
import { seedWandrGrowth } from "../tethr/seed/seed.ts";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { memoryService } from "../tethr/memory.ts";
import {
  handleConversationReset,
  overseerMention,
  renderAgentsMessage,
  resolveContinuationThreadId,
  resolveOverseer,
  resolveTethrCompanyId,
  routeInboundKickoff,
} from "../tethr/slack.ts";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Phase 11 — the clean slate. One coordinator agent (@tethr) is the whole org:
// it absorbs every request (Slack tag/DM, Console chat), answers directly or
// drafts a plan, and the old 12-agent Wandr Growth org is archived, not deleted.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tethr clean-slate org (@tethr coordinator)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;
  let oldCompanyId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-core-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.TETHR_BUNDLE_PATH;
    delete process.env.ANTHROPIC_API_KEY; // force the mock provider
    delete process.env.TETHR_SLACK_COMPANY_ID;
    process.env.TETHR_LIVE_FETCH = "false"; // hermetic: fixtures, never the network

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-core-");
    db = createDb(tempDb.connectionString);

    // Seed the OLD org first so the gut step has something to archive.
    const old = await seedWandrGrowth(db, { demo: false });
    oldCompanyId = old.companyId;

    const result = await seedTethrCore(db);
    companyId = result.companyId;
    expect(result.created).toBe(true);
    expect(result.archivedOldCompany).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("archives (never deletes) the old Wandr Growth org", async () => {
    const [old] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, oldCompanyId))
      .limit(1);
    expect(old?.status).toBe("archived");
    // Its agent profiles still exist — nothing was deleted.
    const oldProfiles = await db
      .select()
      .from(tethrAgentProfiles)
      .where(eq(tethrAgentProfiles.companyId, oldCompanyId));
    expect(oldProfiles.length).toBeGreaterThan(0);
  });

  it("silences the archived org's heartbeats (routines paused, triggers off)", async () => {
    // Archiving only ever flipped the company status; its scheduled heartbeats
    // (@atlas/@compass/Helm digest) kept firing and, once Slack went live,
    // posting to #scout. Seeding the clean slate must pause them all.
    const oldRoutines = await db
      .select()
      .from(routines)
      .where(eq(routines.companyId, oldCompanyId));
    expect(oldRoutines.length).toBeGreaterThan(0);
    expect(oldRoutines.every((r) => r.status === "paused")).toBe(true);

    const oldTriggers = await db
      .select()
      .from(routineTriggers)
      .where(eq(routineTriggers.companyId, oldCompanyId));
    expect(oldTriggers.every((t) => t.enabled === false)).toBe(true);
  });

  it("seeds exactly one agent — @tethr — with chat + plan subagents", async () => {
    const org = orgService(db);
    const profiles = await org.listProfiles(companyId);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].profile.tag).toBe("@tethr");
    expect(profiles[0].profile.codename).toBe("Tethr");

    const subs = await org.listSubagents(companyId);
    expect(subs.map((s) => s.tag).sort()).toEqual(["@tethr.chat", "@tethr.plan"]);

    const divisions = await org.listDivisions(companyId);
    expect(divisions).toHaveLength(1);
    expect(divisions[0].key).toBe("operations");
  });

  it("is idempotent — reseeding neither duplicates nor re-creates", async () => {
    const again = await seedTethrCore(db);
    expect(again.created).toBe(false);
    expect(again.companyId).toBe(companyId);
  });

  it("resolves @tethr as the router (and @helm still works for the legacy org)", async () => {
    const org = orgService(db);
    const router = await org.getRouterProfile(companyId);
    expect(router?.profile.tag).toBe("@tethr");
    const legacyRouter = await org.getRouterProfile(oldCompanyId);
    expect(legacyRouter?.profile.tag).toBe("@helm");
  });

  it("resolves inbound Slack events to the @tethr company", async () => {
    expect(await resolveTethrCompanyId(db)).toBe(companyId);
  });

  it("routes a question end-to-end through @tethr with the mock LLM", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "What is our current status? Give me a quick summary.",
    });
    expect(result.status).not.toBe("failed");
    expect(result.hops[0]?.actorTag).toBe("@tethr");
    expect(result.outputs.length).toBeGreaterThan(0);
    expect(result.resultText.length).toBeGreaterThan(0);
  });

  it("inlines the chat answer body as resultText (not a 'published' stub)", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "How are we doing on travel content this week?",
    });
    // The human reads the actual answer, not "Title — published to the Drive."
    expect(result.status).toBe("done");
    expect(result.resultText).not.toContain("published to the Drive");
    expect(result.resultText).not.toContain("staged in the Queue");
    expect(result.resultText.length).toBeGreaterThan(40);
    // It routed through the chat subagent and produced an "answer" output.
    expect(result.hops.some((h) => h.actorTag === "@tethr.chat")).toBe(true);
  });

  it("logs chat answers to /tethr/chat-log and never to the published-content dedup log", async () => {
    const routing = routingService(db);
    await routing.routeRequest({
      companyId,
      requestText: "Quick sanity check — are we set up correctly?",
    });
    // A chat-log file exists…
    const chatLog = await db
      .select()
      .from(tethrDriveNodes)
      .where(
        and(
          eq(tethrDriveNodes.companyId, companyId),
          eq(tethrDriveNodes.kind, "file"),
        ),
      );
    expect(chatLog.some((n) => (n.path ?? "").startsWith("/tethr/chat-log/"))).toBe(true);
    // …but no published-content memory was recorded for a chat answer.
    const memories = await db
      .select()
      .from(tethrMemories)
      .where(
        and(
          eq(tethrMemories.companyId, companyId),
          eq(tethrMemories.kind, "published-content"),
        ),
      );
    expect(memories.length).toBe(0);
  });

  it("survives a request the mock would plan across agents that don't exist", async () => {
    // The mock provider plans "launch a campaign" across @beacon/@ledger/@tailwind —
    // none of which exist here. The plan-step guard must fall back to classify.
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "Launch a campaign for Peru travel consults",
    });
    expect(result.status).not.toBe("failed");
    expect(result.hops.some((h) => h.actorTag === "@tethr")).toBe(true);
  });

  it("continues a Slack conversation: same source key resumes the thread, with context", async () => {
    const routing = routingService(db);
    const sourceKey = "slack:im:D-CONT-TEST";
    // First message in a DM.
    const first = await routing.routeRequest({
      companyId,
      requestText: "We're focused on Peru travel content right now.",
      sourceKey,
    });
    // A reply in the same DM resolves back to the first run's thread…
    const resumed = await resolveContinuationThreadId(db, companyId, sourceKey, { isDM: true });
    expect(resumed).toBe(first.threadId);
    // …and routing with that threadId stitches the earlier turn into context.
    const second = await routing.routeRequest({
      companyId,
      requestText: "What did I just say we're focused on?",
      threadId: resumed,
      sourceKey,
    });
    expect(second.threadId).toBe(first.threadId);
    expect(second.status).not.toBe("failed");
  });

  it("expires a stale DM thread but never a channel thread", async () => {
    const routing = routingService(db);
    const dmKey = "slack:im:D-STALE";
    const run = await routing.routeRequest({
      companyId,
      requestText: "First DM message.",
      sourceKey: dmKey,
    });
    // Fresh: within the window it resumes.
    expect(await resolveContinuationThreadId(db, companyId, dmKey, { isDM: true })).toBe(run.threadId);
    // Stale: a lookup 5 hours later starts fresh.
    const fiveHoursLater = Date.now() + 5 * 60 * 60 * 1000;
    expect(
      await resolveContinuationThreadId(db, companyId, dmKey, { isDM: true, nowMs: fiveHoursLater }),
    ).toBeNull();
    // A channel thread never expires (a thread is a conversation by construction).
    const chanKey = "slack:C-CHAN:1700.5";
    const chanRun = await routing.routeRequest({
      companyId,
      requestText: "Channel thread root.",
      sourceKey: chanKey,
    });
    expect(
      await resolveContinuationThreadId(db, companyId, chanKey, { isDM: false, nowMs: fiveHoursLater }),
    ).toBe(chanRun.threadId);
  });

  it("keeps Tethr's toolset read-safe: chat can't write, neither can publish", () => {
    const chatTools = toolsetForSubagent({ tag: "@tethr.chat" }).map((t) => t.name);
    expect(chatTools).toContain("google_ads_report");
    expect(chatTools).toContain("escalate"); // can raise a hand to its overseer
    expect(chatTools).not.toContain("drive_write");
    expect(chatTools).not.toContain("notify");
    const planTools = toolsetForSubagent({ tag: "@tethr.plan" }).map((t) => t.name);
    expect(planTools).toContain("drive_write");
    expect(planTools).toContain("escalate");
    expect(planTools).not.toContain("notify");
  });

  it("resolves an agent's overseer, falling back to the org default", async () => {
    const saved = process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID;
    const savedName = process.env.TETHR_DEFAULT_OVERSEER_NAME;
    try {
      // With a default set → that's the overseer, @-mentioned.
      process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID = "U_MARK";
      process.env.TETHR_DEFAULT_OVERSEER_NAME = "Mark";
      const o = await resolveOverseer(db, companyId, "@tethr");
      expect(o.slackId).toBe("U_MARK");
      expect(overseerMention(o)).toBe("<@U_MARK>");

      // With nothing configured → no Slack id, and the mention degrades to the
      // role's roster label (@tethr's role is "growth") — never crashes.
      delete process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID;
      delete process.env.TETHR_DEFAULT_OVERSEER_NAME;
      const noDefault = await resolveOverseer(db, companyId, "@tethr");
      expect(noDefault.slackId).toBeUndefined();
      expect(overseerMention(noDefault)).toBe("Growth & Ops");
    } finally {
      if (saved === undefined) delete process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID;
      else process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID = saved;
      if (savedName === undefined) delete process.env.TETHR_DEFAULT_OVERSEER_NAME;
      else process.env.TETHR_DEFAULT_OVERSEER_NAME = savedName;
    }
  });

  it("a chat answer does not record a recallable history memory", async () => {
    const org = orgService(db);
    const router = await org.getRouterProfile(companyId);
    const agentId = router!.agent.id;
    const mem = memoryService(db);
    const historyCount = async () =>
      (await mem.list(companyId, { agentId })).filter((m) => m.kind === "history").length;
    const before = await historyCount();
    await routingService(db).routeRequest({
      companyId,
      requestText: "Quick question — what are SEO basics?",
    });
    // Chat is ephemeral: it must not add to the recency-recalled history.
    expect(await historyCount()).toBe(before);
  });

  it("reset wipes the chat: history cleared, continuity starts fresh", async () => {
    const routing = routingService(db);
    const org = orgService(db);
    const mem = memoryService(db);
    const agentId = (await org.getRouterProfile(companyId))!.agent.id;
    const sourceKey = "slack:im:D-WIPE";

    // Seed a history memory + a fact, and start a conversation.
    await mem.record({ companyId, agentId, kind: "history", content: "chatted about Peru budgets" });
    await mem.record({ companyId, agentId, kind: "fact", content: "Standing fact: CAC target is $40" });
    const first = await routing.routeRequest({
      companyId,
      requestText: "We're focused on Peru right now.",
      sourceKey,
    });
    expect(await resolveContinuationThreadId(db, companyId, sourceKey, { isDM: true })).toBe(first.threadId);

    // Wipe.
    await handleConversationReset(db, companyId, sourceKey);

    // History is gone; the standing fact survives.
    const remaining = await mem.list(companyId, { agentId });
    expect(remaining.some((m) => m.kind === "history")).toBe(false);
    expect(remaining.some((m) => m.content.includes("CAC target is $40"))).toBe(true);

    // Continuity no longer resumes the pre-reset thread (it caps at the marker).
    const after = await resolveContinuationThreadId(db, companyId, sourceKey, { isDM: true });
    expect(after).not.toBe(first.threadId);
    expect(after).not.toBeNull();
  });

  it("requires a confirmation before wiping — 'yes' clears, anything else cancels", async () => {
    const org = orgService(db);
    const mem = memoryService(db);
    const agentId = (await org.getRouterProfile(companyId))!.agent.id;
    const hasHistory = async () =>
      (await mem.list(companyId, { agentId })).some((m) => m.kind === "history");

    // Cancel path: reset command prompts, but a non-yes reply leaves memory intact.
    await mem.record({ companyId, agentId, kind: "history", content: "keep me unless confirmed" });
    const prompt = await routeInboundKickoff(db, {
      requestText: "clean up",
      channel: "D-CONFIRM-A",
      isDM: true,
    });
    expect(prompt).toBeNull(); // asked to confirm, nothing routed
    expect(await hasHistory()).toBe(true); // NOT wiped yet
    // A different message cancels the pending wipe.
    await routeInboundKickoff(db, { requestText: "actually, what's our CAC?", channel: "D-CONFIRM-A", isDM: true });
    expect(await hasHistory()).toBe(true); // still not wiped

    // Confirm path: reset command, then "yes" → wiped.
    await routeInboundKickoff(db, { requestText: "wipe memory", channel: "D-CONFIRM-B", isDM: true });
    expect(await hasHistory()).toBe(true); // prompt only
    await routeInboundKickoff(db, { requestText: "yes", channel: "D-CONFIRM-B", isDM: true });
    expect(await hasHistory()).toBe(false); // confirmed → cleared
  });

  it("handles built-in commands deterministically (no LLM route)", async () => {
    const routing = routingService(db);
    const countRuns = async () => (await routing.listRouteRuns(companyId, 500)).length;

    const before = await countRuns();
    // /help, /agents, and an unknown /command are all answered directly.
    for (const cmd of ["/help", "help", "/agents", "/frobnicate"]) {
      const r = await routeInboundKickoff(db, { requestText: cmd, channel: "D-CMD", isDM: true });
      expect(r, cmd).toBeNull();
    }
    // None of them created a route run (they never touched the router).
    expect(await countRuns()).toBe(before);

    // A real question still routes (returns run ids).
    const routed = await routeInboundKickoff(db, {
      requestText: "who is our biggest competitor?",
      channel: "D-CMD2",
      isDM: true,
    });
    expect(routed).not.toBeNull();
  });

  it("renders the /agents roster with each agent's overseer", async () => {
    const saved = process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID;
    process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID = "U_MARK";
    try {
      const roster = await renderAgentsMessage(db, companyId);
      expect(roster).toContain("@tethr");
      expect(roster).toContain("<@U_MARK>"); // overseer mention resolved
    } finally {
      if (saved === undefined) delete process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID;
      else process.env.TETHR_DEFAULT_OVERSEER_SLACK_ID = saved;
    }
  });

  it("bills nothing on the mock provider (cost events are live-only)", async () => {
    const routing = routingService(db);
    await routing.routeRequest({ companyId, requestText: "A quick free question." });
    const events = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId));
    // Mock is deterministic and free — no spend must ever accrue in dev/test.
    expect(events.length).toBe(0);
  });

  it("threads a shared image through routing to the model", async () => {
    const routing = routingService(db);
    // 1x1 transparent PNG.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const result = await routing.routeRequest({
      companyId,
      requestText: "What's in this screenshot?",
      attachments: [{ mimeType: "image/png", dataBase64: png, name: "shot.png" }],
    });
    expect(result.status).not.toBe("failed");
    // The mock can't see pixels, but it must confirm the image reached the model
    // (proving the Slack → routing → worker → LLM pipeline carries attachments).
    expect(result.resultText.toLowerCase()).toContain("image");
    expect(result.resultText).toContain("shot.png");
  });

  it("surfaces an escalation up through routing when the agent raises a hand", async () => {
    const routing = routingService(db);
    // The mock escalates when the request explicitly needs a human decision.
    const result = await routing.routeRequest({
      companyId,
      requestText: "I need your call on this — should we escalate the Peru budget to Mark?",
    });
    expect(result.status).not.toBe("failed");
    expect(result.escalations.length).toBe(1);
    expect(result.escalations[0].agentTag).toBe("@tethr");
    expect(result.escalations[0].note.length).toBeGreaterThan(0);
  });
});

// Regression: with @ceo seeded, a plain conversational/meta question used to be
// misrouted to @ceo, whose only subagent drafts a brief that auto-published to
// the Drive. It must stay on @tethr.chat (answered inline, no artifact). Real
// business-strategy asks still go to @ceo. Isolated org so @ceo doesn't perturb
// the shared-company tests above.
describeEmbeddedPostgres("tethr routing: conversational asks stay on @tethr.chat (with @ceo)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-route-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.TETHR_BUNDLE_PATH;
    delete process.env.ANTHROPIC_API_KEY; // force the mock provider
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-route-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    const { seedCeoAgent } = await import("../tethr/seed/ceo.ts");
    await seedCeoAgent(db, companyId); // adds @ceo + its routing row
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("answers a meta question inline via @tethr.chat — never @ceo → brief", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText: "In one short sentence, what do you do?",
    });
    expect(result.status).toBe("done");
    expect(result.hops.some((h) => h.actorTag === "@tethr.chat")).toBe(true);
    expect(result.hops.some((h) => h.actorTag === "@ceo")).toBe(false);
    expect(result.resultText).not.toContain("published to the Drive");
  });

  it("still routes a real business-strategy request to @ceo", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText: "What should the business focus on next quarter? Set our priorities.",
    });
    expect(result.hops.some((h) => h.actorTag === "@ceo")).toBe(true);
  });

  it("routes an explicit agent-creation request to @ceo (who can propose one)", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText: "create an agent for market research",
    });
    expect(result.hops.some((h) => h.actorTag === "@ceo")).toBe(true);
  });

  const parentOf = async (tag: string) => {
    const [prof] = await db
      .select({ agentId: tethrAgentProfiles.agentId })
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    const [ag] = await db.select().from(agents).where(eq(agents.id, prof.agentId)).limit(1);
    return { agentId: prof.agentId, reportsTo: ag.reportsTo };
  };

  it("seeds a system agent (@tinkr) under @tethr, not @ceo", async () => {
    const { seedTinkrAgent } = await import("../tethr/seed/tinkr.ts");
    await seedTinkrAgent(db, companyId);
    const tethr = await parentOf("@tethr");
    const ceo = await parentOf("@ceo");
    const tinkr = await parentOf("@tinkr");
    expect(tinkr.reportsTo).toBe(tethr.agentId); // beside the org, under the conductor
    expect(tinkr.reportsTo).not.toBe(ceo.agentId);
  });

  it("healSystemAgentParents re-parents a @ceo-parented system agent onto @tethr", async () => {
    const tethr = await parentOf("@tethr");
    const ceo = await parentOf("@ceo");
    const tinkr = await parentOf("@tinkr");
    // Simulate the old state: @tinkr reporting up to @ceo.
    await db.update(agents).set({ reportsTo: ceo.agentId }).where(eq(agents.id, tinkr.agentId));
    const { healSystemAgentParents } = await import("../tethr/seed/tethr-core.ts");
    await healSystemAgentParents(db);
    const healed = await parentOf("@tinkr");
    expect(healed.reportsTo).toBe(tethr.agentId);
  });

  it("healTethrRoutingCopy repairs a stale already-seeded routing table", async () => {
    // Simulate the pre-fix live state: @ceo FIRST with broad triggers, @tethr stale.
    const [profile] = await db
      .select({ id: tethrAgentProfiles.id })
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")))
      .limit(1);
    await db
      .update(tethrAgentProfiles)
      .set({
        routingTable: [
          { when: ["strategy", "direction", "what should we focus on"], to: "@ceo", description: "old" },
          { when: ["everything"], to: "@tethr", description: "Everything — no specialist agents exist yet." },
        ],
      })
      .where(eq(tethrAgentProfiles.id, profile.id));

    const { healTethrRoutingCopy } = await import("../tethr/seed/tethr-core.ts");
    await healTethrRoutingCopy(db);

    const [healed] = await db
      .select({ routingTable: tethrAgentProfiles.routingTable })
      .from(tethrAgentProfiles)
      .where(eq(tethrAgentProfiles.id, profile.id));
    const rows = healed.routingTable as Array<{ to: string; when: string[] }>;
    expect(rows[0]?.to).toBe("@tethr"); // @tethr is now the default (first)
    expect(rows[0]?.when).toContain("what do you do");

    // And a meta question routes to chat again on the healed table.
    const result = await routingService(db).routeRequest({ companyId, requestText: "who are you?" });
    expect(result.hops.some((h) => h.actorTag === "@tethr.chat")).toBe(true);
  });
});
