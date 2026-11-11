import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, tethrOutputs } from "@paperclipai/db";
import {
  MIRROR_FOLDERS,
  backfillMirror,
  composeMirrorDoc,
  ensureStartHere,
  mirrorConfigured,
  mirrorDir,
  mirrorPublishedOutput,
  mirrorRelPath,
  mirrorTree,
  parseMirrorDirectives,
  sanitizeFolderHint,
  sanitizeTitleForFilename,
} from "../tethr/mirror.ts";
import { gatingService } from "../tethr/gating.ts";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { driveService } from "../tethr/drive.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The shared-workspace mirror ("00 Tethr", Google Drive desktop sync). Pins:
// the taxonomy allowlist, filename/traversal safety, atomic writes, the
// human-delete-is-final contract, and — critically — that the mirror is INERT
// under test unless a test explicitly opts in with a temp dir.

const ENV_KEYS = ["TETHR_MIRROR_DIR", "TETHR_MIRROR_ALLOW_TEST"] as const;
const savedEnv: Record<string, string | undefined> = {};

let tmpRoot: string;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-mirror-test-"));
  process.env.TETHR_MIRROR_DIR = tmpRoot;
  process.env.TETHR_MIRROR_ALLOW_TEST = "1";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeDb(): Parameters<typeof mirrorPublishedOutput>[0] {
  // mirrorPublishedOutput only touches db for the meta.mirror bookkeeping —
  // a stub keeps the unit cases DB-free (row lookup misses → skip update).
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as Parameters<typeof mirrorPublishedOutput>[0];
}

const BASE = {
  outputId: "11111111-2222-3333-4444-555555555555",
  kind: "brief" as const,
  title: "Peru Escalation Brief",
  body: "## Summary\n\nGo / no-go call on Peru ads.",
  agentTag: "@radar",
  publishedAt: new Date("2026-07-13T12:00:00"),
};

describe("mirror guard rails", () => {
  it("is inert under test without the explicit escape hatch (protects every other suite)", () => {
    delete process.env.TETHR_MIRROR_ALLOW_TEST;
    expect(mirrorDir()).toBeNull();
    expect(mirrorConfigured()).toBe(false);
  });

  it("is off when the env var is unset, relative, or points at a missing dir", () => {
    delete process.env.TETHR_MIRROR_DIR;
    expect(mirrorConfigured()).toBe(false);
    process.env.TETHR_MIRROR_DIR = "relative/path";
    expect(mirrorConfigured()).toBe(false);
    process.env.TETHR_MIRROR_DIR = path.join(tmpRoot, "does-not-exist");
    expect(mirrorConfigured()).toBe(false);
    process.env.TETHR_MIRROR_DIR = tmpRoot;
    expect(mirrorConfigured()).toBe(true);
  });
});

describe("sanitization & paths", () => {
  it("cleans separators, reserved chars, and control chars from titles", () => {
    expect(sanitizeTitleForFilename('a/b\\c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(sanitizeTitleForFilename("  spaced   out  ")).toBe("spaced out");
    expect(sanitizeTitleForFilename("...hidden")).toBe("hidden");
    expect(sanitizeTitleForFilename("trailing dots... ")).toBe("trailing dots");
  });

  it("caps overlong titles and falls back on degenerate ones", () => {
    expect(sanitizeTitleForFilename("x".repeat(300)).length).toBeLessThanOrEqual(80);
    expect(sanitizeTitleForFilename("////***???")).toBe("Untitled");
    expect(sanitizeTitleForFilename("Perú — señal de demanda")).toContain("Perú");
  });

  it("a traversal attempt in the title cannot escape the root", async () => {
    const res = await mirrorPublishedOutput(fakeDb(), {
      ...BASE,
      title: "../../../../etc/passwd",
    });
    expect(res.written).toBe(true);
    // The file landed INSIDE the temp root, under the brief folder.
    expect(res.relPath!.startsWith("01 Briefs/")).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, res.relPath!))).toBe(true);
    expect(fs.existsSync("/etc/passwd.md")).toBe(false);
  });

  it("folder hints are sanitized: depth-capped, archive + dotpaths rejected", () => {
    expect(sanitizeFolderHint("07 Competitor Analysis")).toBe("07 Competitor Analysis");
    expect(sanitizeFolderHint("a/b/c/d/e")).toBe("a/b/c");
    expect(sanitizeFolderHint("99 Archive/sneaky")).toBeNull();
    expect(sanitizeFolderHint("../..")).toBeNull();
    expect(sanitizeFolderHint(".hidden/stuff")).toBe("hidden/stuff");
    expect(sanitizeFolderHint("")).toBeNull();
  });

  it("maps every allowlisted kind and refuses the rest", () => {
    const date = new Date("2026-07-13T12:00:00");
    expect(mirrorRelPath("brief", "T", date)).toBe("01 Briefs/2026-07-13 T");
    expect(mirrorRelPath("blog_draft", "T", date)).toBe("04 Content/Blog Drafts/2026-07-13 T");
    expect(mirrorRelPath("answer", "T", date)).toBeNull();
    expect(mirrorRelPath("agent_proposal", "T", date)).toBeNull();
    expect(mirrorRelPath("org_change", "T", date)).toBeNull();
    // A hint can file an allowlisted kind elsewhere but cannot rescue an unmapped kind alone —
    // unmapped kinds with a hint DO mirror (the overseer approved the destination).
    expect(mirrorRelPath("answer", "T", date, "07 Custom")).toBe("07 Custom/2026-07-13 T");
  });
});

describe("directive parsing (agent filing)", () => {
  it("parses and strips [file-under] + [format] from the top of a body", () => {
    const parsed = parseMirrorDirectives(
      "[file-under: 07 Competitor Analysis]\n[format: pdf]\n\n## The real content\nBody here.",
    );
    expect(parsed.folder).toBe("07 Competitor Analysis");
    expect(parsed.format).toBe("pdf");
    expect(parsed.body.startsWith("## The real content")).toBe(true);
  });

  it("leaves bodies without directives untouched and ignores bogus formats", () => {
    const plain = parseMirrorDirectives("## Just content\n[file-under: too late]");
    expect(plain.folder).toBeUndefined();
    expect(plain.body).toContain("## Just content");
    const bogus = parseMirrorDirectives("[format: exe]\n\nBody");
    expect(bogus.format).toBeUndefined();
  });
});

describe("writes", () => {
  it("writes the markdown projection with front matter", async () => {
    const res = await mirrorPublishedOutput(fakeDb(), BASE);
    expect(res).toMatchObject({ written: true, format: "md" });
    expect(res.relPath).toBe("01 Briefs/2026-07-13 Peru Escalation Brief.md");
    const text = fs.readFileSync(path.join(tmpRoot, res.relPath!), "utf8");
    expect(text).toContain("output: 11111111-2222-3333-4444-555555555555");
    expect(text).toContain("agent: @radar");
    expect(text).toContain("# Peru Escalation Brief");
    expect(text).toContain("Go / no-go call on Peru ads.");
  });

  it("republishing the SAME output overwrites its file; a DIFFERENT output suffixes", async () => {
    await mirrorPublishedOutput(fakeDb(), BASE);
    const again = await mirrorPublishedOutput(fakeDb(), { ...BASE, body: "v2 body" });
    expect(again.relPath).toBe("01 Briefs/2026-07-13 Peru Escalation Brief.md");
    expect(fs.readFileSync(path.join(tmpRoot, again.relPath!), "utf8")).toContain("v2 body");

    const other = await mirrorPublishedOutput(fakeDb(), {
      ...BASE,
      outputId: "99999999-8888-7777-6666-555555555555",
    });
    expect(other.relPath).toBe("01 Briefs/2026-07-13 Peru Escalation Brief (99999999).md");
    expect(fs.readdirSync(path.join(tmpRoot, "01 Briefs"))).toHaveLength(2);
  });

  it("honors a folder hint (auto-creating nested folders) and leaves no temp files", async () => {
    const res = await mirrorPublishedOutput(fakeDb(), {
      ...BASE,
      folder: "07 Competitor Analysis/Q3",
    });
    expect(res.relPath).toBe("07 Competitor Analysis/Q3/2026-07-13 Peru Escalation Brief.md");
    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else all.push(e.name);
      }
    };
    walk(tmpRoot);
    expect(all.some((n) => n.includes(".tethr-mirror-"))).toBe(false);
  });

  it("unmapped kinds are skipped; unconfigured is a quiet no-op", async () => {
    const skipped = await mirrorPublishedOutput(fakeDb(), { ...BASE, kind: "answer" });
    expect(skipped).toMatchObject({ written: false, reason: "kind-unmapped" });
    delete process.env.TETHR_MIRROR_DIR;
    const off = await mirrorPublishedOutput(fakeDb(), BASE);
    expect(off).toMatchObject({ written: false, reason: "not-configured" });
  });

  it("write failures are swallowed, never thrown", async () => {
    // A file where a folder must go forces mkdir to fail.
    fs.writeFileSync(path.join(tmpRoot, "01 Briefs"), "not a folder");
    const res = await mirrorPublishedOutput(fakeDb(), BASE);
    expect(res.written).toBe(false);
  });

  it("00 START HERE.md is created once and not rewritten", async () => {
    await ensureStartHere();
    const p = path.join(tmpRoot, "00 START HERE.md");
    expect(fs.existsSync(p)).toBe(true);
    fs.writeFileSync(p, "human edited");
    await ensureStartHere();
    expect(fs.readFileSync(p, "utf8")).toBe("human edited");
  });
});

describe("live tree view", () => {
  it("walks the real folder statelessly, skipping dotfiles", async () => {
    fs.mkdirSync(path.join(tmpRoot, "01 Briefs"), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, "01 Briefs", "a.md"), "x");
    fs.writeFileSync(path.join(tmpRoot, ".hidden.tmp"), "x");
    const view = await mirrorTree();
    expect(view.enabled).toBe(true);
    const names = view.tree!.map((n) => n.name);
    expect(names).toContain("01 Briefs");
    expect(names).not.toContain(".hidden.tmp");
    const briefs = view.tree!.find((n) => n.name === "01 Briefs");
    expect(briefs?.children?.[0]?.name).toBe("a.md");

    // A human delete shows up on the very next call — nothing is cached.
    fs.rmSync(path.join(tmpRoot, "01 Briefs"), { recursive: true });
    const after = await mirrorTree();
    expect(after.tree!.map((n) => n.name)).not.toContain("01 Briefs");
  });

  it("reports enabled:false when unconfigured", async () => {
    delete process.env.TETHR_MIRROR_DIR;
    expect((await mirrorTree()).enabled).toBe(false);
  });
});

describe("composeMirrorDoc", () => {
  it("front matter carries agent, kind, date, and the output uuid", () => {
    const doc = composeMirrorDoc(BASE);
    expect(doc.startsWith("---\n")).toBe(true);
    expect(doc).toContain("kind: brief");
    expect(doc).toContain("date: 2026-07-13");
  });
});

// ---------------------------------------------------------------------------
// Backfill (embedded postgres): published deliverables project; answers,
// gated-unapproved outputs, and human uploads never do; deletes are final.
// ---------------------------------------------------------------------------

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("mirror backfill", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-mirror-bf-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-mirror-");
    db = createDb(tempDb.connectionString);
    const core = await seedTethrCore(db);
    companyId = core.companyId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  async function makeOutput(kind: string, title: string, sensitivity = "internal") {
    const gating = gatingService(db);
    return gating.createOutput({
      companyId,
      agentId: (await firstAgentId()) as string,
      agentTag: "@tethr",
      kind: kind as never,
      title,
      body: `Body of ${title}`,
      sensitivity: sensitivity as never,
    });
  }

  async function firstAgentId(): Promise<string> {
    const { agents } = await import("@paperclipai/db");
    const [a] = await db.select().from(agents).where(eq(agents.companyId, companyId)).limit(1);
    return a.id;
  }

  it("projects published deliverables only; re-run is a no-op; force resurrects", async () => {
    // Create with the mirror OFF so the publish-time hook stays inert — this
    // test exercises the backfill path in isolation.
    delete process.env.TETHR_MIRROR_DIR;
    // 2 deliverables (safe → auto-publish), 1 answer (auto-publish, unmapped),
    // 1 gated brief left pending, 1 human drive upload.
    await makeOutput("document", "Doc One", "safe");
    await makeOutput("document", "Doc Two", "safe");
    await makeOutput("answer", "Chat reply", "safe");
    await makeOutput("brief", "Gated brief", "medical"); // stays gated
    await driveService(db).putFile({
      companyId,
      path: "/documents/human-upload.md",
      content: "human file",
      createdByTag: "mark",
    });
    process.env.TETHR_MIRROR_DIR = tmpRoot; // mirror back on for the backfill

    const first = await backfillMirror(db, companyId);
    expect(first.written).toBe(2);
    const docs = fs.readdirSync(path.join(tmpRoot, "02 Documents"));
    expect(docs).toHaveLength(2);
    expect(docs.some((n) => n.includes("Doc One"))).toBe(true);
    // Nothing else escaped: no answers, no gated, no uploads.
    expect(fs.existsSync(path.join(tmpRoot, "01 Briefs"))).toBe(false);

    // Idempotent: second run writes nothing.
    const second = await backfillMirror(db, companyId);
    expect(second.written).toBe(0);
    expect(second.skippedUpToDate).toBe(2);

    // Human deletes a file → still not resurrected (delete is final)…
    fs.rmSync(path.join(tmpRoot, "02 Documents"), { recursive: true });
    const third = await backfillMirror(db, companyId);
    expect(third.written).toBe(0);
    // …unless force is explicit.
    const forced = await backfillMirror(db, companyId, { force: true });
    expect(forced.written).toBe(2);
  }, 30_000);

  it("records meta.mirror on the output row after projecting", async () => {
    const rows = await db
      .select()
      .from(tethrOutputs)
      .where(eq(tethrOutputs.companyId, companyId));
    const mirrored = rows.filter(
      (r) => ((r.meta ?? {}) as Record<string, unknown>).mirror,
    );
    expect(mirrored.length).toBeGreaterThanOrEqual(2);
    const m = (mirrored[0].meta as { mirror: { relPath: string; format: string } }).mirror;
    expect(m.relPath).toContain("02 Documents/");
    expect(m.format).toBe("md");
  });
});
