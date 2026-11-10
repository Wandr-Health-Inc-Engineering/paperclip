import { describe, expect, it } from "vitest";
import { autonomySummary, capProblem, spendLine } from "./tethr-autonomy";

const ASK = { spend: { mode: "ask" as const, monthlyCapUsd: null }, outside: "ask" as const, deletes: "ask" as const };

describe("a connector's autonomy, in words", () => {
  it("sums up only the kinds the connector can do", () => {
    expect(autonomySummary(["spend"], ASK)).toBe("Changes run on their own · spending asks");
    expect(autonomySummary(["spend", "outside", "deletes"], { spend: { mode: "auto", monthlyCapUsd: 1500 }, outside: "auto", deletes: "ask" })).toBe(
      "Changes run on their own · spending on its own up to $1,500/mo · outside people on their own · deletes ask",
    );
    expect(autonomySummary([], ASK)).toBe("Changes run on their own");
  });

  it("checks a cap before it's saved", () => {
    expect(capProblem(null)).toBeNull();
    expect(capProblem(500)).toBeNull();
    expect(capProblem(0)).toMatch(/at least \$1/);
    expect(capProblem(Number.NaN)).toMatch(/at least \$1/);
  });

  it("says where spending stands against the cap", () => {
    expect(spendLine({ label: "Google Ads", cap: 1000, planned: { amount: 760, currency: "USD" }, plannedError: null, spentThisMonth: 0, recent: [] })).toBe(
      "Planned now: $760 a month · cap $1,000",
    );
    expect(spendLine({ label: "Shop", cap: null, planned: null, plannedError: null, spentThisMonth: 80, recent: [] })).toBe("Spent through tethr this month: $80 · no cap set");
  });
});
