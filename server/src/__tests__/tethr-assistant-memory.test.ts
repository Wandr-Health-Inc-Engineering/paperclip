import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspace, readMemoryFile, writeMemoryFile } from "../tethr/assistant/workspace.js";

// Phase 18.5: Memory.md is the chat's long-term memory. Mark edits it on the
// Memory page; a save never clobbers an edit Claude made in the meantime.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-memory-"));
  process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
});
afterEach(() => {
  delete process.env.TETHR_WORKSPACE_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tethr assistant memory file", () => {
  it("seeds Memory.md once and imports it from the generated CLAUDE.md", async () => {
    const ws = await ensureWorkspace();
    const seeded = await readMemoryFile(ws.memoryPath);
    expect(seeded.content).toMatch(/^# What Tethr knows/);
    expect(fs.readFileSync(ws.claudePath, "utf8")).toContain("@Memory.md");
    fs.writeFileSync(ws.memoryPath, "# Mine\n- Q1 goal: 500 paid visits\n");
    await ensureWorkspace();
    expect((await readMemoryFile(ws.memoryPath)).content).toContain("500 paid visits");
  });

  it("saves when based on the current version", async () => {
    const ws = await ensureWorkspace();
    const { mtime } = await readMemoryFile(ws.memoryPath);
    const res = await writeMemoryFile(ws.memoryPath, "# Edited by Mark\n", mtime);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(ws.memoryPath, "utf8")).toBe("# Edited by Mark\n");
    // No temp files left behind in the Drive-synced folder.
    expect(fs.readdirSync(path.dirname(ws.memoryPath)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses a stale save and hands back the newer file", async () => {
    const ws = await ensureWorkspace();
    const opened = await readMemoryFile(ws.memoryPath);
    // Claude edits the file while Mark is typing.
    const later = new Date(opened.mtime + 5_000);
    fs.writeFileSync(ws.memoryPath, "# Claude added a line\n");
    fs.utimesSync(ws.memoryPath, later, later);
    const res = await writeMemoryFile(ws.memoryPath, "# Mark's version\n", opened.mtime);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.conflict.content).toBe("# Claude added a line\n");
    expect(fs.readFileSync(ws.memoryPath, "utf8")).toBe("# Claude added a line\n");
  });

  it("refuses a save that doesn't say which version it was based on", async () => {
    const ws = await ensureWorkspace();
    const res = await writeMemoryFile(ws.memoryPath, "x", Number(undefined));
    expect(res.ok).toBe(false);
  });
});
