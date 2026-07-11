import { describe, it, expect } from "vitest";
import { microsToAmount } from "../tethr/tools/google-ads.js";
import { parseKeywordIdeas } from "../tethr/tools/keyword-planner.js";
import { googleDriveConfigured } from "../tethr/tools/google-drive.js";
import { getToolByName, toolsetForSubagent } from "../tethr/tools/index.js";

describe("google ads helpers", () => {
  it("converts micros to a dollar amount", () => {
    expect(microsToAmount(1_000_000)).toBe(1);
    expect(microsToAmount("2500000")).toBe(2.5);
    expect(microsToAmount(undefined)).toBe(0);
  });
});

describe("keyword planner parse", () => {
  it("maps Keyword Planner rows to typed ideas", () => {
    const ideas = parseKeywordIdeas([
      {
        text: "travel vaccines peru",
        keywordIdeaMetrics: {
          avgMonthlySearches: "1300",
          competition: "MEDIUM",
          averageCpcMicros: "2500000",
          lowTopOfPageBidMicros: "1000000",
          highTopOfPageBidMicros: "4000000",
        },
      },
    ]);
    expect(ideas[0]).toEqual({
      text: "travel vaccines peru",
      monthlySearchVolume: 1300,
      competition: "MEDIUM",
      averageCpc: 2.5,
      lowTopOfPageCpc: 1,
      highTopOfPageCpc: 4,
    });
  });
});

describe("tool registry — Google Ads is read-only and correctly scoped", () => {
  it("registers a read-only ads report tool and a keyword tool", () => {
    const ads = getToolByName("google_ads_report");
    expect(ads).toBeTruthy();
    expect(ads?.description).toMatch(/READ-ONLY/);
    expect(getToolByName("keyword_ideas")).toBeTruthy();
  });

  it("exposes NO account-mutating Google Ads tool (no spend without a human)", () => {
    for (const name of ["google_ads_mutate", "update_campaign_budget", "update_keyword_bid", "create_ad"]) {
      expect(getToolByName(name)).toBeNull();
    }
  });

  it("grants ads to Tailwind/Ledger and keywords to Atlas — but never to Sonar", () => {
    const tailwind = toolsetForSubagent({ tag: "@tailwind.analyze" }).map((t) => t.name);
    expect(tailwind).toContain("google_ads_report");
    const ledger = toolsetForSubagent({ tag: "@ledger.reporter" }).map((t) => t.name);
    expect(ledger).toContain("google_ads_report");
    const atlas = toolsetForSubagent({ tag: "@atlas.keywords" }).map((t) => t.name);
    expect(atlas).toContain("keyword_ideas");
    // Sonar (the scout) must not gain ads/keyword reach.
    const sonar = toolsetForSubagent({ tag: "@sonar.leads" }).map((t) => t.name);
    expect(sonar).not.toContain("google_ads_report");
    expect(sonar).not.toContain("keyword_ideas");
  });
});

describe("google drive writer", () => {
  it("is inert until a service account + folder are configured", () => {
    const saved = { key: process.env.TETHR_GDRIVE_SA_KEY, path: process.env.TETHR_GDRIVE_SA_KEY_PATH, folder: process.env.TETHR_GDRIVE_FOLDER_ID };
    delete process.env.TETHR_GDRIVE_SA_KEY;
    delete process.env.TETHR_GDRIVE_SA_KEY_PATH;
    delete process.env.TETHR_GDRIVE_FOLDER_ID;
    try {
      expect(googleDriveConfigured()).toBe(false);
    } finally {
      if (saved.key !== undefined) process.env.TETHR_GDRIVE_SA_KEY = saved.key;
      if (saved.path !== undefined) process.env.TETHR_GDRIVE_SA_KEY_PATH = saved.path;
      if (saved.folder !== undefined) process.env.TETHR_GDRIVE_FOLDER_ID = saved.folder;
    }
  });
});
