import { describe, it, expect } from "vitest";
import { toolsetForSubagent } from "../tethr/tools/index.js";
import { priceUsd, rateForModel } from "../tethr/llm/pricing.js";

// Phase 3 safety envelope. Before flipping Sonar to the live Claude provider we
// assert — as a regression-protected invariant, not a hope — that a Sonar run
// cannot write outside the Tethr Drive or publish anywhere external. The only
// external vector is the `notify` tool (Slack), which is itself gated by
// SLACK_BOT_TOKEN at runtime and only granted to one Sonar subagent.

const SONAR_TAGS = ["@sonar.leads", "@sonar.reply", "@sonar.news"];
// Tools that write state or reach outside the Drive.
const WRITE_TOOLS = ["drive_write", "advance_tracker"];
const EXTERNAL_TOOLS = ["notify"];

describe("Sonar live-run safety (tool allowlist)", () => {
  it("gives no Sonar subagent a filesystem/Drive/tracker write tool", () => {
    for (const tag of SONAR_TAGS) {
      const names = toolsetForSubagent({ tag }).map((t) => t.name);
      for (const w of WRITE_TOOLS) {
        expect(names, `${tag} must not have ${w}`).not.toContain(w);
      }
    }
  });

  it("grants the sole external vector (notify) to @sonar.leads only", () => {
    const withNotify = SONAR_TAGS.filter((tag) =>
      toolsetForSubagent({ tag })
        .map((t) => t.name)
        .some((n) => EXTERNAL_TOOLS.includes(n)),
    );
    expect(withNotify).toEqual(["@sonar.leads"]);
  });

  it("otherwise limits Sonar to read/fetch tools", () => {
    expect(toolsetForSubagent({ tag: "@sonar.reply" }).map((t) => t.name)).toEqual([
      "drive_list",
      "drive_read",
      "recall_memory",
      "reddit_scan",
    ]);
    expect(toolsetForSubagent({ tag: "@sonar.news" }).map((t) => t.name)).toEqual([
      "drive_list",
      "drive_read",
      "recall_memory",
      "cdc_scan",
      "web_fetch",
    ]);
  });
});

describe("live-run pricing (budget hard-stop depends on this)", () => {
  it("prices Sonnet usage at $3/$15 per MTok", () => {
    expect(priceUsd("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6);
    expect(priceUsd("claude-sonnet-4-6", { inputTokens: 200_000, outputTokens: 50_000 })).toBeCloseTo(1.35, 6);
  });

  it("never returns a negative cost", () => {
    expect(priceUsd("claude-sonnet-4-6", { inputTokens: -5, outputTokens: -5 })).toBe(0);
  });

  it("falls back to a Sonnet-class rate for an unknown model (never silent $0)", () => {
    expect(rateForModel("some-future-model")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("tolerates a dated snapshot suffix", () => {
    expect(rateForModel("claude-opus-4-8-20251114")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it("honors an env price override", () => {
    const savedIn = process.env.TETHR_PRICE_INPUT_PER_MTOK;
    const savedOut = process.env.TETHR_PRICE_OUTPUT_PER_MTOK;
    process.env.TETHR_PRICE_INPUT_PER_MTOK = "10";
    process.env.TETHR_PRICE_OUTPUT_PER_MTOK = "20";
    try {
      expect(rateForModel("claude-sonnet-4-6")).toEqual({ inputPerMTok: 10, outputPerMTok: 20 });
    } finally {
      if (savedIn === undefined) delete process.env.TETHR_PRICE_INPUT_PER_MTOK;
      else process.env.TETHR_PRICE_INPUT_PER_MTOK = savedIn;
      if (savedOut === undefined) delete process.env.TETHR_PRICE_OUTPUT_PER_MTOK;
      else process.env.TETHR_PRICE_OUTPUT_PER_MTOK = savedOut;
    }
  });
});
