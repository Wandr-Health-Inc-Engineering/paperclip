import { describe, expect, it } from "vitest";
import { ADJUST, expectedAt, proposeAdjustment, realisticTarget, trend, type PaceMetric } from "../tethr/goal-pace.ts";

// Phase 21: targets that stay realistic on their own.

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n, 12)).toISOString();
const DAY = 86_400_000;

function metric(over: Partial<PaceMetric> = {}): PaceMetric {
  return {
    name: "New customers per month",
    unit: "count",
    direction: "up",
    baseline: 100,
    baselineAt: new Date(day(0)),
    target: 200,
    targetDate: new Date(day(100)),
    history: [],
    adjustments: [],
    ...over,
  };
}

describe("tethr goal pace — the math", () => {
  it("fits a straight trend and the start-to-target line", () => {
    const t = trend([{ at: day(0), value: 100 }, { at: day(10), value: 110 }, { at: day(20), value: 120 }])!;
    expect(t.perDay).toBeCloseTo(1);
    expect(t.at(Date.parse(day(100)))).toBeCloseTo(200);
    expect(trend([{ at: day(0), value: 1 }])).toBeNull();
    expect(expectedAt(metric(), Date.parse(day(50)))).toBeCloseTo(150);
    expect(expectedAt(metric({ targetDate: null }), Date.parse(day(50)))).toBeNull();
  });

  it("a realistic target is the trend at the date plus the pace, never below where it started", () => {
    const slow = metric({ history: [{ at: day(10), value: 104 }, { at: day(20), value: 108 }, { at: day(30), value: 112 }] });
    // Trend: +0.4/day → 140 by day 100.
    expect(realisticTarget(slow, "steady")!.value).toBeCloseTo(140 * 1.05, 5);
    expect(realisticTarget(slow, "balanced")!.value).toBeCloseTo(140 * 1.15, 5);
    expect(realisticTarget(slow, "ambitious")!.value).toBeCloseTo(140 * 1.3, 5);
    const falling = metric({ history: [{ at: day(10), value: 99 }, { at: day(20), value: 96 }, { at: day(30), value: 92 }] });
    expect(realisticTarget(falling, "steady")!.value).toBeCloseTo(100 * 1.05, 5); // never aims below the start
  });
});

describe("tethr goal pace — when targets move", () => {
  const behind = metric({ history: [{ at: day(10), value: 104 }, { at: day(20), value: 108 }, { at: day(30), value: 112 }] });

  it("eases a target that's out of reach, halfway, within the step limit", () => {
    const change = proposeAdjustment(behind, "balanced", Date.parse(day(31)))!;
    expect(change.kind).toBe("eased");
    // Realistic = 140 × 1.15 = 161; halfway from 200 → 181 (inside the 25% step).
    expect(change.to).toBe(181);
    expect(change.why).toMatch(/trend points to about 140 by Apr 11, and the last two measurements were behind pace/);
  });

  it("raises a target that's being beaten, never more than a quarter at once", () => {
    const fast = metric({ history: [{ at: day(10), value: 140 }, { at: day(20), value: 180 }, { at: day(30), value: 220 }] });
    const change = proposeAdjustment(fast, "ambitious", Date.parse(day(31)))!;
    expect(change.kind).toBe("raised");
    expect(change.to).toBe(250); // capped: 200 + 25%
  });

  it("leaves a target alone when it's roughly right, or the signal isn't clear yet", () => {
    const fine = metric({ history: [{ at: day(10), value: 109 }, { at: day(20), value: 119 }, { at: day(30), value: 131 }] });
    expect(proposeAdjustment(fine, "steady", Date.parse(day(31)))).toBeNull();
    // Only two measurements.
    expect(proposeAdjustment(metric({ history: behind.history.slice(0, 2) }), "balanced", Date.parse(day(31)))).toBeNull();
    // Last two disagree (one behind, one ahead).
    const mixed = metric({ history: [{ at: day(10), value: 104 }, { at: day(20), value: 108 }, { at: day(30), value: 140 }] });
    expect(proposeAdjustment(mixed, "balanced", Date.parse(day(31)))).toBeNull();
    // No target date or start.
    expect(proposeAdjustment(metric({ ...behind, targetDate: null }), "balanced", Date.parse(day(31)))).toBeNull();
    expect(proposeAdjustment(metric({ ...behind, baseline: null }), "balanced", Date.parse(day(31)))).toBeNull();
  });

  it("waits two weeks between changes, and leaves the final week alone", () => {
    const recent = metric({ ...behind, adjustments: [{ at: day(25), from: 220, to: 200, why: "x" }] });
    expect(proposeAdjustment(recent, "balanced", Date.parse(day(31)))).toBeNull();
    expect(proposeAdjustment(recent, "balanced", Date.parse(day(25)) + ADJUST.cooldownDays * DAY + 1)).not.toBeNull();
    expect(proposeAdjustment(behind, "balanced", Date.parse(day(95)))).toBeNull();
  });

  it("works the other way round for lower-is-better metrics, never easing past where it started", () => {
    const cost = metric({
      name: "Cost per customer",
      unit: "usd",
      direction: "down",
      baseline: 80,
      target: 40,
      history: [{ at: day(10), value: 79 }, { at: day(20), value: 78 }, { at: day(30), value: 77 }],
    });
    const change = proposeAdjustment(cost, "balanced", Date.parse(day(31)))!;
    expect(change.kind).toBe("eased");
    expect(change.to).toBeGreaterThan(40);
    expect(change.to).toBeLessThanOrEqual(50); // a 25% step at most
    const pct = metric({ unit: "percent", baseline: 90, target: 95, history: [{ at: day(10), value: 99 }, { at: day(20), value: 99.5 }, { at: day(30), value: 99.9 }] });
    const up = proposeAdjustment(pct, "ambitious", Date.parse(day(31)));
    expect(up === null || up.to <= 100).toBe(true); // a percentage never goes past 100
  });
});
