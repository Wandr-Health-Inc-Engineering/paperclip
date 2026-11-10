import { describe, expect, it } from "vitest";
import { cardDetails, cardHeading, decidedLine } from "./tethr-cards";

const AGENT_BODY = `Paid Ads (@paid-ads): Paid acquisition lead
Mission: Owns paid search for new customers.
Goal (new): Paid acquisition. New customers from ads: 0 now, 40 by Mar 31, 2027
Runs: every Monday at 9:00 AM (America/Los_Angeles), and when tethr assigns it work
Limits: up to 3 runs a day, $25 a month (hard stop)
Tools: web search and its files, plus Stripe, Tethr tools. Anything it would send, post, spend or delete still asks first.
Reports to: Mark (growth) on Slack, and to the main chat
Lead: it can build and run a small sub-team of its own (up to 4 agents); each one is a card like this.

Each scheduled run:
Check spend against new customers.

First task: Audit current state
Look for any ads already running.
Then draft the first campaign.

Instructions:
Use keyword_ideas for volumes.

Why: Paid search is the biggest gap.`;

describe("what a waiting card says", () => {
  it("names what it wants in plain words, and why it always asks", () => {
    expect(cardHeading({ kind: "team_agent", status: "gated", sensitivity: "org" })).toBe("Needs your approval: new agent");
    expect(cardHeading({ kind: "team_change", status: "gated", sensitivity: "spend" })).toBe("Needs your approval: change to an agent · spends money");
    expect(cardHeading({ kind: "external_action", status: "gated", sensitivity: "public", meta: { connector: "Gmail" } })).toBe(
      "Needs your approval: Gmail action · goes outside the company",
    );
    expect(cardHeading({ kind: "external_action", status: "gated", sensitivity: "external", meta: { connector: "Slack" } })).toBe("Needs your approval: Slack action");
    expect(cardHeading({ kind: "drive_change", status: "changes_requested", sensitivity: "destructive" })).toBe("Changes requested: delete files · deletes or overwrites");
  });

  it("says what happened once it's decided", () => {
    expect(decidedLine({ kind: "team_agent", status: "gated" })).toBeNull();
    expect(decidedLine({ kind: "team_agent", status: "published" })).toEqual({ tone: "ok", label: "Approved: it's on the team" });
    expect(decidedLine({ kind: "team_change", status: "published" })).toEqual({ tone: "ok", label: "Approved" });
    expect(decidedLine({ kind: "team_agent", status: "rejected" })).toEqual({ tone: "bad", label: "Rejected" });
    expect(decidedLine({ kind: "team_agent", status: "rejected", meta: { applyError: "that tag is taken" } })).toEqual({
      tone: "bad",
      label: "Couldn't be applied: that tag is taken",
    });
  });
});

describe("an agent card's details", () => {
  it("reads every part of the spec back: the labelled lines, then the longer blocks", () => {
    const details = cardDetails(AGENT_BODY)!;
    expect(details.rows.map(([label]) => label)).toEqual(["Mission", "Goal (new)", "Runs", "Limits", "Tools", "Reports to", "Lead"]);
    expect(details.rows[0]).toEqual(["Mission", "Owns paid search for new customers."]);
    expect(details.rows[2]![1]).toContain("every Monday at 9:00 AM");
    expect(details.blocks).toEqual([
      { heading: "Each scheduled run", text: "Check spend against new customers." },
      { heading: "First task", text: "Audit current state\nLook for any ads already running.\nThen draft the first campaign." },
      { heading: "Instructions", text: "Use keyword_ideas for volumes." },
      { heading: "Why", text: "Paid search is the biggest gap." },
    ]);
  });

  it("leaves a body that isn't shaped like a spec to be shown whole", () => {
    expect(cardDetails("# Brief\n\nSome prose about a plan.")).toBeNull();
    expect(cardDetails("")).toBeNull();
  });
});

describe("an agent's report, the way an assistant would bring it", () => {
  it("leads with the report's first sentence, as plain words", async () => {
    const { reportLead, reportHasMore } = await import("./tethr-cards");
    const body = "**Shortlisted 6 topics** with real demand; [two](files/x.md) need your OK. Then the details:\n\n- one\n- two";
    expect(reportLead(body)).toBe("Shortlisted 6 topics with real demand; two need your OK.");
    expect(reportHasMore(body)).toBe(true);
    expect(reportHasMore("Done.")).toBe(false);
    expect(reportLead("")).toBe("");
    const long = `${"word ".repeat(80)}end.`;
    expect(reportLead(long).length).toBeLessThanOrEqual(221);
    expect(reportLead(long).endsWith("…")).toBe(true);
  });

  it("puts reports that land one after another together, and leaves everything else alone", async () => {
    const { groupReports } = await import("./tethr-cards");
    const r = (id: string, sourceKey: string | null) => ({ id, sourceKey });
    const segments = groupReports([r("a", null), r("b", "tethr-agent-report"), r("c", "tethr-agent-report"), r("d", null), r("e", "tethr-agent-report")]);
    expect(segments.map((s) => (s.kind === "one" ? s.run.id : s.runs.map((x) => x.id).join("+")))).toEqual(["a", "b+c", "d", "e"]);
  });

  it("says plainly what a file cleanup card wants, and what happened", async () => {
    const { cardHeading, decidedLine } = await import("./tethr-cards");
    expect(cardHeading({ kind: "drive_change", status: "gated", sensitivity: "destructive" })).toBe("Needs your approval: delete files · deletes or overwrites");
    expect(decidedLine({ kind: "drive_change", status: "published" })).toEqual({ tone: "ok", label: "Deleted: moved to the archive" });
  });
});
