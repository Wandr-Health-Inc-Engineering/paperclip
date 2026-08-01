import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { driveService } from "../tethr/drive.ts";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// The file-manager operations layered on the Drive: create-folder, move,
// rename, and archive (soft delete). The delicate part is that moving a folder
// must rewrite the path of every descendant — these lock that.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("tethr drive file manager", () => {
  let db!: ReturnType<typeof createDb>;
  let drive!: ReturnType<typeof driveService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let storageDir!: string;
  let companyId!: string;

  beforeAll(async () => {
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-drive-test-storage-"));
    process.env.PAPERCLIP_STORAGE_PROVIDER = "local_disk";
    process.env.PAPERCLIP_STORAGE_LOCAL_DIR = storageDir;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.TETHR_LIVE_FETCH = "false";

    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-drive-");
    db = createDb(tempDb.connectionString);
    const result = await seedTethrCore(db);
    companyId = result.companyId;
    drive = driveService(db);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  it("creates nested folders", async () => {
    const folder = await drive.createFolder(companyId, null, "sandbox");
    expect(folder.path).toBe("/sandbox");
    expect(folder.kind).toBe("folder");
    const child = await drive.createFolder(companyId, folder.id, "inner");
    expect(child.path).toBe("/sandbox/inner");
    expect(child.parentId).toBe(folder.id);
  });

  it("rejects folder names containing a slash", async () => {
    await expect(drive.createFolder(companyId, null, "a/b")).rejects.toThrow(/invalid/);
  });

  it("moves a file into a folder (path + parent update)", async () => {
    await drive.putFile({ companyId, path: "/loose-note.md", content: "hi" });
    const dest = await drive.createFolder(companyId, null, "notes");
    const file = await drive.findNodeByPath(companyId, "/loose-note.md");
    const moved = await drive.moveNode(companyId, file!.id, { newParentId: dest.id });
    expect(moved!.path).toBe("/notes/loose-note.md");
    expect(moved!.parentId).toBe(dest.id);
    expect(await drive.findNodeByPath(companyId, "/loose-note.md")).toBeNull();
  });

  it("renames in place when only newName is given", async () => {
    await drive.putFile({ companyId, path: "/notes/draft.md", content: "x" });
    const file = await drive.findNodeByPath(companyId, "/notes/draft.md");
    const renamed = await drive.moveNode(companyId, file!.id, { newName: "final.md" });
    expect(renamed!.path).toBe("/notes/final.md");
    expect(renamed!.parentId).toBe(file!.parentId);
  });

  it("rewrites every descendant path when a folder moves", async () => {
    await drive.putFile({ companyId, path: "/proj/a/one.md", content: "1" });
    await drive.putFile({ companyId, path: "/proj/a/deep/two.md", content: "2" });
    const box = await drive.createFolder(companyId, null, "box");
    const projA = await drive.findNodeByPath(companyId, "/proj/a");
    await drive.moveNode(companyId, projA!.id, { newParentId: box!.id });

    expect(await drive.findNodeByPath(companyId, "/box/a")).not.toBeNull();
    expect(await drive.findNodeByPath(companyId, "/box/a/one.md")).not.toBeNull();
    expect(await drive.findNodeByPath(companyId, "/box/a/deep/two.md")).not.toBeNull();
    // Old paths are gone.
    expect(await drive.findNodeByPath(companyId, "/proj/a/one.md")).toBeNull();
    expect(await drive.findNodeByPath(companyId, "/proj/a/deep/two.md")).toBeNull();
  });

  it("can move a node up to the root", async () => {
    await drive.putFile({ companyId, path: "/notes/moveme.md", content: "m" });
    const file = await drive.findNodeByPath(companyId, "/notes/moveme.md");
    const moved = await drive.moveNode(companyId, file!.id, { newParentId: null });
    expect(moved!.path).toBe("/moveme.md");
    expect(moved!.parentId).toBeNull();
  });

  it("refuses a name collision in the destination", async () => {
    await drive.putFile({ companyId, path: "/dup/a.md", content: "a" });
    await drive.putFile({ companyId, path: "/other/a.md", content: "a2" });
    const dupFolder = await drive.findNodeByPath(companyId, "/dup");
    const other = await drive.findNodeByPath(companyId, "/other/a.md");
    await expect(
      drive.moveNode(companyId, other!.id, { newParentId: dupFolder!.id }),
    ).rejects.toThrow(/already exists/);
  });

  it("refuses to move a folder into its own subtree", async () => {
    await drive.createFolder(companyId, null, "parent");
    const parent = await drive.findNodeByPath(companyId, "/parent");
    const sub = await drive.createFolder(companyId, parent!.id, "sub");
    await expect(
      drive.moveNode(companyId, parent!.id, { newParentId: sub!.id }),
    ).rejects.toThrow(/subtree/);
  });

  it("archive is a move to /archive, never a hard delete", async () => {
    await drive.putFile({ companyId, path: "/trash-me.md", content: "bye" });
    const file = await drive.findNodeByPath(companyId, "/trash-me.md");
    const archived = await drive.archiveNode(companyId, file!.id);
    expect(archived!.path).toBe("/archive/trash-me.md");
    // The node still exists — nothing was destroyed.
    expect(await drive.getNode(companyId, file!.id)).not.toBeNull();
  });

  it("de-collides names within /archive", async () => {
    await drive.putFile({ companyId, path: "/x/dupe.md", content: "1" });
    await drive.putFile({ companyId, path: "/y/dupe.md", content: "2" });
    const first = await drive.findNodeByPath(companyId, "/x/dupe.md");
    const second = await drive.findNodeByPath(companyId, "/y/dupe.md");
    await drive.archiveNode(companyId, first!.id);
    const secondArchived = await drive.archiveNode(companyId, second!.id);
    expect(secondArchived!.path).toBe("/archive/dupe.md (2)");
  });
});
