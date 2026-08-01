import { describe, it, expect, beforeEach } from "vitest";
import { shouldAlert, __resetAlertThrottle } from "../tethr/observability.js";

describe("shouldAlert throttle (Phase 9 self-observability)", () => {
  beforeEach(() => __resetAlertThrottle());

  it("allows the first alert then throttles repeats within the hour", () => {
    const t0 = 1_000_000;
    expect(shouldAlert("heartbeat:@sonar", t0)).toBe(true);
    expect(shouldAlert("heartbeat:@sonar", t0 + 60_000)).toBe(false); // 1 min later
    expect(shouldAlert("heartbeat:@sonar", t0 + 60 * 60 * 1000 + 1)).toBe(true); // >1h later
  });

  it("throttles each error class independently", () => {
    const t = 5_000_000;
    expect(shouldAlert("class-a", t)).toBe(true);
    expect(shouldAlert("class-b", t)).toBe(true);
    expect(shouldAlert("class-a", t + 1000)).toBe(false);
    expect(shouldAlert("class-b", t + 1000)).toBe(false);
  });
});
