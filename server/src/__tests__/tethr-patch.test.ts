import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  companies,
  createDb,
  routines,
  tethrAgentProfiles,
  tethrRouteRuns,
  tethrSubagents,
} from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedPatchAgent } from "../tethr/seed/patch.ts";
import { readFailuresTool } from "../tethr/tools/internal.ts";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import type { TethrToolContext } from "../tethr/tools/types.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Patch, the debug agent: reads the failure log (DB only, read-only) and writes
// a Claude-Code-ready fix. Reached only through @tethr routing — no Slack bot.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tethr Patch (debug agent)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;
  let ceoAgentId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-patch-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-patch-");
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

  const profileByTag = async (tag: string) => {
    const [p] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    return p ?? null;
  };

  it("seeds Patch: reports to the CEO, no heartbeat, routed from @tethr — idempotent", async () => {
    const first = await seedPatchAgent(db, companyId);
    expect(first.created).toBe(true);
    const second = await seedPatchAgent(db, companyId);
    expect(second.created).toBe(false); // idempotent
    expect(second.agentId).toBe(first.agentId);

    const profile = await profileByTag("@patch");
    expect(profile).toBeTruthy();

    const [agent] = await db.select().from(agents).where(eq(agents.id, first.agentId)).limit(1);
    expect(agent.reportsTo).toBe(ceoAgentId);
    expect(agent.budgetMonthlyCents).toBe(1000);

    // No heartbeat — Patch works on request only.
    const routineRows = await db
      .select()
      .from(routines)
      .where(and(eq(routines.companyId, companyId), eq(routines.assigneeAgentId, first.agentId)));
    expect(routineRows).toHaveLength(0);

    // Hard-stop budget.
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeId, first.agentId)))
      .limit(1);
    expect(policy.hardStopEnabled).toBe(true);

    // @tethr can route to it.
    const tethr = await profileByTag("@tethr");
    expect((tethr!.routingTable as Array<{ to?: string }>).some((r) => r.to === "@patch")).toBe(true);
  });

  it("grants read_failures ONLY to @patch.diagnose (no other subagent can read the failure log)", async () => {
    const subs = await db.select().from(tethrSubagents).where(eq(tethrSubagents.companyId, companyId));
    for (const sub of subs) {
      const names = toolsetForSubagent(sub).map((t) => t.name);
      if (sub.tag === "@patch.diagnose") {
        expect(names).toContain("read_failures");
        expect(names).toContain("drive_write");
      } else {
        expect(names).not.toContain("read_failures");
      }
    }
  });

  it("read_failures reads this company's failed/errored runs with the error + trace", async () => {
    const [patchAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.name, "Patch")))
      .limit(1);

    await db.insert(tethrRouteRuns).values({
      companyId,
      requestText: "please review this clients intake request with the photo",
      status: "failed",
      llmProvider: "claude",
      error: 'Claude API 400: {"message":"Could not process image"}',
      hops: [
        { at: "t", layer: "agent", actorTag: "@tethr", decision: "route", reason: "vision request" },
      ] as never,
    });
    await db.insert(tethrRouteRuns).values({
      companyId,
      requestText: "a run that succeeded",
      status: "done",
      llmProvider: "claude",
      error: null,
    });

    const ctx: TethrToolContext = {
      db,
      companyId,
      agentId: patchAgent.id,
      agentTag: "@patch",
      subagentTag: "@patch.diagnose",
    };
    const all = await readFailuresTool.execute(ctx, {});
    expect(all.output).toContain("Could not process image");
    expect(all.output).toContain("please review this clients intake");
    expect(all.output).not.toContain("a run that succeeded"); // successes excluded

    // Keyword filter narrows it.
    const filtered = await readFailuresTool.execute(ctx, { query: "image" });
    expect(filtered.output).toContain("Could not process image");
    const miss = await readFailuresTool.execute(ctx, { query: "nonexistent-term-xyz" });
    expect(miss.output).toMatch(/No recent failures match/);
  });

  it("read_failures is company-scoped — it never reads another company's failures", async () => {
    const [other] = await db
      .insert(companies)
      .values({ name: "Some Other Tenant", issuePrefix: "OTH" })
      .returning();
    await db.insert(tethrRouteRuns).values({
      companyId: other.id,
      requestText: "OTHER COMPANY secret failure",
      status: "failed",
      error: "some other error",
    });
    const [patchAgent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.name, "Patch")))
      .limit(1);
    const ctx: TethrToolContext = {
      db,
      companyId,
      agentId: patchAgent.id,
      agentTag: "@patch",
      subagentTag: "@patch.diagnose",
    };
    const res = await readFailuresTool.execute(ctx, {});
    expect(res.output).not.toContain("OTHER COMPANY");
  });
});
