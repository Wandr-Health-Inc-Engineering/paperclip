import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agents, createDb, tethrAgentProfiles, tethrOutputs } from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedTinkrAgent } from "../tethr/seed/tinkr.ts";
import { gatingService } from "../tethr/gating.ts";
import { proposeAgent } from "../tethr/proposals.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The per-agent auto-approve toggle. Its whole safety story: it can ONLY fire
// for sensitivity "org", and never for a budget change — so spend/medical/
// public/pr can never auto-apply.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("tethr auto-approve", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;
  let ceoAgentId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-autoapprove-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-autoapprove-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    const ceo = await seedCeoAgent(db, companyId);
    ceoAgentId = ceo.agentId;
    await seedTinkrAgent(db, companyId);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  const setAutoApprove = (agentId: string, on: boolean) =>
    db.update(tethrAgentProfiles).set({ autoApprove: on }).where(eq(tethrAgentProfiles.agentId, agentId));

  const latest = async (kind: string) => {
    const [o] = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, kind)))
      .orderBy(tethrOutputs.createdAt);
    return o ?? null;
  };

  it("with autoApprove ON, an agent_proposal auto-instantiates a paused agent", async () => {
    await setAutoApprove(ceoAgentId, true);
    const { output, spec } = await proposeAgent(db, companyId, { brief: "market research" });
    // The proposal auto-approved → published, and the agent exists.
    const [decided] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, output!.id)).limit(1);
    expect(decided.status).toBe("published");
    const tag = `@${spec.codename.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
    const [born] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    expect(born).toBeTruthy();
    // Auto-created agent is still paused (idle) — never auto-running.
    const [bornAgent] = await db.select().from(agents).where(eq(agents.id, born.agentId)).limit(1);
    expect(bornAgent.status).toBe("idle");
    await setAutoApprove(ceoAgentId, false);
  });

  it("with autoApprove OFF, an agent_proposal stays gated (waits for a human)", async () => {
    const { output } = await proposeAgent(db, companyId, { brief: "another research angle" });
    const [row] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, output!.id)).limit(1);
    expect(row.status).toBe("gated");
  });

  it("NEVER auto-approves a budget change, even with autoApprove ON", async () => {
    const gating = gatingService(db);
    await setAutoApprove(ceoAgentId, true);
    const output = await gating.createOutput({
      companyId,
      agentId: ceoAgentId,
      agentTag: "@ceo",
      kind: "org_change",
      title: "Org change: budget @radar → $99/mo",
      body: "raise the cap",
      sensitivity: "org",
      meta: { change: { op: "update_budget", targetTag: "@radar", budgetMonthlyCents: 9900 } },
    });
    expect(output?.status).toBe("gated"); // budget carve-out held
    await setAutoApprove(ceoAgentId, false);
  });

  it("NEVER auto-approves spend/medical, even with autoApprove ON", async () => {
    const gating = gatingService(db);
    await setAutoApprove(ceoAgentId, true);
    for (const sensitivity of ["spend", "medical", "public", "pr"] as const) {
      const output = await gating.createOutput({
        companyId,
        agentId: ceoAgentId,
        agentTag: "@ceo",
        kind: "document",
        title: `a ${sensitivity} thing`,
        body: "x",
        sensitivity,
      });
      expect(output?.status).toBe("gated");
    }
    await setAutoApprove(ceoAgentId, false);
  });
});
