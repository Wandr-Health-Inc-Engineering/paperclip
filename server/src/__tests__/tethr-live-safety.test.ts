import http from "node:http";
import type { AddressInfo } from "node:net";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
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
// A local server stands in for "a public site": test names resolve to it through
// an injected lookup, and only that path is let through.
describe("web fetches stay on the public web", () => {
  let server!: http.Server;
  let port = 0;
  const hits: string[] = [];
  const routes: Record<string, (res: http.ServerResponse) => void> = {};
  const savedLive = process.env.TETHR_LIVE_FETCH;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      const route = routes[req.url ?? ""];
      if (route) route(res);
      else res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (savedLive === undefined) delete process.env.TETHR_LIVE_FETCH;
    else process.env.TETHR_LIVE_FETCH = savedLive;
  });

  beforeEach(() => {
    hits.length = 0;
    for (const key of Object.keys(routes)) delete routes[key];
  });

  /** Test names → the local server; it stands in for a public address. */
  const toTestServer: HostLookup = async () => [{ address: "127.0.0.1" }];
  const asPublic = { lookup: toTestServer, isRefusedAddress: () => false };
  const opts = { headers: {}, timeoutMs: 2000 };

  it("refuses a localhost or LAN URL before any request", async () => {
    process.env.TETHR_LIVE_FETCH = "true";
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, "http://192.168.1.4/", "http://169.254.169.254/latest", `http://2130706433:${port}/`]) {
      const result = await webFetchTool.execute({} as never, { url });
      expect(result.output).toMatch(/^Blocked/);
    }
    expect(hits).toEqual([]);
  });

  it("refuses a name that resolves to this computer, checked on the address it connects to", async () => {
    await expect(fetchPublic(`http://rebind.example.com:${port}/`, { ...opts, lookup: toTestServer })).rejects.toThrow(/local network/);
    expect(hits).toEqual([]);
  });

  it("refuses a redirect to this computer, by address or by a name that lands there", async () => {
    routes["/to-literal"] = (res) => res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
    routes["/to-name"] = (res) => res.writeHead(302, { location: `http://lan.example.com:${port}/secret` }).end();
    await expect(fetchPublic(`http://site.example.com:${port}/to-literal`, { ...opts, ...asPublic })).rejects.toThrow(/local network/);
    // site.example.com counts as public here; lan.example.com lands on a refused LAN address.
    const lanOnSecondName = {
      lookup: async (name: string) => (name === "lan.example.com" ? [{ address: "10.0.0.5" }] : [{ address: "127.0.0.1" }]),
      isRefusedAddress: (address: string) => address.startsWith("10."),
    };
    await expect(fetchPublic(`http://site.example.com:${port}/to-name`, { ...opts, ...lanOnSecondName })).rejects.toThrow(/local network/);
    expect(hits).toEqual([`site.example.com:${port}/to-literal`, `site.example.com:${port}/to-name`]);
  });

  it("follows a redirect between public pages and unzips the body", async () => {
    routes["/old"] = (res) => res.writeHead(301, { location: "/moved" }).end();
    routes["/moved"] = (res) => res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" }).end(gzipSync("hello"));
    const res = await fetchPublic(`http://site.example.com:${port}/old`, { ...opts, ...asPublic });
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("hello");
    expect(hits).toEqual([`site.example.com:${port}/old`, `site.example.com:${port}/moved`]);
  });

  it("reads deflate with or without the zlib wrapper, and refuses a body that unzips too large", async () => {
    routes["/zlib"] = (res) => res.writeHead(200, { "content-encoding": "deflate" }).end(deflateSync("wrapped"));
    routes["/raw"] = (res) => res.writeHead(200, { "content-encoding": "deflate" }).end(deflateRawSync("raw"));
    routes["/bomb"] = (res) => res.writeHead(200, { "content-encoding": "gzip" }).end(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
    expect(await (await fetchPublic(`http://site.example.com:${port}/zlib`, { ...opts, ...asPublic })).text()).toBe("wrapped");
    expect(await (await fetchPublic(`http://site.example.com:${port}/raw`, { ...opts, ...asPublic })).text()).toBe("raw");
    await expect(fetchPublic(`http://site.example.com:${port}/bomb`, { ...opts, ...asPublic })).rejects.toThrow(/too large/);
  });

  it("stops after too many redirects", async () => {
    routes["/loop"] = (res) => res.writeHead(302, { location: "/loop" }).end();
    await expect(fetchPublic(`http://site.example.com:${port}/loop`, { ...opts, ...asPublic })).rejects.toThrow(/too many redirects/);
    expect(hits).toHaveLength(6);
  });

  it("bounds the whole fetch, redirects included, by one timeout", async () => {
    routes["/slow"] = () => {}; // never answers
    const started = Date.now();
    await expect(fetchPublic(`http://site.example.com:${port}/slow`, { ...opts, timeoutMs: 200, ...asPublic })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
