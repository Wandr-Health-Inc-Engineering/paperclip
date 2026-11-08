import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, tethrRouteRuns } from "@paperclipai/db";
import {
  attachmentName,
  panelPathFor,
  saveAttachment,
  splitAttachments,
  validateAttachments,
  withAttachments,
} from "../tethr/assistant/attachments.ts";
import { classify } from "../tethr/assistant/policy.ts";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 19.1: files Mark attaches to a chat message.

describe("tethr chat attachments — files", () => {
  const now = new Date(2026, 10, 7, 9, 30);

  it("keeps readable types with safe names, and turns others away", () => {
    expect(attachmentName("Q4 plan.PDF")).toEqual({ name: "Q4 plan.pdf" });
    expect(attachmentName("../../.ssh/id_rsa.txt")).toEqual({ name: "id_rsa.txt" });
    expect(attachmentName(".env.json")).toEqual({ name: "env.json" });
    expect(attachmentName("CLAUDE.md")).toEqual({ name: "CLAUDE.md" }); // lands under files/uploads, never the workspace root
    expect(attachmentName("weird [name]{x}.png")).toEqual({ name: "weird -name-x-.png" });
    expect(attachmentName("budget.xlsx")).toMatchObject({ error: expect.stringMatching(/PDF or CSV/) });
    expect(attachmentName("run.sh")).toMatchObject({ error: expect.any(String) });
  });

  it("saves into files/uploads/<date>/ without overwriting, and refuses Claude config names", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-attach-"));
    const a = await saveAttachment(ws, "notes.md", Buffer.from("# hi"), now);
    const b = await saveAttachment(ws, "notes.md", Buffer.from("# again"), now);
    expect(a).toMatchObject({ path: "files/uploads/2026-11-07/notes.md", name: "notes.md", size: 4, kind: "text" });
    expect(b).toMatchObject({ path: "files/uploads/2026-11-07/notes (2).md" });
    expect(fs.readFileSync(path.join(ws, "files/uploads/2026-11-07/notes.md"), "utf8")).toBe("# hi");
    // A file literally named CLAUDE.md is a Claude instructions file: never written.
    expect(await saveAttachment(ws, "CLAUDE.md", Buffer.from("x"), now)).toMatchObject({ error: expect.any(String) });
    expect(await saveAttachment(ws, "big.txt", Buffer.alloc(21 * 1024 * 1024), now)).toMatchObject({ error: expect.stringMatching(/20 MB/) });
  });

  it("only lets a message name real uploads", async () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-attach-"));
    const a = await saveAttachment(ws, "photo.png", Buffer.from([0x89, 0x50]), now);
    if ("error" in a) throw new Error(a.error);
    fs.writeFileSync(path.join(ws, "Memory.md"), "secret");
    expect(await validateAttachments(ws, [a.path, a.path])).toEqual([a.path]);
    expect(await validateAttachments(ws, undefined)).toEqual([]);
    expect(await validateAttachments(ws, ["Memory.md"])).toMatchObject({ error: expect.any(String) });
    expect(await validateAttachments(ws, ["files/uploads/../../Memory.md"])).toMatchObject({ error: expect.any(String) });
    expect(await validateAttachments(ws, ["/etc/hosts"])).toMatchObject({ error: expect.any(String) });
    expect(await validateAttachments(ws, ["files/uploads/2026-11-07/gone.png"])).toMatchObject({ error: expect.stringMatching(/no longer there/) });
    expect(await validateAttachments(ws, Array(7).fill(a.path))).toMatchObject({ error: expect.stringMatching(/at most 6/) });
  });

  it("round-trips the marker lines, and the gate lets Claude read the upload", () => {
    const files = ["files/uploads/2026-11-07/report.pdf", "files/uploads/2026-11-07/chart (2).png"];
    const msg = withAttachments("What stands out here?", files);
    expect(msg).toBe("What stands out here?\n\n[Attached file: files/uploads/2026-11-07/report.pdf]\n[Attached file: files/uploads/2026-11-07/chart (2).png]");
    expect(splitAttachments(msg)).toEqual({ text: "What stands out here?", files });
    expect(withAttachments("  ", files.slice(0, 1))).toMatch(/^See the attached file\./);
    // A marker typed mid-message isn't an attachment; only the trailing block is.
    expect(splitAttachments("see [Attached file: files/uploads/x.png] ok")).toEqual({ text: "see [Attached file: files/uploads/x.png] ok", files: [] });
    expect(splitAttachments("plain")).toEqual({ text: "plain", files: [] });
    expect(panelPathFor(files[0], "/drive/00 Tethr/tethr", "/drive/00 Tethr")).toBe("tethr/files/uploads/2026-11-07/report.pdf");
    expect(panelPathFor(files[0], "/instance/ws", null)).toBeNull();
    const read = classify("Read", { file_path: files[0] }, {
      workspaceDir: "/drive/00 Tethr/tethr",
      readableRoots: ["/drive/00 Tethr"],
      internalAddresses: [],
      cwd: "/drive/00 Tethr/tethr",
    });
    expect(read.cls).toBe("builtin");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr chat attachments — routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let ws!: string;
  const appFor = async (actor: Record<string, unknown>) => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    app.use("/api", tethrRoutes(db));
    return app;
  };
  const board = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-attach-route-"));
    ws = path.join(dir, "workspace");
    process.env.TETHR_WORKSPACE_DIR = ws;
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-attach-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("uploads for a person only, and lists a message's files apart from its words", async () => {
    const app = await appFor(board);
    const up = await request(app)
      .post(`/api/tethr/${companyId}/chats/attachments`)
      .attach("file", Buffer.from("keyword,volume\nmalaria pills,880\n"), "kw.csv")
      .expect(200);
    expect(up.body).toMatchObject({ name: "kw.csv", kind: "text", size: 33 });
    expect(up.body.path).toMatch(/^files\/uploads\/\d{4}-\d{2}-\d{2}\/kw\.csv$/);
    expect(fs.existsSync(path.join(ws, up.body.path))).toBe(true);

    await request(app).post(`/api/tethr/${companyId}/chats/attachments`).attach("file", Buffer.from("x"), "sheet.xlsx").expect(422);

    const agentApp = await appFor({ type: "agent", agentId: "a1", companyId });
    await request(agentApp).post(`/api/tethr/${companyId}/chats/attachments`).attach("file", Buffer.from("x"), "a.txt").expect(403);

    // A send naming a file that isn't an upload is refused before anything runs.
    const threadId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const bad = await request(app).post(`/api/tethr/${companyId}/chats/${threadId}/messages`).send({ text: "hi", attachments: ["Memory.md"] }).expect(400);
    expect(bad.body.error).toMatch(/isn't one of your uploads/);

    await db.insert(tethrRouteRuns).values({
      companyId,
      threadId,
      invocationSource: "chat",
      status: "done",
      hops: [],
      requestText: withAttachments("Rank these", [up.body.path]),
    });
    const runs = await request(app).get(`/api/tethr/${companyId}/chats/${threadId}/runs`).expect(200);
    expect(runs.body[0].requestText).toBe("Rank these");
    expect(runs.body[0].attachments).toEqual([{ path: up.body.path, name: "kw.csv", kind: "text", panelPath: null }]);
  });
});
