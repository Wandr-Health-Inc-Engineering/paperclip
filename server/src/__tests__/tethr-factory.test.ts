import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  createDb,
  routines,
  tethrAgentProfiles,
  tethrOutputs,
  tethrSubagents,
} from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { proposeAgent } from "../tethr/proposals.ts";
import { gatingService } from "../tethr/gating.ts";
import { validateAgentSpec, MAX_PROPOSAL_BUDGET_CENTS } from "../tethr/factory.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The agent factory end to end: the CEO proposes an agent → gated output →
// a human approves → the agent is BORN (paused, budget-capped, reporting to CEO).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

const GOOD_SPEC = {
  codename: "Radar",
  role: "Market Research",
  mission: "Watch the market.",
  rationale: "We have no market read.",
  tools: ["web_fetch", "reddit_scan"],
  budgetMonthlyCents: 5000,
  heartbeatCron: "0 9 * * 1",
  subagents: [
    { key: "scan", name: "Scanner", job: "Scan competitors.", routeWhen: ["competitor"], steps: ["fetch"], output: "brief", guardrails: ["read-only"], sensitivity: "internal" },
  ],
};

describe("agent spec validation", () => {
  const existingTags = new Set(["@tethr", "@ceo"]);

  it("accepts a well-formed, buildable spec", () => {
    const r = validateAgentSpec(GOOD_SPEC, { existingTags });
    expect(r.ok).toBe(true);
    expect(r.spec?.codename).toBe("Radar");
  });

  it("rejects tools outside the read-only proposable menu", () => {
    const r = validateAgentSpec({ ...GOOD_SPEC, tools: ["drive_write", "notify"] }, { existingTags });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/not proposable/);
  });

  it("rejects a budget over the hard ceiling", () => {
    const r = validateAgentSpec(
      { ...GOOD_SPEC, budgetMonthlyCents: MAX_PROPOSAL_BUDGET_CENTS + 1 },
      { existingTags },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/budget/);
  });

  it("rejects a duplicate codename", () => {
    const r = validateAgentSpec(GOOD_SPEC, { existingTags: new Set(["@radar"]) });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/already exists/);
  });

  it("rejects a spec with no subagents", () => {
    const r = validateAgentSpec({ ...GOOD_SPEC, subagents: [] }, { existingTags });
    expect(r.ok).toBe(false);
  });
});

describeEmbeddedPostgres("CEO proposes → human approves → agent is born", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;
  let ceoAgentId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-factory-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY; // deterministic mock proposals
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-factory-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    const ceo = await seedCeoAgent(db, companyId);
    ceoAgentId = ceo.agentId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("proposeAgent stages a gated agent_proposal carrying the spec", async () => {
    const { output, spec } = await proposeAgent(db, companyId, { brief: "market research" });
    expect(output?.kind).toBe("agent_proposal");
    expect(output?.status).toBe("gated");
    expect(output?.sensitivity).toBe("org");
    expect(output?.approvalId).toBeTruthy();
    expect(spec.role).toBe("Market Research");
    // The spec rides in meta for the approval step to build from.
    const meta = output?.meta as { spec?: { codename?: string } };
    expect(meta.spec?.codename).toBe(spec.codename);
  });

  it("approving the proposal instantiates a paused agent reporting to the CEO", async () => {
    const { output, spec } = await proposeAgent(db, companyId, { brief: "market research" });
    const tag = `@${spec.codename.toLowerCase().replace(/[^a-z0-9]/g, "")}`;

    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "approve",
      reviewer: "mark",
    });

    const [profile] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    expect(profile).toBeTruthy();

    const [agent] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, profile.agentId))
      .limit(1);
    expect(agent.reportsTo).toBe(ceoAgentId); // reports to the CEO that proposed it
    expect(agent.budgetMonthlyCents).toBe(spec.budgetMonthlyCents);

    // Subagents created.
    const subs = await db
      .select()
      .from(tethrSubagents)
      .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.agentId, agent.id)));
    expect(subs.length).toBeGreaterThanOrEqual(1);

    // Hard-stop budget policy.
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeId, agent.id)))
      .limit(1);
    expect(policy.hardStopEnabled).toBe(true);

    // Heartbeat seeded PAUSED.
    const [routine] = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.assigneeAgentId, agent.id)))
      .limit(1);
    expect(routine.status).toBe("paused");

    // @tethr can now route to it.
    const [tethr] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")))
      .limit(1);
    expect((tethr.routingTable as Array<{ to?: string }>).some((r) => r.to === tag)).toBe(true);

    // The proposal output is marked published (it did its job).
    const [decided] = await db
      .select()
      .from(tethrOutputs)
      .where(eq(tethrOutputs.id, output!.id))
      .limit(1);
    expect(decided.status).toBe("published");
  });

  it("rejecting a proposal creates no agent", async () => {
    const before = (await db.select().from(agents).where(eq(agents.companyId, companyId))).length;
    const { output } = await proposeAgent(db, companyId, { brief: "something" });
    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "reject",
      reviewer: "mark",
    });
    const after = (await db.select().from(agents).where(eq(agents.companyId, companyId))).length;
    expect(after).toBe(before);
  });
});
