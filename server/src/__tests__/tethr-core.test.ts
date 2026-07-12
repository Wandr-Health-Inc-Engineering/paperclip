import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { companies, createDb, tethrAgentProfiles, tethrDriveNodes, tethrMemories } from "@paperclipai/db";
import { orgService } from "../tethr/org.ts";
import { routingService } from "../tethr/routing.ts";
import { seedWandrGrowth } from "../tethr/seed/seed.ts";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { resolveTethrCompanyId } from "../tethr/slack.ts";
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

  it("keeps Tethr's toolset read-safe: chat can't write, neither can publish", () => {
    const chatTools = toolsetForSubagent({ tag: "@tethr.chat" }).map((t) => t.name);
    expect(chatTools).toContain("google_ads_report");
    expect(chatTools).not.toContain("drive_write");
    expect(chatTools).not.toContain("notify");
    const planTools = toolsetForSubagent({ tag: "@tethr.plan" }).map((t) => t.name);
    expect(planTools).toContain("drive_write");
    expect(planTools).not.toContain("notify");
  });
});
