import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addMount,
  driveMountRoot,
  fsArchive,
  fsCreateFolder,
  fsMove,
  listFsChildren,
  listMounts,
  removeMount,
  resolveMountRoot,
} from "../tethr/fsdrive.ts";

// The human-modifiable file manager over a rooted synced folder (00 Tethr and
// added folders). Confinement, soft-delete, and the "under your Google Drive"
// mount guard are the load-bearing safety properties.

let driveRoot: string; // stands in for the Google Drive "My Drive"
let mirror: string; // 00 Tethr under it
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["TETHR_MIRROR_DIR", "TETHR_MIRROR_ALLOW_TEST", "TETHR_MOUNTS_FILE"];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  driveRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-drive-"));
  mirror = path.join(driveRoot, "00 Tethr");
  fs.mkdirSync(mirror, { recursive: true });
  process.env.TETHR_MIRROR_DIR = mirror;
  process.env.TETHR_MIRROR_ALLOW_TEST = "1";
  // Isolate the mounts allowlist to a temp file — never touch the real config.
  process.env.TETHR_MOUNTS_FILE = path.join(driveRoot, "mounts.json");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(driveRoot, { recursive: true, force: true });
});

describe("fs file ops (confined to a root)", () => {
  it("creates folders and lists them (folders first, dotfiles skipped)", async () => {
    await fsCreateFolder(mirror, "", "01 Briefs");
    await fsCreateFolder(mirror, "01 Briefs", "Q3");
    fs.writeFileSync(path.join(mirror, "a.md"), "x");
    fs.writeFileSync(path.join(mirror, ".hidden"), "x");

    const top = await listFsChildren(mirror, "");
    expect(top.map((e) => e.name)).toEqual(["01 Briefs", "a.md"]); // folder first, dotfile hidden
    expect(top[0].kind).toBe("folder");
    expect(top[1].kind).toBe("file");

    const inside = await listFsChildren(mirror, "01 Briefs");
    expect(inside.map((e) => e.name)).toEqual(["Q3"]);
  });

  it("moves a file into a folder and renames it", async () => {
    await fsCreateFolder(mirror, "", "01 Briefs");
    fs.writeFileSync(path.join(mirror, "note.md"), "x");
    const moved = await fsMove(mirror, "note.md", "01 Briefs");
    expect(moved).toBe("01 Briefs/note.md");
    expect(fs.existsSync(path.join(mirror, "01 Briefs", "note.md"))).toBe(true);
    // rename in place (toDir "", newName)
    const renamed = await fsMove(mirror, "01 Briefs/note.md", "01 Briefs", "final.md");
    expect(renamed).toBe("01 Briefs/final.md");
  });

  it("suffixes on a name collision instead of clobbering", async () => {
    fs.writeFileSync(path.join(mirror, "a.md"), "one");
    await fsCreateFolder(mirror, "", "Dest");
    fs.writeFileSync(path.join(mirror, "Dest", "a.md"), "existing");
    const moved = await fsMove(mirror, "a.md", "Dest");
    expect(moved).toBe("Dest/a (2).md");
    expect(fs.readFileSync(path.join(mirror, "Dest", "a.md"), "utf8")).toBe("existing"); // untouched
  });

  it("refuses to move a folder into its own subtree", async () => {
    await fsCreateFolder(mirror, "", "Parent");
    await fsCreateFolder(mirror, "Parent", "Child");
    await expect(fsMove(mirror, "Parent", "Parent/Child")).rejects.toThrow(/into itself/);
  });

  it("archive = soft move into 99 Archive (never a hard delete)", async () => {
    fs.writeFileSync(path.join(mirror, "old.md"), "x");
    const archived = await fsArchive(mirror, "old.md");
    expect(archived).toBe("99 Archive/old.md");
    expect(fs.existsSync(path.join(mirror, "99 Archive", "old.md"))).toBe(true);
    expect(fs.existsSync(path.join(mirror, "old.md"))).toBe(false);
  });

  it("cannot escape the root via traversal in any op", async () => {
    // A sentinel OUTSIDE the root must never be touched.
    const outside = path.join(driveRoot, "SECRET.txt");
    fs.writeFileSync(outside, "secret");
    // normalizeRel strips ".." so this lands inside the root, not at driveRoot.
    const created = await fsCreateFolder(mirror, "../../..", "evil");
    expect(path.resolve(mirror, created).startsWith(path.resolve(mirror))).toBe(true);
    expect(fs.existsSync(outside)).toBe(true); // untouched
    expect(fs.readFileSync(outside, "utf8")).toBe("secret");
  });
});

describe("the 'other folders' allowlist", () => {
  const CID = "11111111-1111-1111-1111-111111111111";

  it("driveMountRoot is the parent of 00 Tethr", () => {
    expect(driveMountRoot()).toBe(path.resolve(driveRoot));
  });

  it("adds a folder under the Drive mount and resolves it", async () => {
    const marketing = path.join(driveRoot, "05 Marketing");
    fs.mkdirSync(marketing);
    const res = await addMount(CID, { path: marketing });
    expect(res.ok).toBe(true);
    expect(res.mount?.label).toBe("05 Marketing");
    const mounts = await listMounts(CID);
    expect(mounts).toHaveLength(1);
    expect(await resolveMountRoot(CID, `ext:${res.mount!.id}`)).toBe(path.resolve(marketing));
    expect(await resolveMountRoot(CID, "mirror")).toBe(path.resolve(mirror));
  });

  it("rejects a folder OUTSIDE the Google Drive mount", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "not-drive-"));
    try {
      const res = await addMount(CID, { path: elsewhere });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/inside your Google Drive/);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("rejects a non-existent path, 00 Tethr itself, and duplicates", async () => {
    expect((await addMount(CID, { path: path.join(driveRoot, "nope") })).ok).toBe(false);
    const tethrDup = await addMount(CID, { path: mirror });
    expect(tethrDup.ok).toBe(false);
    expect(tethrDup.error).toMatch(/00 Tethr/);

    const m = path.join(driveRoot, "10 Partnerships");
    fs.mkdirSync(m);
    expect((await addMount(CID, { path: m })).ok).toBe(true);
    expect((await addMount(CID, { path: m })).ok).toBe(false); // duplicate
  });

  it("removes a mount", async () => {
    const m = path.join(driveRoot, "Ops");
    fs.mkdirSync(m);
    const added = await addMount(CID, { path: m });
    expect(await removeMount(CID, added.mount!.id)).toBe(true);
    expect(await listMounts(CID)).toHaveLength(0);
    expect(await removeMount(CID, "missing")).toBe(false);
  });
});
