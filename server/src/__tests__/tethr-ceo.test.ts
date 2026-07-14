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
  tethrSubagents,
} from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { proposeAgentTool } from "../tethr/tools/internal.ts";
import { gatingService } from "../tethr/gating.ts";
import { tethrOutputs } from "@paperclipai/db";
import type { TethrToolContext } from "../tethr/tools/types.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The AI CEO: head of the agent org, a second reportsTo:null root beside @tethr
// (the conductor). Seeded additively + idempotently onto the clean-slate org.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tethr AI CEO", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-ceo-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-ceo-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("seeds a CEO agent at the top of the agent org (reportsTo null)", async () => {
    const result = await seedCeoAgent(db, companyId);
    expect(result.created).toBe(true);

    const [ceo] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, result.agentId)))
      .limit(1);
    expect(ceo.name).toBe("CEO");
    expect(ceo.role).toBe("ceo");
    expect(ceo.reportsTo).toBeNull();

    const [profile] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(
        and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")),
      )
      .limit(1);
    expect(profile.codename).toBe("CEO");
  });

  it("gives the CEO a planning subagent and a hard-stopped budget", async () => {
    const [sub] = await db
      .select()
      .from(tethrSubagents)
      .where(
        and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, "@ceo.plan")),
      )
      .limit(1);
    expect(sub.name).toBe("Planning");
    expect(sub.sensitivity).toBe("internal");

    const [ceoProfile] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(
        and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")),
      )
      .limit(1);
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(
        and(
          eq(budgetPolicies.companyId, companyId),
          eq(budgetPolicies.scopeId, ceoProfile.agentId),
        ),
      )
      .limit(1);
    expect(policy.hardStopEnabled).toBe(true);
  });

  it("seeds the CEO heartbeat PAUSED (Mark's gate)", async () => {
    const [ceoProfile] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(
        and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")),
      )
      .limit(1);
    const [routine] = await db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.companyId, companyId),
          eq(routines.assigneeAgentId, ceoProfile.agentId),
        ),
      )
      .limit(1);
    expect(routine.status).toBe("paused");
  });

  it("points @tethr at the CEO and reframes it as the conductor", async () => {
    const [tethr] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(
        and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")),
      )
      .limit(1);
    const rows = tethr.routingTable as Array<{ to?: string }>;
    expect(rows.some((r) => r.to === "@ceo")).toBe(true);
    expect(tethr.mission.toLowerCase()).toContain("conductor");
  });

  it("is idempotent — a second seed neither duplicates nor re-creates", async () => {
    const again = await seedCeoAgent(db, companyId);
    expect(again.created).toBe(false);

    const ceoProfiles = await db
      .select()
      .from(tethrAgentProfiles)
      .where(
        and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")),
      );
    expect(ceoProfiles).toHaveLength(1);

    // @tethr didn't accumulate duplicate @ceo routing rows.
    const [tethr] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(
        and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@tethr")),
      )
      .limit(1);
    const ceoRows = (tethr.routingTable as Array<{ to?: string }>).filter(
      (r) => r.to === "@ceo",
    );
    expect(ceoRows).toHaveLength(1);
  });

  it("the CEO can propose an agent — propose_agent stages a gated agent_proposal", async () => {
    const [ceo] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
      .limit(1);
    const ctx: TethrToolContext = {
      db,
      companyId,
      agentId: ceo.agentId,
      agentTag: "@ceo",
      subagentTag: "@ceo.plan",
    };
    const before = (
      await db
        .select()
        .from(tethrOutputs)
        .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "agent_proposal")))
    ).length;

    const res = await proposeAgentTool.execute(ctx, {
      brief: "an engineering agent that owns applying the bug fixes Patch diagnoses",
    });
    expect(res.summary).toMatch(/proposed agent/);

    const proposals = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "agent_proposal")))
      .orderBy(tethrOutputs.createdAt);
    expect(proposals.length).toBe(before + 1);
    const latest = proposals[proposals.length - 1];
    expect(latest.status).toBe("gated"); // manual by default — waits for approval
    expect((latest.meta as { spec?: unknown }).spec).toBeTruthy();
  });

  it("with the CEO on auto, a proposal auto-builds a PAUSED agent (overseer inferred by domain)", async () => {
    await db
      .update(tethrAgentProfiles)
      .set({ autoApprove: true })
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")));

    const gating = gatingService(db);
    const [ceo] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")))
      .limit(1);
    // Stage a tech-flavored proposal directly and let auto-approve build it.
    const spec = {
      codename: "Forge",
      role: "Engineering",
      mission: "Own applying the bug fixes and technical debugging tasks.",
      rationale: "Diagnosed bugs have no owner to fix them.",
      tools: [],
      budgetMonthlyCents: 2000,
      heartbeatCron: null,
      subagents: [
        { key: "fix", name: "Fixer", job: "Apply fixes.", routeWhen: ["fix"], steps: ["do"], output: "a fix", guardrails: ["read-only recs"], sensitivity: "internal" as const },
      ],
    };
    const output = await gating.createOutput({
      companyId,
      agentId: ceo.agentId,
      agentTag: "@ceo",
      kind: "agent_proposal",
      title: "New agent: Forge — Engineering",
      body: "engineering agent",
      sensitivity: "org",
      meta: { spec, autonomous: true },
    });
    expect(output?.status).toBe("published"); // auto-approved

    const [built] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@forge")))
      .limit(1);
    expect(built).toBeTruthy();
    expect(built.overseerRole).toBe("tech"); // engineering → Frank
    const [forgeAgent] = await db.select().from(agents).where(eq(agents.id, built.agentId)).limit(1);
    expect(forgeAgent.status).toBe("idle"); // paused, never auto-running

    await db
      .update(tethrAgentProfiles)
      .set({ autoApprove: false })
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, "@ceo")));
  });
});
