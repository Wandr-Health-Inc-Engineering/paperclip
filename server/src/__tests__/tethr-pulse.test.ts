import { describe, it, expect } from "vitest";
import {
  detectErrorSpikes,
  detectDeadEvents,
  detectFunnelDrops,
  selectPulseFindings,
  loadPulseConfig,
  type PulseFinding,
} from "../tethr/checks/pulse.js";
import { isDeniedEventName } from "../tethr/tools/posthog.js";

describe("detectErrorSpikes", () => {
  it("fires when today > 3x the baseline and above the noise floor", () => {
    const f = detectErrorSpikes([{ type: "TypeError", today: 30, baselineDaily: 4 }]);
    expect(f).toHaveLength(1);
    expect(f[0].title).toContain("7.5×");
  });
  it("ignores small absolute counts and sub-3x moves", () => {
    expect(detectErrorSpikes([{ type: "A", today: 4, baselineDaily: 0.1 }])).toEqual([]);
    expect(detectErrorSpikes([{ type: "B", today: 10, baselineDaily: 5 }])).toEqual([]);
  });
});

describe("detectDeadEvents", () => {
  it("fires when a critical event drops to zero with a real baseline", () => {
    const f = detectDeadEvents([{ event: "checkout_started", today: 0, baselineDaily: 41 }]);
    expect(f).toHaveLength(1);
    expect(f[0].title).toContain("0 events in 24h");
    expect(f[0].fingerprint).toBe("pulse:dead_event:checkout_started");
  });
  it("does not fire when there is traffic or no baseline", () => {
    expect(detectDeadEvents([{ event: "x", today: 5, baselineDaily: 40 }])).toEqual([]);
    expect(detectDeadEvents([{ event: "y", today: 0, baselineDaily: 0 }])).toEqual([]);
  });
});

describe("detectFunnelDrops", () => {
  it("fires on a >30% day-over-day conversion drop with enough volume", () => {
    const f = detectFunnelDrops([
      { step1: "view", step2: "book", todayStep1: 200, todayRate: 0.2, priorRate: 0.5 },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].title).toContain("60%");
  });
  it("ignores small drops and low-volume days", () => {
    expect(detectFunnelDrops([{ step1: "a", step2: "b", todayStep1: 200, todayRate: 0.45, priorRate: 0.5 }])).toEqual([]);
    expect(detectFunnelDrops([{ step1: "a", step2: "b", todayStep1: 5, todayRate: 0.1, priorRate: 0.5 }])).toEqual([]);
  });
});

describe("PHI denylist + config", () => {
  it("denies clinical-looking event names", () => {
    expect(isDeniedEventName("patient_diagnosis_viewed")).toBe(true);
    expect(isDeniedEventName("medication_selected")).toBe(true);
    expect(isDeniedEventName("checkout_started")).toBe(false);
  });
  it("stays not-ready while placeholders remain", () => {
    const c = loadPulseConfig({ criticalEvents: ["FILL_ME_x"], funnels: [] });
    expect(c.ready).toBe(false);
  });
  it("drops denylisted events and reports them", () => {
    const c = loadPulseConfig({
      criticalEvents: ["checkout_started", "patient_record_opened"],
      funnels: [{ step1: "pageview", step2: "consult_booked" }],
    });
    expect(c.ready).toBe(true);
    expect(c.config.criticalEvents).toEqual(["checkout_started"]);
    expect(c.rejected).toContain("patient_record_opened");
  });
});

describe("selectPulseFindings", () => {
  const findings: PulseFinding[] = [
    { ruleType: "dead_event", severity: "high", title: "h", why: "", fingerprint: "a" },
    { ruleType: "funnel_drop", severity: "medium", title: "m", why: "", fingerprint: "b" },
    { ruleType: "error_spike", severity: "high", title: "h2", why: "", fingerprint: "c" },
  ];
  it("dedupes seen fingerprints, ranks by severity, caps the batch", () => {
    const out = selectPulseFindings(findings, new Set(["a"]), 2);
    expect(out.map((f) => f.fingerprint)).toEqual(["c", "b"]);
  });
});
