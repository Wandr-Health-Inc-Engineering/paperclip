import { describe, expect, it } from "vitest";
import { switchesContextText, type SwitchesState } from "../tethr/assistant/switches.js";
import { DEFAULT_TEAM } from "../tethr/integrations.js";
import { teamContextText, type TeamAgent } from "../tethr/team.js";

const allOff: SwitchesState = {
  setup: {
    rhythm: {
      plan: { enabled: false, cron: "0 8 * * 1", slack: false },
      scorecard: { enabled: false, cron: "0 15 * * 5", slack: false },
      brief: { enabled: false, cron: "30 7 * * 1-5", slack: false },
    },
    steps: { company: "2026-11-09T04:58:50.914Z" },
    completedAt: null,
    timezone: "America/Los_Angeles",
    ideas: { level: "normal", adaptive: true, slackListen: true },
  },
  autonomy: DEFAULT_TEAM.autonomy,
  learner: null,
  inboxFiling: "suggest",
};

describe("what's switched on", () => {
  it("says every feature is off and where each one is switched on", () => {
    const text = switchesContextText(allOff);
    expect(text).toMatch(/^## What's switched on/);
    expect(text).toContain("- Monday plan: off (Setup → Rhythm and ideas)");
    expect(text).toContain("- Friday scorecard: off (Setup → Rhythm and ideas). When on, you measure every goal's number");
    expect(text).toContain("Growth → Edit goals once setup is done");
    expect(text).toContain("off until the team saves Setup → Rhythm and ideas");
    expect(text).toContain("It isn't sent to you to read.");
    expect(text).toContain("- Daily review: off (Integrations → Team → Daily review)");
    expect(text).toContain("- Learner: off (Integrations → Learning)");
    expect(text).toContain("You can't switch these yourself");
    expect(text).toContain("Don't make an agent for a job one of these already does");
  });

  it("says when each is on", () => {
    const text = switchesContextText({
      ...allOff,
      setup: {
        ...allOff.setup,
        steps: { ...allOff.setup.steps, rhythm: "2026-11-10T00:00:00.000Z" },
        rhythm: { ...allOff.setup.rhythm, scorecard: { enabled: true, cron: "0 15 * * 5", slack: false } },
      },
      autonomy: { ...allOff.autonomy, actOnReports: true, dailyReview: { enabled: true, time: "08:30", weekdaysOnly: true } },
      learner: { tag: "@sage", paused: false, cron: "0 10 * * 3" },
      inboxFiling: "off",
    });
    expect(text).toMatch(/- Friday scorecard: on, .*Friday/);
    expect(text).toContain("- Ideas: on, at a normal pace, from the team's Slack conversations, goals and quiet stretches.");
    expect(text).toContain("- Daily review: on, at 08:30 on weekdays");
    expect(text).toContain("- Check-ins: on.");
    expect(text).toMatch(/- Learner @sage: on, .*Wednesday/);
    expect(text).toContain("with no filing suggestion");
  });

  it("says where ideas come from when tethr isn't listening to Slack", () => {
    const text = switchesContextText({
      ...allOff,
      setup: { ...allOff.setup, completedAt: "2026-11-10T00:00:00.000Z", ideas: { level: "light", adaptive: true, slackListen: false } },
    });
    expect(text).toContain("- Ideas: on, at a light pace, from goals and quiet stretches only, not listening to Slack.");
  });
});

function agent(over: Partial<TeamAgent> = {}): TeamAgent {
  return {
    agentId: "a1",
    tag: "@seo",
    name: "SEO",
    title: "SEO lead",
    mission: "Grows search traffic.",
    paused: false,
    threadId: "t1",
    lead: false,
    leadTag: null,
    sandbox: false,
    schedule: null,
    ownerRole: "growth",
    connectors: [],
    goalTitle: null,
    ...over,
  } as TeamAgent;
}

describe("running the team with no agents", () => {
  const settings = DEFAULT_TEAM;
  it("tells tethr to bring the agent with its first recommendation", () => {
    expect(teamContextText([], { settings })).toContain("You have no working agents yet");
    // The learner doesn't count: it studies, it doesn't run the recommendation.
    expect(teamContextText([agent({ tag: "@sage", sandbox: true })], { settings })).toContain("You have no working agents yet");
    expect(teamContextText([agent({ paused: true })], { settings })).toContain("You have no working agents yet");
  });

  it("drops the rule once an agent is working", () => {
    expect(teamContextText([agent()], { settings })).not.toContain("You have no working agents yet");
  });
});
