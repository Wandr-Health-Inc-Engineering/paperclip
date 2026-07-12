import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import { buildRecommendation } from "../tethr/recommendation.js";
import {
  chunkSlackText,
  extractLinks,
  interpretSlackEvent,
  isAffirmative,
  isResetPhrase,
  postSlackMessage,
  slackConfigured,
  slackSourceKey,
  stripResetPhrase,
  verifySlackSignature,
} from "../tethr/slack.js";

describe("recommendation builder", () => {
  const built = buildRecommendation({
    agentCodename: "Sentry",
    title: "Homepage meta description missing",
    why: "Search engines fall back to page text, hurting click-through.",
    affectedUrl: "https://travelwithwandr.com/",
    affectedPage: "/",
    filePath: "app/(marketing)/page.tsx",
    severity: "high",
    details: ["Expected: 1 description", "Found: 0"],
  });

  it("puts severity + title in the fallback text", () => {
    expect(built.text).toContain("[HIGH]");
    expect(built.text).toContain("Homepage meta description missing");
    expect(built.text).toContain("Sentry");
  });

  it("emits the file path as plain text (copy-safe for @Cursor)", () => {
    expect(built.body).toContain("File: app/(marketing)/page.tsx");
    // plain path — no backticks/code fences that would mangle a copy
    expect(built.body).not.toContain("`");
  });

  it("always ends with the @Cursor footer", () => {
    expect(built.body.trimEnd()).toMatch(/tag @Cursor to fix\.$/);
    const last = built.blocks[built.blocks.length - 1] as {
      type: string;
      elements: Array<{ text: string }>;
    };
    expect(last.type).toBe("context");
    expect(last.elements[0].text).toContain("@Cursor");
  });

  it("renders Block Kit with the title first and an affected section", () => {
    const first = built.blocks[0] as { text: { text: string } };
    expect(first.text.text).toBe("*Homepage meta description missing*");
    const affected = built.blocks.find(
      (b) => (b as { text?: { text?: string } }).text?.text?.startsWith("*Affected*"),
    ) as { text: { text: string } } | undefined;
    expect(affected?.text.text).toContain("URL: https://travelwithwandr.com/");
    expect(affected?.text.text).toContain("File: app/(marketing)/page.tsx");
  });
});

describe("extractLinks", () => {
  it("handles angle-bracket, labelled, and bare URLs and dedupes", () => {
    const links = extractLinks(
      "see <https://a.com/x|the page> and https://b.com/y. also <https://a.com/x>",
    );
    expect(links).toEqual(["https://a.com/x", "https://b.com/y"]);
  });
});

describe("interpretSlackEvent", () => {
  it("answers the url_verification challenge", () => {
    const r = interpretSlackEvent({ type: "url_verification", challenge: "c123" });
    expect(r).toEqual({ type: "challenge", challenge: "c123" });
  });

  it("turns an app_mention with a link into a kickoff (mention stripped)", () => {
    const r = interpretSlackEvent({
      type: "event_callback",
      event: {
        type: "app_mention",
        text: "<@U0BOT> please cover <https://x.com/a>",
        channel: "C0AE02FJR5Y",
        ts: "1700000000.001",
      },
    });
    expect(r.type).toBe("kickoff");
    if (r.type !== "kickoff") return;
    expect(r.links).toEqual(["https://x.com/a"]);
    expect(r.requestText).not.toContain("<@U0BOT>");
    expect(r.requestText).toContain("please cover");
    expect(r.channel).toBe("C0AE02FJR5Y");
    expect(r.threadTs).toBe("1700000000.001");
  });

  it("treats a bare link drop (no mention) as a kickoff", () => {
    const r = interpretSlackEvent({
      type: "event_callback",
      event: { type: "message", text: "found this <https://x.com/y>", channel: "C1", ts: "2.0" },
    });
    expect(r.type).toBe("kickoff");
  });

  it("ignores plain chatter with no mention/link/photo", () => {
    const r = interpretSlackEvent({
      type: "event_callback",
      event: { type: "message", text: "morning everyone" },
    });
    expect(r.type).toBe("ignore");
  });

  it("treats any DM to the bot as a kickoff (like the Console chat)", () => {
    const r = interpretSlackEvent({
      type: "event_callback",
      event: { type: "message", channel_type: "im", text: "what's our Peru ad budget?", channel: "D123", ts: "3.0" },
    });
    expect(r.type).toBe("kickoff");
    if (r.type !== "kickoff") return;
    expect(r.requestText).toBe("what's our Peru ad budget?");
    expect(r.channel).toBe("D123");
  });

  it("ignores bot messages (loop guard)", () => {
    const r = interpretSlackEvent({
      type: "event_callback",
      event: { type: "message", bot_id: "B1", text: "posted <https://x.com>" },
    });
    expect(r.type).toBe("ignore");
  });

  it("marks a DM kickoff with isDM for continuity keying", () => {
    const r = interpretSlackEvent({
      type: "event_callback",
      event: { type: "message", channel_type: "im", text: "hi", channel: "D9", ts: "5.0" },
    });
    expect(r.type).toBe("kickoff");
    if (r.type !== "kickoff") return;
    expect(r.isDM).toBe(true);
  });
});

describe("slack conversation continuity helpers", () => {
  it("keys a DM to one rolling conversation, a channel thread to its root", () => {
    expect(slackSourceKey({ channel: "D1", isDM: true, threadTs: "9.9" })).toBe("slack:im:D1");
    expect(slackSourceKey({ channel: "C1", threadTs: "1700.1" })).toBe("slack:C1:1700.1");
    // A channel message with no thread can't be keyed (avoid cross-talk).
    expect(slackSourceKey({ channel: "C1" })).toBeNull();
    expect(slackSourceKey({})).toBeNull();
  });

  it("detects a reset/wipe command that forces a fresh thread", () => {
    expect(isResetPhrase("new topic — how's SEO?")).toBe(true);
    expect(isResetPhrase("Start over")).toBe(true);
    expect(isResetPhrase("nevermind")).toBe(true);
    expect(isResetPhrase("wipe memory")).toBe(true);
    expect(isResetPhrase("clear the chat")).toBe(true);
    expect(isResetPhrase("forget everything")).toBe(true);
    expect(isResetPhrase("new chat")).toBe(true);
    // Not a reset: normal questions that merely contain a keyword mid-sentence.
    expect(isResetPhrase("what's our ad spend?")).toBe(false);
    expect(isResetPhrase("clearly we should ship this")).toBe(false);
    expect(isResetPhrase("can you reset expectations with the vendor?")).toBe(false);
  });

  it("recognizes 'clean up' / 'clean slate' as wipe commands", () => {
    expect(isResetPhrase("clean up")).toBe(true);
    expect(isResetPhrase("cleanup")).toBe(true);
    expect(isResetPhrase("clean slate")).toBe(true);
    expect(stripResetPhrase("clean up")).toBe("");
  });

  it("strips the reset command, leaving any real question that followed", () => {
    expect(stripResetPhrase("new topic — how's SEO?")).toBe("how's SEO?");
    expect(stripResetPhrase("reset")).toBe("");
    expect(stripResetPhrase("wipe memory")).toBe("");
    expect(stripResetPhrase("new topic: how are ads doing?")).toBe("how are ads doing?");
    expect(stripResetPhrase("forget everything, what's our CAC?")).toBe("what's our CAC?");
  });

  it("treats a short yes as confirmation, but not a real message", () => {
    for (const yes of ["yes", "y", "Yep", "confirm", "do it", "ok", "sure", "wipe it"]) {
      expect(isAffirmative(yes), yes).toBe(true);
    }
    for (const no of ["no", "not yet", "yes but keep the Peru notes", "actually how are ads?"]) {
      expect(isAffirmative(no), no).toBe(false);
    }
  });

  it("chunks long answers on boundaries, short ones pass through whole", () => {
    expect(chunkSlackText("short answer")).toEqual(["short answer"]);
    expect(chunkSlackText("")).toEqual([]);
    const para = `${"a".repeat(2000)}\n\n${"b".repeat(2000)}`;
    const chunks = chunkSlackText(para, 2900);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.length <= 2900)).toBe(true);
    expect(chunks[0]).toMatch(/^a+$/);
    expect(chunks[1]).toMatch(/^b+$/);
  });
});

describe("test-safety: the suite never posts to real Slack", () => {
  // Regression: a real SLACK_BOT_TOKEN was leaking into the test process via the
  // instance .env and the e2e notifications posted fixtures to the live #scout.
  it("slackConfigured() is false under test even when a token is set", () => {
    const saved = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-must-not-be-used-in-tests";
    try {
      expect(slackConfigured()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = saved;
    }
  });
  it("postSlackMessage() skips (never calls Slack) under test", async () => {
    const saved = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-must-not-be-used-in-tests";
    try {
      const r = await postSlackMessage({ text: "should never send" });
      expect(r.ok).toBe(false);
      expect(r.skipped).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = saved;
    }
  });
});

describe("verifySlackSignature", () => {
  const secret = "8f742231b10e8888abcd99yyyzzz85a5";
  const timestamp = "1700000000";
  const rawBody = '{"type":"event_callback"}';
  const good =
    "v0=" +
    crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");

  it("accepts a valid signature within the replay window", () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature: good,
        rawBody,
        nowSeconds: Number(timestamp) + 10,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature: good,
        rawBody: rawBody + "x",
        nowSeconds: Number(timestamp) + 10,
      }),
    ).toBe(false);
  });

  it("rejects a stale timestamp (replay)", () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp,
        signature: good,
        rawBody,
        nowSeconds: Number(timestamp) + 3600,
      }),
    ).toBe(false);
  });

  it("skips (returns true) when no signing secret is configured", () => {
    const saved = process.env.SLACK_SIGNING_SECRET;
    delete process.env.SLACK_SIGNING_SECRET;
    try {
      expect(
        verifySlackSignature({ timestamp, signature: good, rawBody }),
      ).toBe(true);
    } finally {
      if (saved !== undefined) process.env.SLACK_SIGNING_SECRET = saved;
    }
  });
});
