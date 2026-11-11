import { describe, expect, it } from "vitest";
import type { TethrStudy } from "@/api/tethr";
import { areaLabel, outcomeWords, studyLine, studyStep } from "./tethr-study";

const study = (over: Partial<TethrStudy> = {}): TethrStudy => ({
  id: "s1",
  trigger: "asked",
  by: "Mark",
  asked: "small-budget search",
  status: "done",
  depth: "deep",
  topic: "Running Google Search on a small budget",
  why: null,
  area: "paid_ads",
  questions: ["a", "b", "c"],
  baseline: null,
  findings: [
    { claim: "x", detail: "", evidence: "data", strength: "strong", sources: [{ url: "https://a.com", title: "A" }, { url: "https://b.com", title: "B" }], appliesWhen: null, counterpoint: null },
    { claim: "y", detail: "", evidence: "data", strength: "weak", sources: [{ url: "https://a.com", title: "A" }], appliesWhen: null, counterpoint: null },
  ],
  researchSummary: null,
  verdicts: [],
  summary: null,
  skills: [],
  reason: null,
  cardRunId: null,
  mainCardRunId: null,
  startedAt: "2026-11-10T20:00:00.000Z",
  finishedAt: null,
  ...over,
});

const skill = (over: Partial<TethrStudy["skills"][number]>): TethrStudy["skills"][number] => ({
  name: "s",
  description: "d",
  area: "paid_ads",
  change: "new",
  whatChanged: "",
  body: "",
  status: "applied",
  at: "",
  ...over,
});

describe("a study's words", () => {
  it("follows Looking → Researching → Comparing → Done", () => {
    expect(studyStep("queued")).toBe(-1);
    expect(studyStep("planning")).toBe(0);
    expect(studyStep("researching")).toBe(1);
    expect(studyStep("applying")).toBe(2);
    expect(studyStep("done")).toBe(3);
  });

  it("says what it's doing, and how it ended", () => {
    expect(studyLine(study({ status: "planning", trigger: "observed" }))).toContain("pick what to learn");
    expect(studyLine(study({ status: "researching" }))).toBe("Researching 3 questions on the web, in depth.");
    expect(studyLine(study({ status: "applying" }))).toContain("Comparing 2 findings");
    expect(studyLine(study({ status: "nothing", reason: "Nothing new." }))).toBe("Nothing worth studying this time: Nothing new.");
    expect(studyLine(study({ status: "failed", reason: "Timed out." }))).toBe("Didn't finish: Timed out.");
  });

  it("sums up what it saved and what it read", () => {
    expect(outcomeWords(study({ skills: [skill({ name: "a" }), skill({ name: "b", change: "updated" }), skill({ name: "c", status: "pending" })] }))).toBe(
      "1 new skill, 1 updated, 1 waiting for your OK · 2 findings from 2 sources",
    );
    expect(outcomeWords(study({ findings: [] }))).toBe("No skill saved");
    expect(areaLabel("paid_ads")).toBe("Paid ads");
    // A review of the skills: no research, and rewrites read as such.
    expect(studyLine(study({ kind: "review", status: "applying", findings: [] }))).toContain("does it hold as the company grows");
    expect(outcomeWords(study({ kind: "review", findings: [], skills: [skill({ change: "updated" })] }))).toBe("1 rewritten");
    expect(outcomeWords(study({ kind: "review", findings: [] }))).toBe("Every skill holds up");
    expect(areaLabel(null)).toBe("General");
  });
});
