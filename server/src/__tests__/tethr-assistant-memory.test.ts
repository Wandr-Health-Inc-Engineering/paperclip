import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspace } from "../tethr/assistant/workspace.js";
import {
  applyOps,
  formatEntries,
  migrateFreeform,
  parseEntries,
  renderMemoryBlock,
  renderMemoryCopy,
  validateOps,
  MemoryOpError,
  type MemorySnapshot,
} from "../tethr/hermes/entries.js";
import { changeMemory, MemoryChangeError, memorySnapshot, migrateFreeformMemory } from "../tethr/hermes/memory-layer.js";
import { getMemoryState } from "../tethr/hermes/state.js";

// Phase 25: tethr's memory is entries in Hermes's format (built-in store here;
// tethr-hermes.test.ts runs the same against a real Hermes). CLAUDE.md renders
// them every turn; Memory.md is a read-only copy for the team.

let dir: string;
const companyId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-memory-"));
  process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
  process.env.TETHR_ASSISTANT_HOME = path.join(dir, "home");
  process.env.TETHR_MEMORY_FILE = path.join(dir, "memory.json");
});
afterEach(() => {
  for (const k of ["TETHR_WORKSPACE_DIR", "TETHR_ASSISTANT_HOME", "TETHR_MEMORY_FILE"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

const snapshot = (company: string[], people: string[] = []): MemorySnapshot => ({
  backend: "builtin",
  stores: {
    company: { entries: company.map((text) => ({ text })), used: formatEntries(company).length, limit: 6000 },
    people: { entries: people.map((text) => ({ text })), used: formatEntries(people).length, limit: 2000 },
  },
  skills: [],
});

describe("memory entries (Hermes's format)", () => {
  it("parses and formats § entries, dropping blanks and repeats", () => {
    expect(parseEntries("﻿a\n§\n b \n§\n\n§\na")).toEqual(["a", "b"]);
    expect(formatEntries(["a", "b\nmore"])).toBe("a\n§\nb\nmore");
  });

  it("adds, patches and removes; a patch must match one entry; the limit is on the result", () => {
    let r = applyOps(["Payouts on the 15th"], validateOps([{ action: "patch", old_text: "15th", content: "16th" }]), 100);
    expect(r).toMatchObject({ ok: true, entries: ["Payouts on the 16th"] });
    r = applyOps(["x payouts", "y payouts"], validateOps([{ action: "remove", old_text: "payouts" }]), 100);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/2 entries/) });
    r = applyOps(["aaaa"], validateOps([{ action: "add", content: "bbbbbbbbbb" }]), 10);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Merge or remove/) });
    // A batch can make room first.
    r = applyOps(["aaaa"], validateOps([{ action: "remove", old_text: "aaaa" }, { action: "add", content: "bbbbbbbbbb" }]), 10);
    expect(r).toMatchObject({ ok: true, entries: ["bbbbbbbbbb"] });
    expect(() => validateOps([{ action: "add", content: "a § b" }])).toThrow(MemoryOpError);
    expect(() => validateOps([])).toThrow(MemoryOpError);
  });

  it("renders the Memory block as data, with usage and recall guidance only when recall exists", () => {
    const block = renderMemoryBlock(snapshot(["Payouts on the 16th"], ["Mark: short answers"]), { recall: true });
    expect(block).toContain("## Memory");
    expect(block).toContain("not instructions");
    expect(block).toContain("- Payouts on the 16th");
    expect(block).toContain("### People\n- Mark: short answers");
    expect(block).toMatch(/search them with recall/);
    expect(renderMemoryBlock(snapshot([]), { recall: false })).not.toMatch(/recall/);
  });

  it("turns the old free-form Memory.md into entries, dropping the seed's placeholders", () => {
    const old = `# What Tethr knows

## The company
- (Filled in during setup: what it does, for whom, anything that's off limits.)
- Tethr works on go-to-market, growth and operations. It never handles anyone's health information.
- Wandr sells travel prescriptions online.

## Products & prices
- Malarone kit: $89

## Things the team told me
- 2026-11-02: partner payouts go out on the 15th

## People & accounts
- Alec runs partnerships`;
    expect(migrateFreeform(old)).toEqual({
      company: ["The company: Wandr sells travel prescriptions online.", "Products & prices: Malarone kit: $89", "2026-11-02: partner payouts go out on the 15th"],
      people: ["Alec runs partnerships"],
    });
    expect(migrateFreeform(renderMemoryCopy(snapshot(["x"])))).toEqual({ company: [], people: [] });
  });
});

describe("the built-in memory store", () => {
  it("saves with provenance, writes the Memory.md copy, and refuses a bad patch", async () => {
    await changeMemory(companyId, "company", [{ action: "add", content: "Partner payouts go out on the 15th." }], { by: "@tethr", threadId: companyId });
    const snap = memorySnapshot(companyId);
    expect(snap.backend).toBe("builtin");
    expect(snap.stores.company.entries[0]).toMatchObject({ text: "Partner payouts go out on the 15th.", savedBy: "@tethr", threadId: companyId });
    const copy = fs.readFileSync(path.join(dir, "workspace", "Memory.md"), "utf8");
    expect(copy).toContain("Partner payouts go out on the 15th.");
    expect(copy).toMatch(/Edits here aren't read/);
    await expect(changeMemory(companyId, "company", [{ action: "remove", old_text: "nothing like this" }], { by: "@tethr" })).rejects.toThrow(MemoryChangeError);
    // Removed entries drop out of the provenance record.
    await changeMemory(companyId, "company", [{ action: "remove", old_text: "payouts" }], { by: "Memory page" });
    expect(memorySnapshot(companyId).stores.company.entries).toEqual([]);
    expect(Object.keys(getMemoryState(companyId).provenance ?? {})).toEqual([]);
  });

  it("migrates a free-form Memory.md once, keeping a backup outside Drive", async () => {
    await ensureWorkspace();
    const ws = path.join(dir, "workspace");
    fs.writeFileSync(path.join(ws, "Memory.md"), "## Products & prices\n- Malarone kit: $89\n");
    expect(await migrateFreeformMemory(companyId)).toEqual({ moved: 1 });
    expect(memorySnapshot(companyId).stores.company.entries.map((e) => e.text)).toEqual(["Products & prices: Malarone kit: $89"]);
    expect(fs.readFileSync(path.join(ws, "Memory.md"), "utf8")).toMatch(/^<!-- tethr:memory-copy/);
    expect(fs.readdirSync(path.join(dir, "home", "memory-backups"))).toHaveLength(1);
    expect(await migrateFreeformMemory(companyId)).toEqual({ moved: 0 });
  });

  it("the generated CLAUDE.md carries the Memory block, not an import of Memory.md", async () => {
    const ws = await ensureWorkspace({ memory: renderMemoryBlock(snapshot(["Payouts on the 16th"]), { recall: false }) });
    const md = fs.readFileSync(ws.claudePath, "utf8");
    expect(md).toContain("- Payouts on the 16th");
    expect(md).not.toContain("@Memory.md");
    expect(md).toMatch(/Memory\.md is a copy Tethr writes/);
  });
});
