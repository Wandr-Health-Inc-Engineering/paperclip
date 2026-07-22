import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  createDb,
  tethrAgentProfiles,
  tethrOutputs,
  tethrSubagents,
} from "@paperclipai/db";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { seedCeoAgent } from "../tethr/seed/ceo.ts";
import { seedFilerAgent, FILER_AGENT } from "../tethr/seed/filer.ts";
import { validateDriveChange } from "../tethr/drive-changes.ts";
import { driveService } from "../tethr/drive.ts";
import { gatingService } from "../tethr/gating.ts";
import { routingService } from "../tethr/routing.ts";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Filer, the file archivist: staged soft-archives ("delete") that wait for a
// human confirmation. Never a hard delete; "destructive" sensitivity can never
// auto-approve. Routed only through @tethr — no Filer Slack bot.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tethr Filer (file archivist)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let mirrorRoot!: string;
  let companyId!: string;

  const sharedFile = (rel: string) => path.join(mirrorRoot, rel);
  const writeShared = (rel: string, content = "fixture content for the archive tests\n") => {
    const abs = sharedFile(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };

  const latestDriveChangeOutput = async () => {
    const [output] = await db
      .select()
      .from(tethrOutputs)
      .where(and(eq(tethrOutputs.companyId, companyId), eq(tethrOutputs.kind, "drive_change")))
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

  const subagentByTag = async (tag: string) => {
    const [s] = await db
      .select()
      .from(tethrSubagents)
      .where(and(eq(tethrSubagents.companyId, companyId), eq(tethrSubagents.tag, tag)))
      .limit(1);
    return s ?? null;
  };

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-filer-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY; // deterministic mock
    process.env.TETHR_LIVE_FETCH = "false";
    // A real (temp) shared workspace — the mirror is inert under test without
    // this explicit opt-in.
    mirrorRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-filer-test-mirror-"));
    process.env.TETHR_MIRROR_DIR = mirrorRoot;
    process.env.TETHR_MIRROR_ALLOW_TEST = "1";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-filer-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
    await seedCeoAgent(db, companyId);
    await seedFilerAgent(db, companyId);

    writeShared("01 Briefs/2026-07-14 Zanzibar.md");
    await driveService(db).putFile({
      companyId,
      path: "/scratch/old-notes.md",
      content: "old working notes",
      createdByTag: "@tethr",
    });
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
    delete process.env.TETHR_MIRROR_DIR;
    delete process.env.TETHR_MIRROR_ALLOW_TEST;
  });

  it("seeds Filer idempotently — reports to @tethr (system agent, beside the org), no heartbeat", async () => {
    const again = await seedFilerAgent(db, companyId);
    expect(again.created).toBe(false);

    const profile = await profileByTag("@filer");
    expect(profile?.codename).toBe(FILER_AGENT.codename);
    const [agent] = await db.select().from(agents).where(eq(agents.id, profile!.agentId)).limit(1);
    // System/admin agents sit under @tethr (the conductor), NOT in the CEO's chain.
    const ceo = await profileByTag("@ceo");
    const tethr = await profileByTag("@tethr");
    expect(agent.reportsTo).not.toBe(ceo?.agentId);
    expect(agent.reportsTo).toBe(tethr?.agentId);

    const rows = tethr!.routingTable as Array<{ to: string }>;
    expect(rows.some((r) => r.to === "@filer")).toBe(true);
  });

  it("grants stage_file_archive ONLY to @filer.archive", async () => {
    const filerSub = await subagentByTag("@filer.archive");
    expect(toolsetForSubagent(filerSub!).map((t) => t.name)).toContain("stage_file_archive");
    for (const tag of ["@tethr.chat", "@tethr.plan", "@ceo.plan"]) {
      const sub = await subagentByTag(tag);
      if (!sub) continue;
      expect(toolsetForSubagent(sub).map((t) => t.name)).not.toContain("stage_file_archive");
    }
  });

  it("routes a delete through @tethr → Filer and stages a gated archive (nothing moved)", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: 'delete the file "01 Briefs/2026-07-14 Zanzibar.md"',
    });
    expect(result.status).toBe("gated");

    const output = await latestDriveChangeOutput();
    expect(output?.status).toBe("gated");
    expect(output?.sensitivity).toBe("destructive");
    expect(output?.approvalId).toBeTruthy();
    const meta = output?.meta as { driveChange?: { store: string; path: string } };
    expect(meta.driveChange).toMatchObject({ store: "shared", path: "01 Briefs/2026-07-14 Zanzibar.md" });
    expect(output?.body).toContain("99 Archive");
    expect(output?.body).toContain("soft delete");

    // NOT moved: still on disk at the original path.
    expect(fs.existsSync(sharedFile("01 Briefs/2026-07-14 Zanzibar.md"))).toBe(true);
  });

  it("approving applies the shared-workspace archive (soft move to 99 Archive)", async () => {
    const output = await latestDriveChangeOutput();
    await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "approve",
      reviewer: "mark",
    });

    expect(fs.existsSync(sharedFile("01 Briefs/2026-07-14 Zanzibar.md"))).toBe(false);
    expect(fs.existsSync(sharedFile("99 Archive/2026-07-14 Zanzibar.md"))).toBe(true);

    const [updated] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, output!.id)).limit(1);
    expect(updated.status).toBe("published");
    const meta = updated.meta as { applied?: { from: string; to: string } };
    expect(meta.applied?.from).toBe("01 Briefs/2026-07-14 Zanzibar.md");
    expect(meta.applied?.to).toContain("99 Archive/");
  });

  it("approving applies an internal-Drive archive via archiveNode", async () => {
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "delete the file /scratch/old-notes.md",
    });
    expect(result.status).toBe("gated");
    const output = await latestDriveChangeOutput();
    expect((output?.meta as { driveChange?: { store: string } }).driveChange?.store).toBe("internal");

    await gatingService(db).decide({ companyId, outputId: output!.id, decision: "approve", reviewer: "mark" });

    const drive = driveService(db);
    expect(await drive.findNodeByPath(companyId, "/scratch/old-notes.md")).toBeNull();
    expect(await drive.findNodeByPath(companyId, "/archive/old-notes.md")).not.toBeNull();
  });

  it("rejecting a staged archive keeps the file (fuzzy basename resolution works too)", async () => {
    writeShared("02 Documents/keep-me.md");
    const routing = routingService(db);
    // Basename only — the validator resolves it to the unique full path.
    const result = await routing.routeRequest({ companyId, requestText: 'delete the file "keep-me.md"' });
    expect(result.status).toBe("gated");
    const output = await latestDriveChangeOutput();
    expect((output?.meta as { driveChange?: { path: string } }).driveChange?.path).toBe("02 Documents/keep-me.md");

    await gatingService(db).decide({ companyId, outputId: output!.id, decision: "reject", reviewer: "mark" });

    expect(fs.existsSync(sharedFile("02 Documents/keep-me.md"))).toBe(true);
    expect(fs.existsSync(sharedFile("99 Archive/keep-me.md"))).toBe(false);
    const [updated] = await db.select().from(tethrOutputs).where(eq(tethrOutputs.id, output!.id)).limit(1);
    expect(updated.status).toBe("rejected");
  });

  it("auto-approve can NEVER archive — destructive is structurally excluded", async () => {
    writeShared("01 Briefs/auto-test.md");
    const filer = await profileByTag("@filer");
    await db
      .update(tethrAgentProfiles)
      .set({ autoApprove: true })
      .where(eq(tethrAgentProfiles.id, filer!.id));

    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: 'delete the file "01 Briefs/auto-test.md"',
    });
    // Held for a human despite Filer being on auto (auto fires only for "org").
    expect(result.status).toBe("gated");
    const output = await latestDriveChangeOutput();
    expect(output?.status).toBe("gated");
    expect(fs.existsSync(sharedFile("01 Briefs/auto-test.md"))).toBe(true);

    await db
      .update(tethrAgentProfiles)
      .set({ autoApprove: false })
      .where(eq(tethrAgentProfiles.id, filer!.id));
  });

  it("refuses protected paths, folders, and missing files", async () => {
    writeShared("99 Archive/already-archived.md");
    const cases: Array<{ input: Record<string, unknown>; error: RegExp }> = [
      { input: { store: "shared", path: "99 Archive/already-archived.md" }, error: /protected/ },
      { input: { store: "shared", path: "00 START HERE.md" }, error: /protected/ },
      { input: { store: "shared", path: "01 Briefs" }, error: /folder/ },
      { input: { store: "shared", path: "does-not-exist-anywhere.md" }, error: /no file named/ },
      { input: { store: "internal", path: "/archive/x.md" }, error: /protected/ },
      { input: { store: "internal", path: "/" }, error: /protected/ },
      { input: { store: "nope", path: "x.md" }, error: /store must be/ },
    ];
    for (const c of cases) {
      const v = await validateDriveChange(db, companyId, c.input);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.join(" ")).toMatch(c.error);
    }
  });

  it("a file that vanishes between staging and approval fails the apply cleanly", async () => {
    writeShared("01 Briefs/vanish.md");
    const routing = routingService(db);
    await routing.routeRequest({ companyId, requestText: 'delete the file "01 Briefs/vanish.md"' });
    const output = await latestDriveChangeOutput();
    expect(output?.status).toBe("gated");

    fs.rmSync(sharedFile("01 Briefs/vanish.md"));
    const decided = await gatingService(db).decide({
      companyId,
      outputId: output!.id,
      decision: "approve",
      reviewer: "mark",
    });
    // No throw; output closed rejected with the reason, nothing else moved.
    expect(decided?.status).toBe("rejected");
    expect((decided?.meta as { applyError?: string }).applyError).toBeTruthy();
    expect(fs.existsSync(sharedFile("99 Archive/vanish.md"))).toBe(false);
  });

  it("approves a staged archive from its Slack thread (sourceKey lookup)", async () => {
    writeShared("02 Documents/slack-delete-me.md");
    const routing = routingService(db);
    const sourceKey = "slack:im:CFILERTHREAD";
    const run = await routing.routeRequest({
      companyId,
      requestText: 'delete the file "02 Documents/slack-delete-me.md"',
      sourceKey,
    });
    expect(run.status).toBe("gated");

    const { findPendingGatedForThread } = await import("../tethr/slack.ts");
    const pending = await findPendingGatedForThread(db, companyId, sourceKey);
    expect(pending?.kind).toBe("drive_change");

    await gatingService(db).decide({
      companyId,
      outputId: pending!.id,
      decision: "approve",
      reviewer: "mark (Slack)",
    });
    expect(fs.existsSync(sharedFile("02 Documents/slack-delete-me.md"))).toBe(false);
    expect(fs.existsSync(sharedFile("99 Archive/slack-delete-me.md"))).toBe(true);
  });

  it("an unparseable ask answers inline instead of littering the Queue", async () => {
    const before = await latestDriveChangeOutput();
    const routing = routingService(db);
    const result = await routing.routeRequest({
      companyId,
      requestText: "clean up the drive somehow maybe?",
    });
    expect(result.status).toBe("done"); // inline answer, nothing gated
    expect(result.resultText).toMatch(/exact file/i);
    const after = await latestDriveChangeOutput();
    expect(after?.id).toBe(before?.id); // no new drive_change output
  });
});
