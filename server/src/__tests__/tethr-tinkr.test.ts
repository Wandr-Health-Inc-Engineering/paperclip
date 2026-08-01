import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  budgetPolicies,
  createDb,
  tethrAgentProfiles,
  tethrOrgChanges,
  tethrOutputs,
  tethrSubagents,
} from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedTinkrAgent } from "../tethr/seed/tinkr.ts";
import { proposeAgent } from "../tethr/proposals.ts";
import { gatingService } from "../tethr/gating.ts";
import { routingService } from "../tethr/routing.ts";
import {
  buildInverseSpec,
  computeBefore,
  changeSummary,
  renderChangeBody,
  validateOrgChange,
} from "../tethr/org-changes.ts";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Tinkr, the org mechanic: gated agent modifications with a git-style
// revertible change log. Routed only through @tethr — no Tinkr Slack bot.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tethr Tinkr (org mechanic)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;
  let ceoAgentId!: string;

  const latestOrgChangeOutput = async () => {
    const [output] = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "org_change")))
      .orderBy(desc(tethrOutputs.createdAt))
      .limit(1);
    return output ?? null;
  };

  const profileByTag = async (tag: string) => {
    const [p] = await db
      .select()
      .from(tethrAgentProfiles)
      .where(and(eq(tethrAgentProfiles.companyId, companyId), eq(tethrAgentProfiles.tag, tag)))
      .limit(1);
    return p ?? null;
  };

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-tinkr-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY; // deterministic mock
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-tinkr-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    const ceo = await seedCeoAgent(db, companyId);
    ceoAgentId = ceo.agentId;
    await seedTinkrAgent(db, companyId);

    // A target to tinker with: build Radar through the factory.
    const { output } = await proposeAgent(db, companyId, { brief: "market research" });
    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "approve",
      reviewer: "mark",
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("seeds Tinkr idempotently — reports to @tethr (system agent, beside the org), no heartbeat", async () => {
    const again = await seedTinkrAgent(db, companyId);
    expect(again.created).toBe(false);

    const profile = await profileByTag("@tinkr");
    expect(profile).toBeTruthy();
    const [agent] = await db.select().from(agents).where(eq(agents.id, profile!.agentId)).limit(1);
    // System/admin agents sit under @tethr (the conductor), NOT in the CEO's chain.
    expect(agent.reportsTo).not.toBe(ceoAgentId);
    expect(agent.reportsTo).toBe((await profileByTag("@tethr"))!.agentId);

    const tethr = await profileByTag("@tethr");
    const rows = tethr!.routingTable as Array<{ to: string }>;
    expect(rows.some((r) => r.to === "@tinkr")).toBe(true);
  });

  it("grants stage_org_change ONLY to @tinkr.change", () => {
    expect(toolsetForSubagent({ tag: "@tinkr.change" }).map((t) => t.name)).toContain(
      "stage_org_change",
    );
    for (const tag of ["@tethr.chat", "@tethr.plan", "@ceo.plan", "@sonar.leads", "@atlas.blog"]) {
      expect(
        toolsetForSubagent({ tag }).map((t) => t.name),
        `${tag} must not stage org changes`,
      ).not.toContain("stage_org_change");
    }
  });

  it("routes a rename through @tethr → Tinkr and stages a gated change (nothing applied)", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "rename @radar to Scout",
    });
    expect(result.status).toBe("gated");

    const output = await latestOrgChangeOutput();
    expect(output?.status).toBe("gated");
    expect(output?.approvalId).toBeTruthy();
    const meta = output?.meta as { change?: { op: string; newCodename?: string } };
    expect(meta.change?.op).toBe("rename");
    expect(meta.change?.newCodename).toBe("Scout");
    // The diff body names both states.
    expect(output?.body).toContain("Radar");
    expect(output?.body).toContain("Scout");

    // NOT applied: Radar is still Radar.
    expect(await profileByTag("@radar")).toBeTruthy();
    expect(await profileByTag("@scout")).toBeNull();
  });

  it("approving applies the rename cascade and logs a revertible change", async () => {
    const output = await latestOrgChangeOutput();
    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "approve",
      reviewer: "mark",
    });

    // Cascade: profile, agent name, subagent tags, @tethr routing table.
    expect(await profileByTag("@radar")).toBeNull();
    const scout = await profileByTag("@scout");
    expect(scout?.codename).toBe("Scout");
    const [agent] = await db.select().from(agents).where(eq(agents.id, scout!.agentId)).limit(1);
    expect(agent.name).toBe("Scout");
    expect((agent.adapterConfig as { agentTag?: string }).agentTag).toBe("@scout");

    const subs = await db
      .select()
      .from(tethrSubagents)
      .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.agentId, scout!.agentId)));
    expect(subs.length).toBeGreaterThan(0);
    expect(subs.every((s) => s.tag.startsWith("@scout."))).toBe(true);

    const tethr = await profileByTag("@tethr");
    const rows = tethr!.routingTable as Array<{ to: string }>;
    expect(rows.some((r) => r.to === "@scout")).toBe(true);
    expect(rows.some((r) => r.to === "@radar")).toBe(false);

    // The log row.
    const [change] = await db
      .select()
      .from(tethrOrgChanges)
      .where(and(eq(tethrOrgChanges.companyId, companyId), eq(tethrOrgChanges.op, "rename")))
      .orderBy(desc(tethrOrgChanges.appliedAt))
      .limit(1);
    expect(change.summary).toBe("rename: Radar → Scout");
    expect(change.status).toBe("applied");
    expect(change.before).toMatchObject({ codename: "Radar", tag: "@radar" });
    expect(change.after).toMatchObject({ codename: "Scout", tag: "@scout" });
  });

  it("revert stages the gated inverse; approving restores and marks the original", async () => {
    const [original] = await db
      .select()
      .from(tethrOrgChanges)
      .where(and(eq(tethrOrgChanges.companyId, companyId), eq(tethrOrgChanges.op, "rename")))
      .orderBy(desc(tethrOrgChanges.appliedAt))
      .limit(1);

    // Stage the inverse exactly as the revert endpoint does.
    const inverse = buildInverseSpec(original);
    expect(inverse).toMatchObject({ op: "rename", targetTag: "@scout", newCodename: "Radar" });
    const validated = await validateOrgChange(db, companyId, inverse);
    expect(validated.ok).toBe(true);
    const before = await computeBefore(db, companyId, validated.spec!);
    const tinkr = await profileByTag("@tinkr");
    const staged = await gatingService(db).createOutput({
      companyId,
      agentId: tinkr!.agentId,
      agentTag: "@tinkr",
      kind: "org_change",
      title: `Org change (revert): ${changeSummary(validated.spec!, before)}`,
      body: renderChangeBody(validated.spec!, before, validated.target!),
      sensitivity: "org",
      meta: { change: validated.spec, revertOfChangeId: original.id },
    });
    expect(staged?.status).toBe("gated");
    // Still Scout until approved.
    expect(await profileByTag("@scout")).toBeTruthy();

    await gatingService(db).decide({
      companyId,
      outputId: staged!.id,
      decision: "approve",
      reviewer: "mark",
    });

    expect(await profileByTag("@radar")).toBeTruthy();
    expect(await profileByTag("@scout")).toBeNull();

    const [reverted] = await db
      .select()
      .from(tethrOrgChanges)
      .where(eq(tethrOrgChanges.id, original.id))
      .limit(1);
    expect(reverted.status).toBe("reverted");
    expect(reverted.revertedByChangeId).toBeTruthy();
    const [inverseRow] = await db
      .select()
      .from(tethrOrgChanges)
      .where(eq(tethrOrgChanges.id, reverted.revertedByChangeId!))
      .limit(1);
    expect(inverseRow.revertOfChangeId).toBe(original.id);
  });

  it("rejecting a staged change applies nothing and logs nothing", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "set @radar budget to $80",
    });
    expect(result.status).toBe("gated");
    const output = await latestOrgChangeOutput();

    const logCountBefore = (
      await db.select().from(tethrOrgChanges).where(eq(tethrOrgChanges.companyId, companyId))
    ).length;
    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "reject",
      reviewer: "mark",
    });

    const radar = await profileByTag("@radar");
    const [agent] = await db.select().from(agents).where(eq(agents.id, radar!.agentId)).limit(1);
    expect(agent.budgetMonthlyCents).not.toBe(8000);
    const logCountAfter = (
      await db.select().from(tethrOrgChanges).where(eq(tethrOrgChanges.companyId, companyId))
    ).length;
    expect(logCountAfter).toBe(logCountBefore);
  });

  it("an approved budget change updates the agent AND its hard-stop policy", async () => {
    const routing = routingService(db);
    await routing.routeRequest({ companyId, requestText: "set @radar budget to $80" });
    const output = await latestOrgChangeOutput();
    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "approve",
      reviewer: "mark",
    });

    const radar = await profileByTag("@radar");
    const [agent] = await db.select().from(agents).where(eq(agents.id, radar!.agentId)).limit(1);
    expect(agent.budgetMonthlyCents).toBe(8000);
    const [policy] = await db
      .select()
      .from(budgetPolicies)
      .where(and(eq(budgetPolicies.companyId, companyId), eq(budgetPolicies.scopeId, radar!.agentId)))
      .limit(1);
    expect(policy.amount).toBe(8000);
  });

  it("refuses protected, unknown, and over-ceiling changes", async () => {
    const protectedRename = await validateOrgChange(db, companyId, {
      op: "rename",
      targetTag: "@tethr",
      newCodename: "Jarvis",
    });
    expect(protectedRename.ok).toBe(false);
    expect(protectedRename.errors.join(" ")).toMatch(/protected/);

    const unknown = await validateOrgChange(db, companyId, {
      op: "rename",
      targetTag: "@ghost",
      newCodename: "Anything",
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join(" ")).toMatch(/no such agent/);

    const overBudget = await validateOrgChange(db, companyId, {
      op: "update_budget",
      targetTag: "@radar",
      budgetMonthlyCents: 100000,
    });
    expect(overBudget.ok).toBe(false);
    expect(overBudget.errors.join(" ")).toMatch(/ceiling/);
  });

  it("approves a staged change from its Slack thread (sourceKey lookup)", async () => {
    const routing = routingService(db);
    const sourceKey = "slack:im:CINTHREAD";
    const run = await routing.routeRequest({ companyId, requestText: "pause @radar", sourceKey });
    expect(run.status).toBe("gated");

    // What the Slack handler does on an "approve" reply: find the pending item
    // for this thread, then decide it.
    const { findPendingGatedForThread } = await import("../tethr/slack.ts");
    const pending = await findPendingGatedForThread(db, companyId, sourceKey);
    expect(pending?.kind).toBe("org_change");
    // A different thread has nothing pending.
    expect(await findPendingGatedForThread(db, companyId, "slack:im:OTHER")).toBeNull();

    await gatingService(db).decide({
      companyId,
      outputId: pending!.id,
      decision: "approve",
      reviewer: "mark (Slack)",
    });
    const radar = await profileByTag("@radar");
    const [agent] = await db.select().from(agents).where(eq(agents.id, radar!.agentId)).limit(1);
    expect(agent.status).toBe("paused");
  });

  it("an unparseable ask answers inline instead of littering the Queue", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "modify the vibes of the org please",
    });
    expect(result.status).toBe("done"); // inline answer, nothing gated
    expect(result.resultText).toMatch(/exact change/i);
  });

  it("update_budget org_change has sensitivity=spend and blocks auto-approve", async () => {
    // Put Tinkr on auto-approve. A plain `org` change would then apply with no
    // human. A budget change must NOT: it is routed through the SPEND gate, and
    // spend can never auto-approve (only "org" can). This is the financial track.
    const tinkr = await profileByTag("@tinkr");
    await db
      .update(tethrAgentProfiles)
      .set({ autoApprove: true })
      .where(eq(tethrAgentProfiles.id, tinkr!.id));

    const radar = await profileByTag("@radar");
    const [agentBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, radar!.agentId))
      .limit(1);
    const budgetBefore = agentBefore.budgetMonthlyCents;

    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "set @radar budget to $90",
    });
    // Held for a human despite Tinkr being on auto — proof spend never auto-applies.
    expect(result.status).toBe("gated");

    const output = await latestOrgChangeOutput();
    expect((output?.meta as { change?: { op: string } }).change?.op).toBe("update_budget");
    expect(output?.sensitivity).toBe("spend"); // the whole point: spend, not org
    expect(output?.status).toBe("gated");
    expect(output?.approvalId).toBeTruthy(); // a blocking approvals row exists

    // Nothing applied: the cap is unchanged until a human approves.
    const [agentAfter] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, radar!.agentId))
      .limit(1);
    expect(agentAfter.budgetMonthlyCents).toBe(budgetBefore);

    // Reset so the auto flag doesn't leak into any later test.
    await db
      .update(tethrAgentProfiles)
      .set({ autoApprove: false })
      .where(eq(tethrAgentProfiles.id, tinkr!.id));
  });
});
