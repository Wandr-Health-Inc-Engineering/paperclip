import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolsetForSubagent } from "../tethr/tools/index.ts";
import { webFetchTool } from "../tethr/tools/web.ts";
import type { TethrToolContext } from "../tethr/tools/types.ts";

// The per-subagent tool grant and the bot-wall handling — the two fixes that
// let a factory-born "research" agent actually research (instead of getting
// baseline-only tools and dead-ending on www.cdc.gov's 403).

const DUMMY_CTX = {} as TethrToolContext;
const names = (sub: { tag: string; tools: string[] | null }) =>
  toolsetForSubagent(sub).map((t) => t.name);

describe("toolsetForSubagent — DB grant vs static allowlist", () => {
  it("an explicit DB grant is authoritative (factory agents)", () => {
    const got = names({ tag: "@radar.scan", tools: ["web_fetch", "reddit_scan"] });
    expect(got).toContain("web_fetch");
    expect(got).toContain("reddit_scan");
    // baseline is always unioned in
    expect(got).toContain("drive_list");
    expect(got).toContain("recall_memory");
    expect(got).toContain("escalate");
  });

  it("a NULL grant falls back to the static allowlist (built-in agents)", () => {
    // @sonar.leads is in the static ALLOWLIST: reddit_scan, web_fetch, notify.
    const got = names({ tag: "@sonar.leads", tools: null });
    expect(got).toContain("reddit_scan");
    expect(got).toContain("web_fetch");
    expect(got).toContain("notify");
  });

  it("a NULL grant with an unknown tag gets baseline only (the old bug's blast radius)", () => {
    const got = names({ tag: "@radar.scan", tools: null });
    expect(got.sort()).toEqual(["drive_list", "drive_read", "escalate", "recall_memory"].sort());
    expect(got).not.toContain("web_fetch");
  });

  it("dedupes baseline ∩ grant and drops unknown/typo'd tool names", () => {
    const got = names({ tag: "@x.y", tools: ["drive_read", "web_fetch", "not_a_real_tool"] });
    expect(got.filter((n) => n === "drive_read")).toHaveLength(1); // no dupe
    expect(got).toContain("web_fetch");
    expect(got).not.toContain("not_a_real_tool"); // filtered to the registry
  });

  it("an empty grant means baseline only — never falls back to the allowlist", () => {
    // A factory agent deliberately proposed with no extra tools ([]), not NULL.
    const got = names({ tag: "@sonar.leads", tools: [] });
    expect(got).not.toContain("reddit_scan"); // the allowlist is NOT consulted
    expect(got).toContain("drive_read");
  });
});

describe("web_fetch — bot-walled hosts and honest failures", () => {
  const prev = process.env.TETHR_LIVE_FETCH;
  beforeEach(() => {
    process.env.TETHR_LIVE_FETCH = "true"; // exercise the live path (no network for walls)
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TETHR_LIVE_FETCH;
    else process.env.TETHR_LIVE_FETCH = prev;
  });

  it("short-circuits www.cdc.gov with a redirect to cdc_scan (no network, no hallucination)", async () => {
    const r = await webFetchTool.execute(DUMMY_CTX, { url: "https://www.cdc.gov/cyclosporiasis/outbreaks/index.html" });
    expect(r.summary).toMatch(/blocked host/);
    expect(r.output).toMatch(/cdc_scan/);
    expect(r.output).toMatch(/403/);
    // The instruction the old code gave — inviting fabrication — must be gone.
    expect(r.output).not.toMatch(/proceed with what you know/i);
  });

  it("rejects a non-absolute url", async () => {
    const r = await webFetchTool.execute(DUMMY_CTX, { url: "/relative/path" });
    expect(r.summary).toBe("invalid url");
  });
});
