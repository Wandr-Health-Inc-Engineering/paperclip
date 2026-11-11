import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, createDb, tethrAgentProfiles, tethrOutputs, tethrSubagents } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedRankAgent } from "../tethr/seed/rank.ts";
import { seedTankAgent, TANK_AGENT } from "../tethr/seed/tank.ts";
import { routingService } from "../tethr/routing.ts";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Tank — the GEO / LLM-visibility analyst. An ORG ROLE under @ceo (beside @rank).
// Read-only: web_fetch + keyword_ideas, granted ONLY to @tank.geo; its audit
// files to 02 Documents (the "geo" key → document kind). GEO requests route to
// @tank; SEO/keyword requests still route to @rank (disambiguation).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tethr Tank (GEO / LLM-visibility analyst)", () => {
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
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-tank-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY; // deterministic mock
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-tank-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    await seedCeoAgent(db, companyId);
    await seedRankAgent(db, companyId); // both present, to test disambiguation
    await seedTankAgent(db, companyId);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("seeds Tank idempotently — an org role reporting to @ceo, $15/mo cap, no heartbeat", async () => {
    const again = await seedTankAgent(db, companyId);
    expect(again.created).toBe(false); // idempotent

    const profile = await profileByTag("@tank");
    expect(profile?.codename).toBe(TANK_AGENT.codename);
    const [agent] = await db.select().from(agents).where(eq(agents.id, profile!.agentId)).limit(1);
    const ceo = await profileByTag("@ceo");
    const tethr = await profileByTag("@tethr");
    expect(agent.reportsTo).toBe(ceo?.agentId);
    expect(agent.reportsTo).not.toBe(tethr?.agentId);
    expect(agent.budgetMonthlyCents).toBe(1500);
  });

  it("grants @tank.geo web_fetch + keyword_ideas, read-only (never publishes)", async () => {
    const sub = await subagentByTag("@tank.geo");
    const tools = toolsetForSubagent(sub!).map((t) => t.name);
    expect(tools).toContain("web_fetch");
    expect(tools).toContain("keyword_ideas");
    expect(tools).not.toContain("drive_write"); // read-only research
    expect(tools).not.toContain("notify");
    // @ceo.plan (which can only propose agents) doesn't leak these research tools.
    const ceoPlan = await subagentByTag("@ceo.plan");
    const ceoTools = toolsetForSubagent(ceoPlan!).map((t) => t.name);
    expect(ceoTools).not.toContain("web_fetch");
    expect(ceoTools).not.toContain("keyword_ideas");
  });

  it("routes a GEO / AI-visibility request to @tank → @tank.geo, filing a document", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText: "How do we get cited by ChatGPT and improve our AI visibility?",
    });
    expect(result.status).not.toBe("failed");
    expect(result.hops.some((h) => h.actorTag === "@tank")).toBe(true);
    expect(result.hops.some((h) => h.actorTag === "@tank.geo")).toBe(true);
    const oid = result.outputs[0]?.outputId;
    expect(oid).toBeTruthy();
    const [out] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, oid!)).limit(1);
    expect(out.kind).toBe("document"); // "geo" key → document → 02 Documents
  });

  it("keeps SEO/keyword requests on @rank, not @tank (disambiguation)", async () => {
    const result = await routingService(db).routeRequest({
      companyId,
      requestText: "What keywords should we rank for on malaria prophylaxis?",
    });
    expect(result.hops.some((h) => h.actorTag === "@rank")).toBe(true);
    expect(result.hops.some((h) => h.actorTag === "@tank")).toBe(false);
  });
});
