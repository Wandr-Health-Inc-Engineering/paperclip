import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  approvals,
  createDb,
  tethrDriveNodes,
  tethrSubagents,
} from "@paperclipai/db";
import { MockProvider } from "../tethr/llm/mock.ts";
import { driveService } from "../tethr/drive.ts";
import { gatingService } from "../tethr/gating.ts";
import { memoryService } from "../tethr/memory.ts";
import { orgService } from "../tethr/org.ts";
import { routingService } from "../tethr/routing.ts";
import { seedWandrGrowth } from "../tethr/seed/seed.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// ---------------------------------------------------------------------------
// Mock provider — deterministic classification + shaped generation
// ---------------------------------------------------------------------------

describe("tethr mock LLM provider", () => {
  const provider = new MockProvider();
  const options = [
    {
      tag: "@sonar",
      description: "Scout for travelers asking health Qs",
      when: ["finding leads", "scan reddit", "travel-health news", "news scan"],
    },
    {
      tag: "@ledger",
      description: "Economics, guardrails, analytics dashboard",
      when: ["what we can afford", "cac", "roas", "budget"],
    },
    {
      tag: "@atlas",
      description: "Content & SEO drafting",
      when: ["blog posts", "seo", "write a post"],
    },
  ];

  it("classifies by keyword score deterministically", async () => {
    const a = await provider.classify({
      layer: "helm",
      actorTag: "@helm",
      request: "Can we afford to spend more on Peru? What is our max CAC?",
      options,
    });
    expect(a.choiceTag).toBe("@ledger");

    const b = await provider.classify({
      layer: "helm",
      actorTag: "@helm",
      request: "scan reddit for fresh travel-health questions",
      options,
    });
    expect(b.choiceTag).toBe("@sonar");

    // Same input, same answer.
    const b2 = await provider.classify({
      layer: "helm",
      actorTag: "@helm",
      request: "scan reddit for fresh travel-health questions",
      options,
    });
    expect(b2.choiceTag).toBe(b.choiceTag);
  });

  it("generates realistically-shaped output per kind", async () => {
    const reply = await provider.generate({
      system: "You are @sonar.reply",
      prompt: "Draft a reply to the typhoid thread",
      kind: "reply_draft",
    });
    expect(reply.body).toContain("human posts this");
    expect(reply.body).not.toContain("Z-Pak");
    expect(reply.usage.outputTokens).toBeGreaterThan(0);

    const ads = await provider.generate({
      system: "You are @tailwind.bids",
      prompt: "Adjust bids for the Peru campaign",
      kind: "ads_recommendation",
    });
    expect(ads.body).toContain("human approval");
  });
});

// ---------------------------------------------------------------------------
// Integration: seed → routing → hard gate → publish (embedded postgres)
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tethr engine end-to-end", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.TETHR_BUNDLE_PATH; // force the vendored fallback specs
    delete process.env.ANTHROPIC_API_KEY; // force the mock provider

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-");
    db = createDb(tempDb.connectionString);
    const result = await seedWandrGrowth(db, { demo: false });
    companyId = result.companyId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("seeds the full org: divisions, CEO→Helm→8 agents, 22 subagents", async () => {
    const org = orgService(db);
    const divisions = await org.listDivisions(companyId);
    expect(divisions).toHaveLength(4);
    expect(divisions.find((d) => d.key === "growth")?.status).toBe("active");
    expect(divisions.filter((d) => d.status === "shell")).toHaveLength(3);

    const profiles = await org.listProfiles(companyId);
    expect(profiles).toHaveLength(10); // ceo + helm + 8

    const subagents = await org.listSubagents(companyId);
    expect(subagents).toHaveLength(22);

    const helm = await org.getProfileByTag(companyId, "@helm");
    expect(helm?.profile.routingTable.length).toBe(8);
  });

  it("routes a safe request down the chain and publishes without a gate", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "Any travel health news today worth writing about?",
      invocationSource: "console",
    });
    expect(result.status).toBe("done");
    expect(result.hops.slice(0, 3).map((h) => h.layer)).toEqual(["helm", "agent", "subagent"]);
    expect(result.hops[0].decision).toContain("@sonar");
    expect(result.hops[1].decision).toContain("@sonar.news");
    // The subagent used its tools, and the calls are recorded as hops.
    expect(result.hops.some((h) => h.layer === "tool")).toBe(true);
    expect(result.outputs).toHaveLength(1);
    expect(result.outputs[0].gated).toBe(false);
    expect(result.outputs[0].status).toBe("published");
  });

  it("enforces tool allowlists per subagent", async () => {
    const { toolsetForSubagent } = await import("../tethr/tools/index.ts");
    const names = (tag: string) => toolsetForSubagent({ tag }).map((t) => t.name);
    expect(names("@sonar.leads")).toContain("reddit_scan");
    expect(names("@sonar.leads")).not.toContain("drive_write");
    expect(names("@atlas.blog")).toContain("advance_tracker");
    expect(names("@beacon.brand")).not.toContain("web_fetch");
    // Everyone can read the Drive and recall memory.
    expect(names("@ledger.modeler")).toEqual(
      expect.arrayContaining(["drive_list", "drive_read", "recall_memory"]),
    );
  });

  it("drive_write refuses paths outside the working areas", async () => {
    const { getToolByName } = await import("../tethr/tools/index.ts");
    const org = orgService(db);
    const sonar = await org.getProfileByTag(companyId, "@sonar");
    const tool = getToolByName("drive_write")!;
    const ctx = {
      db,
      companyId,
      agentId: sonar!.agent.id,
      agentTag: "@sonar",
      subagentTag: "@sonar.leads",
    };
    const refused = await tool.execute(ctx, {
      path: "/content/blog/sneaky.md",
      content: "should not land",
    });
    expect(refused.output).toContain("Refused");
    const allowed = await tool.execute(ctx, {
      path: "/scratch/notes.md",
      content: "working notes",
    });
    expect(allowed.output).toContain("Saved");
  });

  it("atlas heartbeat claims a calendar row; approval publishes + advances it", async () => {
    const routing = routingService(db);
    const gating = gatingService(db);
    const { trackerService } = await import("../tethr/state.ts");
    const trackers = trackerService(db);

    const before = await trackers.readTracker(companyId, "content-calendar");
    const ideasBefore = before.rows.filter((r) => r.status === "idea").length;
    expect(ideasBefore).toBeGreaterThan(0);

    const result = await routing.routeRequest({
      companyId,
      requestText:
        "Write today's post: draft the next GEO/SEO blog article from the content calendar and stage it for review.",
      invocationSource: "heartbeat",
      startAtAgentTag: "@atlas",
      subagentChain: ["blog"],
    });
    expect(result.status).toBe("gated");
    const claimHop = result.hops.find(
      (h) => h.layer === "tool" && h.decision === "advance_tracker",
    );
    expect(claimHop).toBeTruthy();

    const after = await trackers.readTracker(companyId, "content-calendar");
    const claimed = after.rows.find((r) => r.status === "review");
    expect(claimed).toBeTruthy();
    // The mock drafts the claimed topic, not an invented one.
    expect(result.outputs[0].title.toLowerCase()).toContain(
      claimed!.topic.split(" ")[0].toLowerCase(),
    );

    await gating.decide({
      companyId,
      outputId: result.outputs[0].outputId,
      decision: "approve",
      reviewer: "mark",
      note: "Clinically fine.",
    });
    const published = await trackers.readTracker(companyId, "content-calendar");
    expect(published.rows.find((r) => r.slug === claimed!.slug)?.status).toBe("published");
    const log = await trackers.listPublished(companyId);
    expect(log.some((e) => e.kind === "blog_draft")).toBe(true);
  });

  it("hard-gates the Sonar reply and only publishes after approval", async () => {
    const routing = routingService(db);
    const gating = gatingService(db);

    // The Sonar heartbeat chain: leads (safe) then reply (public-facing).
    const result = await routing.routeRequest({
      companyId,
      requestText:
        "Run the morning scout: scan for travel-health questions and draft a reply for the top thread.",
      invocationSource: "heartbeat",
      startAtAgentTag: "@sonar",
      subagentChain: ["leads", "reply"],
    });
    expect(result.status).toBe("gated");
    expect(result.outputs).toHaveLength(2);
    const [leads, reply] = result.outputs;
    expect(leads.gated).toBe(false);
    expect(reply.gated).toBe(true);

    // The gate is hard: publish is blocked while the approval is pending.
    await expect(gating.publishToDrive(reply.outputId, companyId, "mark")).rejects.toThrow(
      /cannot publish/i,
    );

    const gated = await gating.getOutput(companyId, reply.outputId);
    expect(gated?.status).toBe("gated");
    expect(gated?.approvalId).toBeTruthy();
    const [approval] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, gated!.approvalId!));
    expect(approval.status).toBe("pending");

    // Approve → publishes to the Drive with reviewer + note recorded.
    const published = await gating.decide({
      companyId,
      outputId: reply.outputId,
      decision: "approve",
      reviewer: "mark",
      note: "Zero-promo confirmed. Send it.",
    });
    expect(published.status).toBe("published");
    expect(published.driveNodeId).toBeTruthy();

    const [decided] = await db
      .select()
      .from(approvals)
      .where(eq(approvals.id, gated!.approvalId!));
    expect(decided.status).toBe("approved");
    expect(decided.decidedByUserId).toBe("mark");
    expect(decided.decisionNote).toContain("Zero-promo");

    const [node] = await db
      .select()
      .from(tethrDriveNodes)
      .where(eq(tethrDriveNodes.id, published.driveNodeId!));
    expect(node.path.startsWith("/scout/replies/")).toBe(true);
  });

  it("reject and request-changes never publish", async () => {
    const routing = routingService(db);
    const gating = gatingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "Adjust bids to scale the Peru search campaign by 20%",
      invocationSource: "console",
    });
    expect(result.status).toBe("gated");
    const outputId = result.outputs[0].outputId;

    const changed = await gating.decide({
      companyId,
      outputId,
      decision: "request_changes",
      reviewer: "mark",
      note: "Re-run against next week's guardrails first.",
    });
    expect(changed.status).toBe("changes_requested");

    const rejected = await gating.decide({
      companyId,
      outputId,
      decision: "reject",
      reviewer: "mark",
      note: "CAC headroom too thin this month.",
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.publishedAt).toBeNull();
    await expect(gating.publishToDrive(outputId, companyId, "mark")).rejects.toThrow();
  });

  it("escalates ambiguous requests to the closest match instead of stalling", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "hmm not sure what I need",
      invocationSource: "console",
    });
    // Deterministic mock falls back to the closest match; the run completes.
    expect(["done", "gated"]).toContain(result.status);
    expect(result.hops.length).toBeGreaterThanOrEqual(3);
  });

  it("drive keeps versions, tags, and permissions", async () => {
    const drive = driveService(db);
    const first = await drive.putFile({
      companyId,
      path: "/content/blog/test-post.md",
      content: "# v1",
      createdByTag: "@atlas",
      note: "first draft",
    });
    expect(first.version.versionNumber).toBe(1);

    const second = await drive.putFile({
      companyId,
      path: "/content/blog/test-post.md",
      content: "# v2 — revised",
      createdByTag: "@atlas",
      note: "after review",
    });
    expect(second.version.versionNumber).toBe(2);
    expect(second.node.id).toBe(first.node.id);

    const current = await drive.readCurrent(companyId, second.node.id);
    expect(current?.content.toString("utf8")).toContain("v2 — revised");

    const versions = await drive.listVersions(companyId, second.node.id);
    expect(versions).toHaveLength(2);
    const v1 = versions.find((v) => v.versionNumber === 1);
    const v1Read = await drive.readVersion(companyId, v1!.id);
    expect(v1Read?.content.toString("utf8")).toBe("# v1");

    const tagged = await drive.setTags(companyId, second.node.id, ["draft", "blog"]);
    expect(tagged?.tags).toEqual(["draft", "blog"]);

    const perms = await drive.setPermissions(companyId, second.node.id, {
      owner: "mark",
      read: ["*"],
      write: ["mark", "@atlas"],
    });
    expect(perms?.permissions.write).toContain("@atlas");
  });

  it("records and recalls memory per agent plus company-wide", async () => {
    const org = orgService(db);
    const memory = memoryService(db);
    const sonar = await org.getProfileByTag(companyId, "@sonar");

    await memory.record({
      companyId,
      agentId: sonar!.agent.id,
      kind: "history",
      content: "Found a strong typhoid-prep lead on r/travel.",
    });
    const recalled = await memory.recall(companyId, sonar!.agent.id, "typhoid");
    expect(recalled.some((m) => m.content.includes("typhoid-prep lead"))).toBe(true);

    // Company-wide rules are visible to every agent.
    const rules = await memory.recall(companyId, sonar!.agent.id, "Z-Pak");
    expect(rules.length).toBeGreaterThan(0);
  });

  it("updates subagent lastRunAt after work", async () => {
    const [news] = await db
      .select()
      .from(tethrSubagents)
      .where(
        and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, "@sonar.news")),
      );
    expect(news.lastRunAt).toBeTruthy();
  });
});
