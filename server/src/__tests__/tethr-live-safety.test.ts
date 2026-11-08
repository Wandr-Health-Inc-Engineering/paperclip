import { afterEach, describe, it, expect, vi } from "vitest";
import { toolsetForSubagent } from "../tethr/tools/index.js";
import { webFetchTool } from "../tethr/tools/web.js";
import { fetchPublic, type HostLookup } from "../tethr/net.js";
import { priceUsd, rateForModel } from "../tethr/llm/pricing.js";

// Phase 3 safety envelope. Before flipping Sonar to the live Claude provider we
// assert — as a regression-protected invariant, not a hope — that a Sonar run
// cannot write outside the Tethr Drive or publish anywhere external. The only
// external vector is the `notify` tool (Slack), which is itself gated by
// SLACK_BOT_TOKEN at runtime and only granted to one Sonar subagent.

const SONAR_TAGS = ["@sonar.leads", "@sonar.reply", "@sonar.news"];
// Tools that write state or reach outside the Drive.
const WRITE_TOOLS = ["drive_write", "advance_tracker"];
const EXTERNAL_TOOLS = ["notify"];

describe("Sonar live-run safety (tool allowlist)", () => {
  it("gives no Sonar subagent a filesystem/Drive/tracker write tool", () => {
    for (const tag of SONAR_TAGS) {
      const names = toolsetForSubagent({ tag }).map((t) => t.name);
      for (const w of WRITE_TOOLS) {
        expect(names, `${tag} must not have ${w}`).not.toContain(w);
      }
    }
  });

  it("grants the sole external vector (notify) to @sonar.leads only", () => {
    const withNotify = SONAR_TAGS.filter((tag) =>
      toolsetForSubagent({ tag })
        .map((t) => t.name)
        .some((n) => EXTERNAL_TOOLS.includes(n)),
    );
    expect(withNotify).toEqual(["@sonar.leads"]);
  });

  it("otherwise limits Sonar to read/fetch tools", () => {
    // escalate is baseline (every agent can raise a hand to its overseer); it
    // reaches a human via an in-thread mention, not an external publish, so it
    // is not part of the external-vector surface asserted above.
    expect(toolsetForSubagent({ tag: "@sonar.reply" }).map((t) => t.name)).toEqual([
      "drive_list",
      "drive_read",
      "recall_memory",
      "escalate",
      "reddit_scan",
    ]);
    expect(toolsetForSubagent({ tag: "@sonar.news" }).map((t) => t.name)).toEqual([
      "drive_list",
      "drive_read",
      "recall_memory",
      "escalate",
      "cdc_scan",
      "web_fetch",
    ]);
  });
});

describe("live-run pricing (budget hard-stop depends on this)", () => {
  it("prices Sonnet usage at $3/$15 per MTok", () => {
    expect(priceUsd("claude-sonnet-4-6", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(18, 6);
    expect(priceUsd("claude-sonnet-4-6", { inputTokens: 200_000, outputTokens: 50_000 })).toBeCloseTo(1.35, 6);
  });

  it("never returns a negative cost", () => {
    expect(priceUsd("claude-sonnet-4-6", { inputTokens: -5, outputTokens: -5 })).toBe(0);
  });

  it("falls back to a Sonnet-class rate for an unknown model (never silent $0)", () => {
    expect(rateForModel("some-future-model")).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
  });

  it("tolerates a dated snapshot suffix", () => {
    expect(rateForModel("claude-opus-4-8-20251114")).toEqual({ inputPerMTok: 5, outputPerMTok: 25 });
  });

  it("honors an env price override", () => {
    const savedIn = process.env.TETHR_PRICE_INPUT_PER_MTOK;
    const savedOut = process.env.TETHR_PRICE_OUTPUT_PER_MTOK;
    process.env.TETHR_PRICE_INPUT_PER_MTOK = "10";
    process.env.TETHR_PRICE_OUTPUT_PER_MTOK = "20";
    try {
      expect(rateForModel("claude-sonnet-4-6")).toEqual({ inputPerMTok: 10, outputPerMTok: 20 });
    } finally {
      if (savedIn === undefined) delete process.env.TETHR_PRICE_INPUT_PER_MTOK;
      else process.env.TETHR_PRICE_INPUT_PER_MTOK = savedIn;
      if (savedOut === undefined) delete process.env.TETHR_PRICE_OUTPUT_PER_MTOK;
      else process.env.TETHR_PRICE_OUTPUT_PER_MTOK = savedOut;
    }
  });
});

// Live web fetches (TETHR_LIVE_FETCH=true) reach only public hosts. tethr's API
// answers loopback requests as the admin, so a fetch of localhost, a LAN name or
// a redirect to either would read private data back into an agent's answer.
describe("web fetches stay on the public web", () => {
  const publicLookup: HostLookup = async () => [{ address: "93.184.216.34" }];
  const savedLive = process.env.TETHR_LIVE_FETCH;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedLive === undefined) delete process.env.TETHR_LIVE_FETCH;
    else process.env.TETHR_LIVE_FETCH = savedLive;
  });

  function stubFetch(responses: Response[]) {
    const fetchMock = vi.fn(async () => responses.shift() ?? new Response("done"));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("refuses a localhost or LAN URL before any request", async () => {
    process.env.TETHR_LIVE_FETCH = "true";
    const fetchMock = stubFetch([]);
    for (const url of ["http://127.0.0.1:3100/api/tethr/x/chats", "http://localhost:3100/", "http://[::1]/", "http://192.168.1.4/", "http://169.254.169.254/latest"]) {
      const result = await webFetchTool.execute({} as never, { url });
      expect(result.output).toMatch(/^Blocked/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a public name that resolves to a private address", async () => {
    const fetchMock = stubFetch([]);
    const lanLookup: HostLookup = async () => [{ address: "10.0.0.5" }];
    await expect(fetchPublic("http://printer.example.com/", { headers: {}, timeoutMs: 1000 }, lanLookup)).rejects.toThrow(/local network/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a redirect that points back at this computer", async () => {
    const fetchMock = stubFetch([new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3100/api/tethr/x/assistant/memory" } })]);
    await expect(fetchPublic("https://bounce.example.com/", { headers: {}, timeoutMs: 1000 }, publicLookup)).rejects.toThrow(/local network/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect between public pages", async () => {
    const fetchMock = stubFetch([
      new Response(null, { status: 301, headers: { location: "/moved" } }),
      new Response("hello", { status: 200 }),
    ]);
    const res = await fetchPublic("https://site.example.com/old", { headers: {}, timeoutMs: 1000 }, publicLookup);
    expect(await res.text()).toBe("hello");
    expect(String((fetchMock.mock.calls[1] as unknown[])[0])).toBe("https://site.example.com/moved");
  });

  it("stops after too many redirects", async () => {
    const loops = Array.from({ length: 10 }, () => new Response(null, { status: 302, headers: { location: "https://loop.example.com/" } }));
    stubFetch(loops);
    await expect(fetchPublic("https://loop.example.com/", { headers: {}, timeoutMs: 1000 }, publicLookup)).rejects.toThrow(/too many redirects/);
  });
});
