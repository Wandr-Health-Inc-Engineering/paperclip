import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, createDb, tethrAgentProfiles, tethrOutputs, tethrSubagents } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedRankAgent, RANK_AGENT } from "../tethr/seed/rank.ts";
import { routingService } from "../tethr/routing.ts";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Rank — the SEO / search-demand analyst. An ORG ROLE under @ceo (beside
// @radar/@remedy). Read-only research: keyword_ideas + web_fetch, granted ONLY
// to @rank.keywords; its brief files to 02 Documents (the "keywords" key →
// document kind). Routed through @tethr — no heartbeat yet.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tethr Rank (SEO / search-demand analyst)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  const profileByTag = async (tag: string) => {
    const [p] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    return p ?? null;
  };
  const subagentByTag = async (tag: string) => {
    const [s] = await db
      .select()
      .from(tethrSubagents)
      .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, tag)))
      .limit(1);
    return s ?? null;
  };

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-rank-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY; // deterministic mock
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-rank-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    await seedCeoAgent(db, companyId);
    await seedRankAgent(db, companyId);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("seeds Rank idempotently — an org role reporting to @ceo, $15/mo cap, no heartbeat", async () => {
    const again = await seedRankAgent(db, companyId);
    expect(again.created).toBe(false); // idempotent

    const profile = await profileByTag("@rank");
    expect(profile?.codename).toBe(RANK_AGENT.codename);
    const [agent] = await db.select().from(agents).where(eq(agents.id, profile!.agentId)).limit(1);
    // An ORG ROLE — reports up to the CEO (not the system hub @tethr).
    const ceo = await profileByTag("@ceo");
    const tethr = await profileByTag("@tethr");
    expect(agent.reportsTo).toBe(ceo?.agentId);
    expect(agent.reportsTo).not.toBe(tethr?.agentId);
    expect(agent.budgetMonthlyCents).toBe(1500);
  });

  it("grants keyword_ideas + web_fetch ONLY to @rank.keywords", async () => {
    const sub = await subagentByTag("@rank.keywords");
    const tools = toolsetForSubagent(sub!).map((t) => t.name);
    expect(tools).toContain("keyword_ideas");
    expect(tools).toContain("web_fetch");
    expect(tools).not.toContain("drive_write"); // read-only research, never publishes tools
    expect(tools).not.toContain("notify");
    // No other subagent leaks the grant.
    for (const tag of ["@tethr.chat", "@ceo.plan"]) {
      const other = await subagentByTag(tag);
      expect(toolsetForSubagent(other!).map((t) => t.name)).not.toContain("keyword_ideas");
    }
  });

  it("routes a keyword/SEO request @tethr → @rank → @rank.keywords, filing a document", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText: "What keywords should we rank for on malaria prophylaxis timing?",
    });
    expect(result.status).not.toBe("failed");
    expect(result.hops.some((h) => h.actorTag === "@rank")).toBe(true);
    expect(result.hops.some((h) => h.actorTag === "@rank.keywords")).toBe(true);
    // The "keywords" key maps to the document kind → files to 02 Documents.
    // (kind lives on the DB row, not the route-result output summary.)
    const oid = result.outputs[0]?.outputId;
    expect(oid).toBeTruthy();
    const [out] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, oid!)).limit(1);
    expect(out.kind).toBe("document");
  });
});
