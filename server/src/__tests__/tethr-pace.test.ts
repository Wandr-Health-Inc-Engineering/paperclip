import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyOutcome,
  canSpend,
  cooldownFactor,
  describeAllowance,
  getPace,
  IDEAS_LEVELS,
  initialPace,
  refill,
  refund,
  spend,
  updatePace,
  withinHours,
} from "../tethr/pace.ts";

// Phase 21: how often tethr offers ideas on its own.

const normal = { level: "normal" as const, adaptive: true };
const at = (iso: string) => new Date(iso);

describe("tethr pace — the bank and the allowance", () => {
  it("starts with one idea to spend and refills by the allowance over time", () => {
    const s0 = initialPace("normal", at("2026-11-09T12:00:00Z"));
    expect(canSpend(s0)).toBe(true);
    const s1 = spend(s0);
    expect(canSpend(s1)).toBe(false);
    expect(canSpend(refill(s1, normal, at("2026-11-09T18:00:00Z")))).toBe(false); // a quarter day later
    expect(canSpend(refill(s1, normal, at("2026-11-10T12:00:00Z")))).toBe(true); // a day later
    // No hoarding: a week away still only banks a day's worth.
    expect(refill(s1, normal, at("2026-11-16T12:00:00Z")).bank).toBe(1);
    expect(refund(s1).bank).toBe(1);
  });

  it("ideas that land earn more, ignored ones fewer, inside the level's range", () => {
    let s = initialPace("normal");
    s = applyOutcome(s, normal, "useful");
    expect(s.allowance).toBeCloseTo(1.25);
    for (let i = 0; i < 10; i++) s = applyOutcome(s, normal, "answered");
    expect(s.allowance).toBe(IDEAS_LEVELS.normal.max);
    for (let i = 0; i < 20; i++) s = applyOutcome(s, normal, "ignored");
    expect(s.allowance).toBeCloseTo(IDEAS_LEVELS.normal.min); // slows down, never stops
    expect(cooldownFactor(s)).toBe(2); // ignored in a row: wait longer in a conversation
    s = applyOutcome(s, normal, "not_now");
    expect(s.ignoredStreak).toBe(0);
    expect(s.recent.length).toBe(20);
  });

  it("a fixed pace ignores outcomes, and a new level re-bounds the allowance", () => {
    const fixed = { level: "busy" as const, adaptive: false };
    expect(applyOutcome(initialPace("busy"), fixed, "ignored").allowance).toBe(IDEAS_LEVELS.busy.perDay);
    const fromBusy = { ...initialPace("busy"), allowance: 4 };
    expect(refill(fromBusy, { level: "light", adaptive: true }).allowance).toBe(IDEAS_LEVELS.light.max);
  });

  it("speaks only in working hours, weekdays unless Busy", () => {
    const tz = "America/New_York";
    expect(withinHours(at("2026-11-09T15:00:00Z"), tz, "normal")).toBe(true); // Mon 10am ET
    expect(withinHours(at("2026-11-09T11:00:00Z"), tz, "normal")).toBe(false); // Mon 6am ET
    expect(withinHours(at("2026-11-10T00:30:00Z"), tz, "normal")).toBe(false); // Mon 7:30pm ET
    expect(withinHours(at("2026-11-08T15:00:00Z"), tz, "normal")).toBe(false); // Sunday
    expect(withinHours(at("2026-11-08T15:00:00Z"), tz, "busy")).toBe(true);
  });

  it("describes the pace in words", () => {
    expect(describeAllowance(1)).toBe("about 1 a day");
    expect(describeAllowance(3)).toBe("about 3 a day");
    expect(describeAllowance(3 / 7)).toBe("about 3 a week");
  });
});

describe("tethr pace — the store", () => {
  let dir!: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-pace-"));
    process.env.TETHR_PACE_FILE = path.join(dir, "pace.json");
  });
  afterAll(() => {
    delete process.env.TETHR_PACE_FILE;
  });

  it("keeps each company's pace, safely under concurrent updates", async () => {
    expect(getPace("c1", normal).allowance).toBe(1);
    await Promise.all(Array.from({ length: 5 }, () => updatePace("c1", normal, (s) => applyOutcome(s, normal, "useful"))));
    expect(getPace("c1", normal).allowance).toBe(IDEAS_LEVELS.normal.max);
    expect(getPace("c2", normal).allowance).toBe(1);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "pace.json"), "utf8"));
    expect(Object.keys(saved)).toEqual(["c1"]);
  });
});
