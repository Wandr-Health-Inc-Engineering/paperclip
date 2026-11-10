import { describe, expect, it } from "vitest";
import type { TethrTeamAgent } from "@/api/tethr";
import { agentForThread, agentStatusWords, agentTone, dollars, orderTeam } from "./tethr-team";

const base = { paused: false, running: false, waitingOnYou: 0, schedule: null } as const;

describe("tethr team in the chat", () => {
  it("gives each agent one dot: needs you, then working, then paused, then idle", () => {
    expect(agentTone({ ...base, waitingOnYou: 1, running: true })).toBe("warn");
    expect(agentTone({ ...base, running: true })).toBe("live");
    expect(agentTone({ ...base, paused: true })).toBe("paused");
    expect(agentTone(base)).toBe("ok");
  });

  it("says the status in words", () => {
    expect(agentStatusWords({ ...base, waitingOnYou: 2 })).toBe("2 need you");
    // A missing connection says it isn't running at all, ahead of everything else.
    expect(agentTone({ ...base, waitingFor: ["Google Ads"] })).toBe("warn");
    expect(agentStatusWords({ ...base, running: true, waitingOnYou: 1, waitingFor: ["Google Ads"] })).toBe("Waiting for Google Ads");
    expect(agentStatusWords({ ...base, running: true })).toBe("Working now");
    expect(agentStatusWords({ ...base, schedule: { cron: "0 9 * * 1", brief: "x", words: "every Monday at 9:00 am" } })).toBe("Runs every Monday at 9:00 am");
    expect(agentStatusWords(base)).toBe("Works when tethr assigns it");
    expect(agentStatusWords({ ...base, leadTag: "@paid-search" })).toBe("Works when @paid-search assigns it");
  });

  it("lists each lead with its sub-team under it", () => {
    const agents = [
      { tag: "@ads", leadTag: null },
      { tag: "@scout", leadTag: null },
      { tag: "@kw", leadTag: "@ads" },
      { tag: "@orphan", leadTag: "@gone" },
    ];
    expect(orderTeam(agents).map((r) => `${r.depth}${r.agent.tag}`)).toEqual(["0@ads", "1@kw", "0@scout", "0@orphan"]);
  });

  it("formats money and finds an agent by its chat", () => {
    expect(dollars(1500)).toBe("$15");
    expect(dollars(1234)).toBe("$12.34");
    const agents = [{ threadId: "t1", tag: "@scout" }] as TethrTeamAgent[];
    expect(agentForThread(agents, "t1")?.tag).toBe("@scout");
    expect(agentForThread(agents, "t2")).toBeUndefined();
    expect(agentForThread(agents, null)).toBeUndefined();
  });
});
