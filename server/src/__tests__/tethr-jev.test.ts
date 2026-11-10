import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import { JevError, jevAsk, jevHealth, jevHealthText, jevRoute } from "../tethr/jev.ts";
import {
  compositeOf,
  csvFileName,
  parseCriteria,
  parseCsv,
  readListFile,
  runKeywordIdeas,
  runScoreList,
  toCsv,
  uncertainOf,
  type Criterion,
} from "../tethr/assistant/tethr-tools.ts";
import { BRIDGE_SOURCE, buildMcpConfig } from "../tethr/assistant/tools-bridge.ts";
import { classify, decide, type PolicyContext } from "../tethr/assistant/policy.ts";
import { applyStreamLine, newTurnState } from "../tethr/assistant/events.ts";
import { denyRulesFor, DEFAULT_INTEGRATIONS, integrationRulesText, updateIntegrations } from "../tethr/integrations.ts";
import { issueHookToken } from "../tethr/assistant/gate.ts";
import { seedTethrCore } from "../tethr/seed/tethr-core.ts";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Phase 19: Tethr's own chat tools — Jev scoring (score_list) and keyword_ideas,
// served to the chat's Claude session through the "tethr" MCP bridge.

type FetchArgs = { url: string; init: RequestInit; body: Record<string, unknown> };

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fake Jev: anything mentioning malaria fits; "competitor" items are competitors. */
function fakeJev(calls: FetchArgs[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(url), init: init ?? {}, body });
    const text = JSON.stringify(body.state).toLowerCase();
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(body.questions as Record<string, { type: string; criteria?: unknown }>)) {
      if (q.type === "score") {
        const top = (q.criteria as string[]).length - 1;
        answers[key] = { type: "score", score: text.includes("malaria") ? top : 0.4, confidence: text.includes("maybe") ? 0.3 : 0.9, legend: {}, probabilities: {} };
      } else if (q.type === "noul") {
        answers[key] = { type: "noul", noul: text.includes("competitor") ? 0.95 : 0.05 };
      } else {
        const opts = Object.keys(q.criteria as Record<string, unknown>);
        answers[key] = { type: "choice", choice: text.includes("malaria") ? opts[0] : opts[opts.length - 1], confidence: 0.8, probabilities: {} };
      }
    }
    return json(200, { model: "jev-1.14.0", answers, usage: { input_tokens: 100, output_tokens: 5 } });
  }) as typeof fetch;
}

const noSleep = async () => {};
let tmp!: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-jev-"));
  process.env.TYPESAFE_API_KEY = "test-key";
  delete process.env.TYPESAFE_API_URL;
  delete process.env.TETHR_JEV_MODEL;
});

afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("tethr jev — client", () => {
  it("posts the state and typed questions with the bearer key, and reads the answers", async () => {
    const calls: FetchArgs[] = [];
    process.env.TETHR_JEV_MODEL = "jev-1.14.0";
    const res = await jevAsk("malaria pills", { fit: { type: "noul", instructions: "Fits?" } }, { fetchImpl: fakeJev(calls) });
    expect(calls[0].url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(calls[0].body).toEqual({ model: "jev-1.14.0", state: "malaria pills", questions: { fit: { type: "noul", instructions: "Fits?" } } });
    expect(res.model).toBe("jev-1.14.0");
    expect(res.usage.input_tokens).toBe(100);
  });

  it("retries rate limits and overload, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const f = (async () => {
      n++;
      if (n === 1) return json(429, { detail: "slow down" }, { "retry-after": "2" });
      if (n === 2) return json(529, { detail: "busy" });
      return json(200, { model: "jev-1.14.0", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch;
    const res = await jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: f, sleep: async (ms) => void waits.push(ms) });
    expect(n).toBe(3);
    expect(waits[0]).toBe(2000);
    expect(res.answers.a).toEqual({ type: "noul", noul: 0.9 });
  });

  it("doesn't retry a bad key, and says what's wrong without the key", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return json(401, { detail: "invalid" });
    }) as typeof fetch;
    const err = await jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: f, sleep: noSleep }).catch((e) => e);
    expect(n).toBe(1);
    expect(err).toBeInstanceOf(JevError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/TYPESAFE_API_KEY/);
    expect(err.message).not.toContain("test-key");
  });

  it("gives up after network errors and refuses to run without a key", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: f, sleep: noSleep, retries: 2 })).rejects.toThrow(/Couldn't reach Jev/);
    expect(n).toBe(3);
    delete process.env.TYPESAFE_API_KEY;
    await expect(jevAsk("x", { a: { type: "noul", instructions: "?" } })).rejects.toThrow(/isn't set up/);
  });

  it("knows whether TypeSafe accepts the key (a saved key isn't the same as a working one)", async () => {
    const seen: string[] = [];
    const answer = (status: number) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(`${String(url)} ${(init?.headers as Record<string, string>).authorization}`);
        return json(status, status === 200 ? { data: [] } : { detail: { error_type: "authentication_error" } });
      }) as typeof fetch;
    delete process.env.TYPESAFE_API_KEY;
    expect(await jevHealth({ fetchImpl: answer(200) })).toBe("missing");
    expect(seen).toEqual([]);

    process.env.TYPESAFE_API_KEY = "bad-key";
    expect(await jevHealth({ fetchImpl: answer(401) })).toBe("rejected");
    expect(seen).toEqual(["https://api.typesafe.ai/v1/models Bearer bad-key"]);
    // Cached: no second request for the same key.
    expect(await jevHealth({ fetchImpl: answer(200) })).toBe("rejected");
    expect(seen).toHaveLength(1);
    expect(jevHealthText("rejected")).toMatch(/rejected the key/);

    // A new key is checked at once.
    process.env.TYPESAFE_API_KEY = "good-key";
    expect(await jevHealth({ fetchImpl: answer(200) })).toBe("ok");
    expect(seen).toHaveLength(2);

    // A real call that gets a 401 flips it without another check.
    await jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: answer(401), sleep: noSleep }).catch(() => undefined);
    expect(await jevHealth({ fetchImpl: answer(200) })).toBe("rejected");

    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    expect(await jevHealth({ fetchImpl: down, fresh: true })).toBe("unreachable");
  });

  it("sends a Vercel AI Gateway key (vck_) to Vercel's TypeSafe endpoint, and reads its cost and errors", async () => {
    process.env.TYPESAFE_API_KEY = "vck_test";
    expect(jevRoute()).toBe("vercel");
    expect(jevRoute("test-key")).toBe("typesafe");
    const calls: FetchArgs[] = [];
    const gateway = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {}, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (String(url).endsWith("/v1/models")) return json(200, { data: [{ id: "typesafe-ai/jev" }] });
      return json(200, {
        model: "typesafe-ai/jev",
        answers: { a: { type: "noul", noul: 0.94 } },
        usage: { input_tokens: 444, output_tokens: 72 },
        provider_metadata: { gateway: { cost: "0.000018648" } },
      });
    }) as typeof fetch;
    const res = await jevAsk("Invoice 1042", { a: { type: "noul", instructions: "Invoice?" } }, { fetchImpl: gateway });
    expect(calls[0].url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer vck_test");
    expect(calls[0].body.model).toBe("typesafe-ai/jev");
    expect(res.costUsd).toBeCloseTo(0.000018648, 12);
    expect(await jevHealth({ fetchImpl: gateway, fresh: true })).toBe("ok");
    expect(calls.at(-1)!.url).toBe("https://ai-gateway.vercel.sh/typesafe/v1/models");
    expect(jevHealthText("ok")).toBe("Connected through Vercel's AI Gateway");
    expect(jevHealthText("rejected")).toMatch(/Vercel's AI Gateway rejected the key/);

    // Vercel's own error shape, and running out of credits.
    const broke = (async () => json(402, { error: { message: "Insufficient funds", type: "insufficient_funds" } })) as typeof fetch;
    await expect(jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: broke, sleep: noSleep })).rejects.toThrow(/out of credits/);
    const denied = (async () => json(401, { message: "Authentication failed", error_type: "authentication_error" })) as typeof fetch;
    await expect(jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: denied, sleep: noSleep })).rejects.toThrow(/Vercel's AI Gateway rejected/);

    // An explicit address or model still wins.
    process.env.TYPESAFE_API_URL = "https://jev.example.test/";
    process.env.TETHR_JEV_MODEL = "jev-1.14.0";
    await jevAsk("x", { a: { type: "noul", instructions: "?" } }, { fetchImpl: gateway });
    expect(calls.at(-1)!.url).toBe("https://jev.example.test/v1/systemone");
    expect(calls.at(-1)!.body.model).toBe("jev-1.14.0");
  });

  it("reports no cost when TypeSafe doesn't say, so it's priced from tokens", async () => {
    const res = await jevAsk("malaria pills", { fit: { type: "noul", instructions: "Fits?" } }, { fetchImpl: fakeJev([]) });
    expect(res.costUsd).toBeNull();
  });
});

describe("tethr jev — criteria and composite", () => {
  it("validates criteria, fills defaults and de-duplicates names", () => {
    const c = parseCriteria([
      { name: "Catalog fit", question: "Does it fit?", type: "score", levels: ["No", "Some", "Yes"], weight: 2 },
      { name: "catalog fit", question: "Again?", type: "yes_no", want: "no" },
      { question: "Which funnel stage?", type: "choice", options: ["awareness", "consideration", "purchase"] },
      { question: "How urgent?", type: "score" },
    ]) as Criterion[];
    expect(c.map((x) => x.key)).toEqual(["catalog_fit", "catalog_fit_2", "which_funnel_stage", "how_urgent"]);
    expect(c[0].weight).toBe(2);
    expect(c[1].want).toBe("no");
    expect(c[2].weight).toBe(0); // choices never weigh in
    expect(Object.keys(c[2].options)).toEqual(["awareness", "consideration", "purchase"]);
    expect(c[3].levels.length).toBe(5);
    expect(parseCriteria([])).toMatch(/at least one/);
    expect(parseCriteria([{ question: "?", type: "rank" }])).toMatch(/type/);
    expect(parseCriteria([{ question: "?", type: "choice", options: ["only"] }])).toMatch(/2 to 50/);
    expect(parseCriteria([{ question: "?", type: "score", levels: ["one"] }])).toMatch(/2 to 10/);
  });

  it("combines scores and yes/no into a weighted 0..1 composite", () => {
    const c = parseCriteria([
      { name: "fit", question: "Fit?", type: "score", levels: ["0", "1", "2", "3", "4"], weight: 3 },
      { name: "competitor", question: "Competitor brand?", type: "yes_no", want: "no", weight: 1 },
      { name: "stage", question: "Stage?", type: "choice", options: ["a", "b"] },
    ]) as Criterion[];
    const answers = {
      fit: { type: "score" as const, score: 2, confidence: 0.9, probabilities: {} },
      competitor: { type: "noul" as const, noul: 0.2 },
      stage: { type: "choice" as const, choice: "a", confidence: 0.4, probabilities: {} },
    };
    // (3 * 0.5 + 1 * 0.8) / 4
    expect(compositeOf(c, answers)).toBeCloseTo(0.575, 5);
    expect(uncertainOf(c, answers)).toEqual(["stage"]);
    expect(uncertainOf(c, { ...answers, competitor: { type: "noul", noul: 0.5 } })).toEqual(["competitor", "stage"]);
  });
});

describe("tethr jev — files", () => {
  it("round-trips CSV with quotes, commas and newlines, and defuses formulas", () => {
    const csv = toCsv([
      ["item", "note", "n"],
      ['malaria "pills"', "a, b\nc", 3],
      ["=HYPERLINK(1)", "-2", -2],
    ]);
    const rows = parseCsv(csv);
    expect(rows[1]).toEqual(['malaria "pills"', "a, b\nc", "3"]);
    expect(rows[2]).toEqual(["'=HYPERLINK(1)", "'-2", "-2"]);
  });

  it("names files safely", () => {
    expect(csvFileName("../../etc/passwd")).toBe("passwd.csv");
    expect(csvFileName(".hidden.csv")).toBe("hidden.csv");
    expect(csvFileName("Spring keywords!.xlsx")).toBe("Spring keywords-.csv");
    expect(csvFileName("", "scores-1")).toBe("scores-1.csv");
  });

  it("reads lists only from files/", async () => {
    const files = path.join(tmp, "files");
    fs.mkdirSync(files, { recursive: true });
    fs.writeFileSync(path.join(files, "kw.csv"), "Keyword,Monthly Searches\nmalaria pills,880\ntravel vaccines,1300\n");
    fs.writeFileSync(path.join(files, "ideas.md"), "- one\n2. two\n\n* three\n");
    fs.writeFileSync(path.join(tmp, "Memory.md"), "secret");
    const ctx = { workspaceDir: tmp };
    expect(await readListFile("kw.csv", ctx)).toEqual([
      { keyword: "malaria pills", monthly_searches: "880" },
      { keyword: "travel vaccines", monthly_searches: "1300" },
    ]);
    expect(await readListFile("files/ideas.md", ctx)).toEqual(["one", "two", "three"]);
    expect(await readListFile("../Memory.md", ctx)).toMatch(/must be a file in/);
    expect(await readListFile("/etc/hosts", ctx)).toMatch(/must be a file in|no file/);
    expect(await readListFile("nope.csv", ctx)).toMatch(/no file/);
  });
});

describe("tethr jev — score_list", () => {
  const criteria = [
    { name: "fit", question: "Does this route to a Wandr medication?", type: "score", levels: ["No", "Partly", "Clearly"], weight: 2 },
    { name: "competitor", question: "Is this a competitor's brand name?", type: "yes_no", want: "no" },
  ];

  it("ranks the list, shows the top rows and saves every row as CSV", async () => {
    const calls: FetchArgs[] = [];
    const items = [
      { keyword: "cheap flights", monthly_searches: 90000 },
      { keyword: "malaria pills online", monthly_searches: 880 },
      { keyword: "competitor malaria", monthly_searches: 50 },
      { keyword: "=cmd malaria maybe", monthly_searches: 10 },
    ];
    const res = await runScoreList(
      { items, criteria, context: "Wandr sells travel meds.", top: 2, save_as: "kw scores" },
      { workspaceDir: tmp, jev: { fetchImpl: fakeJev(calls), sleep: noSleep } },
    );
    expect(res.isError).toBeFalsy();
    expect(calls).toHaveLength(4);
    expect(calls[0].body.state).toEqual({ context: "Wandr sells travel meds.", item: items[0] });
    expect(res.text).toMatch(/Scored 4 of 4 items with Jev \(jev-1\.14\.0\)/);
    // (2 * 1.0 + 1 * 0.95) / 3 → 98
    expect(res.text).toMatch(/\| 1 \| malaria pills online \| 98 \|/);
    expect(res.text).toMatch(/2 more in the CSV/);
    expect(res.text).toMatch(/Check = /);
    expect(res.file).toBe("files/kw scores.csv");
    const rows = parseCsv(fs.readFileSync(path.join(tmp, "files", "kw scores.csv"), "utf8"));
    expect(rows[0]).toEqual(["rank", "item", "composite", "fit", "competitor", "check", "keyword", "monthly_searches"]);
    expect(rows[1].slice(0, 3)).toEqual(["1", "malaria pills online", "98"]);
    expect(rows.find((r) => r[1].includes("cmd"))?.[1]).toBe("'=cmd malaria maybe");
    expect(rows[rows.length - 1][1]).toBe("cheap flights");
    expect(res.meta).toMatchObject({ items: 4, scored: 4, failed: 0, inputTokens: 400 });
  });

  it("stops early on a bad key instead of failing every item", async () => {
    let n = 0;
    const f = (async () => {
      n++;
      return json(401, {});
    }) as typeof fetch;
    const res = await runScoreList({ items: Array.from({ length: 50 }, (_, i) => `item ${i}`), criteria }, { workspaceDir: tmp, concurrency: 1, jev: { fetchImpl: f, sleep: noSleep } });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/TYPESAFE_API_KEY/);
    expect(n).toBe(1);
  });

  it("says plainly when Jev isn't set up, and checks its input", async () => {
    delete process.env.TYPESAFE_API_KEY;
    const off = await runScoreList({ items: ["a"], criteria }, { workspaceDir: tmp });
    expect(off.isError).toBe(true);
    expect(off.text).toMatch(/Score the items yourself/);
    process.env.TYPESAFE_API_KEY = "test-key";
    const ctx = { workspaceDir: tmp, jev: { fetchImpl: fakeJev(), sleep: noSleep } };
    expect((await runScoreList({ criteria }, ctx)).text).toMatch(/give items or from_file/);
    expect((await runScoreList({ items: Array(501).fill("x"), criteria }, ctx)).text).toMatch(/limit is 500/);
    // A file over the limit scores its first 500 rows instead of failing.
    fs.mkdirSync(path.join(tmp, "files"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "files", "long.txt"), Array.from({ length: 520 }, (_, i) => `kw ${i}`).join("\n"));
    const long = await runScoreList({ from_file: "long.txt", criteria }, ctx);
    expect(long.isError).toBeFalsy();
    expect(long.text).toMatch(/Scored 500 of 500 items/);
    expect(long.text).toMatch(/first 500 of 520 rows in long\.txt/);
    const big = await runScoreList({ items: ["malaria", "x".repeat(5000)], criteria }, ctx);
    expect(big.isError).toBeFalsy();
    expect(big.text).toMatch(/Couldn't score 1: .*too long/);
  });

  it("never writes over an existing file, including the list it scored, and says which file it saved", async () => {
    fs.mkdirSync(path.join(tmp, "files"), { recursive: true });
    const source = "keyword\nmalaria pills\nflights to bali\ntravel insurance\n";
    fs.writeFileSync(path.join(tmp, "files", "leads.csv"), source);
    const res = await runScoreList(
      { from_file: "leads.csv", criteria, save_as: "leads" },
      { workspaceDir: tmp, jev: { fetchImpl: fakeJev(), sleep: noSleep } },
    );
    expect(res.isError).toBeFalsy();
    expect(res.file).toBe("files/leads (2).csv");
    expect(res.text).toContain("[Saved file: files/leads (2).csv]");
    expect(fs.readFileSync(path.join(tmp, "files", "leads.csv"), "utf8")).toBe(source);
    const again = await runScoreList({ from_file: "leads.csv", criteria, save_as: "leads" }, { workspaceDir: tmp, jev: { fetchImpl: fakeJev(), sleep: noSleep } });
    expect(again.file).toBe("files/leads (3).csv");
    // A call that scores nothing saves nothing and names no file.
    const badKey = (async () => json(401, {})) as typeof fetch;
    const failed = await runScoreList({ items: ["a"], criteria, save_as: "nothing" }, { workspaceDir: tmp, concurrency: 1, jev: { fetchImpl: badKey, sleep: noSleep } });
    expect(failed.isError).toBe(true);
    expect(failed.file).toBeUndefined();
    expect(failed.text).not.toContain("[Saved file:");
    expect(fs.existsSync(path.join(tmp, "files", "nothing.csv"))).toBe(false);
  });

  it("scores a keyword_ideas CSV straight from files/", async () => {
    const ideas = async () => [
      { text: "malaria pills", monthlySearchVolume: 880, competition: "HIGH" as const, averageCpc: 2.5, lowTopOfPageCpc: 1, highTopOfPageCpc: 4 },
      { text: "flights to bali", monthlySearchVolume: 40000, competition: "LOW" as const, averageCpc: 0.5, lowTopOfPageCpc: 0.2, highTopOfPageCpc: 1 },
    ];
    const kw = await runKeywordIdeas({ seeds: ["malaria"], save_as: "ideas" }, { workspaceDir: tmp, keywordIdeas: ideas });
    expect(kw.file).toBe("files/ideas.csv");
    expect(kw.text).toMatch(/\| flights to bali \| 40000 \| LOW \| \$0\.50 \|/);
    expect(kw.text).toMatch(/from_file: "ideas\.csv"/);
    const scored = await runScoreList({ from_file: "ideas.csv", criteria }, { workspaceDir: tmp, jev: { fetchImpl: fakeJev(), sleep: noSleep } });
    expect(scored.text).toMatch(/\| 1 \| malaria pills \|/);
    expect((await runKeywordIdeas({ seeds: [] }, { workspaceDir: tmp, keywordIdeas: ideas })).isError).toBe(true);
    expect((await runKeywordIdeas({ seeds: ["a"], geo_target_ids: ["US"] }, { workspaceDir: tmp, keywordIdeas: ideas })).text).toMatch(/numeric/);
  });
});

describe("tethr jev — gate, settings and chat events", () => {
  const ctx: PolicyContext = { workspaceDir: "/drive/00 Tethr/tethr", readableRoots: ["/drive/00 Tethr"], internalAddresses: ["travelwithwandr.com"] };

  it("treats Tethr's own tools as reads, off only when turned off", () => {
    const c = classify("mcp__tethr__score_list", { items: ["a", "b"], criteria: [] }, ctx);
    expect(c).toMatchObject({ connector: "Tethr tools", server: "tethr", cls: "read", summary: "Scoring 2 items with Jev" });
    expect(decide(c, { mode: "ask", shell: "off" }).action).toBe("allow");
    expect(decide(c, { mode: "off", shell: "off" }).action).toBe("deny");
    // A medical-sounding list is still just a read (nothing leaves Wandr).
    expect(classify("mcp__tethr__score_list", { items: ["patient symptoms"] }, ctx).cls).toBe("read");
    expect(classify("mcp__tethr__keyword_ideas", { seeds: ["malaria"] }, ctx).summary).toBe("Keyword ideas for “malaria”");
    expect(classify("mcp__tethr__delete_everything", {}, ctx).cls).toBe("blocked");
  });

  it("denies the tethr server when Tethr tools are off, and tells the chat when to use them", () => {
    const off = { ...DEFAULT_INTEGRATIONS, connectors: { ...DEFAULT_INTEGRATIONS.connectors, "Tethr tools": { mode: "off" as const } } };
    expect(denyRulesFor(off)).toContain("mcp__tethr");
    expect(integrationRulesText(off)).not.toMatch(/score_list/);
    expect(integrationRulesText(DEFAULT_INTEGRATIONS)).toMatch(/score_list tool \(Jev\)/);
  });

  it("shows the CSV a tool actually saved as a file in the chat, and none when it failed", () => {
    const ev = { policy: ctx, mirrorRoot: "/drive/00 Tethr" };
    const call = (id: string) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", id, name: "mcp__tethr__score_list", input: { from_file: "ideas.csv", criteria: [], save_as: "spring scores" } }] },
      });
    const result = (id: string, text: string, isError = false) =>
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });

    const state = newTurnState();
    applyStreamLine(state, call("t1"), ev);
    expect(state.hops[0]).toMatchObject({ actorTag: "Tethr tools", decision: "Scoring ideas.csv with Jev" });
    expect(state.hops[0].file).toBeUndefined();
    // The name was taken, so the tool saved "spring scores (2).csv": the chip follows.
    applyStreamLine(state, result("t1", "Scored 3 of 3 items.\n\nAll rows: files/spring scores (2).csv\n[Saved file: files/spring scores (2).csv]"), ev);
    expect(state.hops[0]).toMatchObject({ status: "ok", file: "tethr/files/spring scores (2).csv" });

    // Jev not set up: an error result, no file, no chip.
    applyStreamLine(state, call("t2"), ev);
    applyStreamLine(state, result("t2", "Jev isn't set up in Tethr yet (no TYPESAFE_API_KEY), so nothing was scored.", true), ev);
    expect(state.hops[1]).toMatchObject({ status: "failed" });
    expect(state.hops[1].file).toBeUndefined();
  });
});

describe("tethr jev — MCP bridge", () => {
  let server: http.Server;
  let child: ChildProcess;
  let base = "";
  const seen: Array<{ url: string; auth: string; body: unknown }> = [];
  let out = "";
  const waiters = new Map<number, (msg: Record<string, unknown>) => void>();

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", auth: String(req.headers.authorization ?? ""), body: JSON.parse(raw || "{}") });
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/list")) res.end(JSON.stringify({ tools: [{ name: "score_list", description: "d", inputSchema: { type: "object" } }] }));
        else if (req.url?.endsWith("/call")) res.end(JSON.stringify({ content: [{ type: "text", text: "scored" }], isError: false }));
        else {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "boom" }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tethr-bridge-")), "bridge.mjs");
    fs.writeFileSync(file, BRIDGE_SOURCE);
    const cfg = buildMcpConfig({ nodePath: process.execPath, bridgeScript: file, token: "tok", url: base }).mcpServers.tethr;
    child = spawn(cfg.command, cfg.args, { env: cfg.env, stdio: ["pipe", "pipe", "inherit"] });
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      out += chunk;
      let i;
      while ((i = out.indexOf("\n")) >= 0) {
        const msg = JSON.parse(out.slice(0, i)) as Record<string, unknown>;
        out = out.slice(i + 1);
        waiters.get(msg.id as number)?.(msg);
      }
    });
  });

  afterAll(() => {
    child?.kill();
    server?.close();
  });

  const rpc = (id: number, method: string, params?: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      waiters.set(id, resolve);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  it("speaks MCP and forwards list and call with the turn token", async () => {
    const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "tethr" } });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await rpc(2, "tools/list");
    expect((list.result as { tools: Array<{ name: string }> }).tools[0].name).toBe("score_list");
    const call = await rpc(3, "tools/call", { name: "score_list", arguments: { items: ["a"] } });
    expect(call.result).toEqual({ content: [{ type: "text", text: "scored" }], isError: false });
    expect(seen.map((s) => s.url)).toEqual(["/api/tethr/assistant/tools/list", "/api/tethr/assistant/tools/call"]);
    expect(seen.every((s) => s.auth === "Bearer tok")).toBe(true);
    expect(seen[1].body).toEqual({ name: "score_list", arguments: { items: ["a"] } });
    const unknown = await rpc(4, "resources/list");
    expect((unknown.error as { code: number }).code).toBe(-32601);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("tethr jev — tools endpoint", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let app!: express.Express;
  let companyId!: string;
  let dir!: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-tools-route-"));
    process.env.TETHR_INTEGRATIONS_FILE = path.join(dir, "integrations.json");
    process.env.TETHR_WORKSPACE_DIR = path.join(dir, "workspace");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tethr-tools-");
    db = createDb(tempDb.connectionString);
    companyId = (await seedTethrCore(db)).companyId;
    const { tethrRoutes } = await import("../routes/tethr.ts");
    app = express();
    app.use(express.json());
    app.use("/api", tethrRoutes(db));
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("needs a live turn token, lists the tools and runs them", async () => {
    await request(app).post("/api/tethr/assistant/tools/list").expect(401);
    const token = issueHookToken({ companyId, threadId: "t", runId: "00000000-0000-4000-8000-000000000001" });
    const list = await request(app).post("/api/tethr/assistant/tools/list").set("authorization", `Bearer ${token}`).expect(200);
    expect(list.body.tools.map((t: { name: string }) => t.name)).toEqual(["score_list", "keyword_ideas", "goals_list", "save_goal", "save_metric", "record_metric", "make_document", "team_list", "create_agent", "assign_task", "update_agent", "memory", "growth_map", "map_area"]);
    delete process.env.TYPESAFE_API_KEY;
    const call = await request(app)
      .post("/api/tethr/assistant/tools/call")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "score_list", arguments: { items: ["a"], criteria: [{ question: "?", type: "yes_no" }] } })
      .expect(200);
    expect(call.body.isError).toBe(true);
    expect(call.body.content[0].text).toMatch(/Jev isn't set up/);
    // Read mode: the reads still run, the goal-saving tools don't, even called directly.
    await updateIntegrations(companyId, { connectors: { "Tethr tools": { mode: "read" } } });
    const readOnly = await request(app)
      .post("/api/tethr/assistant/tools/call")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "save_goal", arguments: { title: "Sneaky" } })
      .expect(200);
    expect(readOnly.body.isError).toBe(true);
    expect(readOnly.body.content[0].text).toMatch(/read-only/);
    const listGoals = await request(app).post("/api/tethr/assistant/tools/call").set("authorization", `Bearer ${token}`).send({ name: "goals_list", arguments: {} }).expect(200);
    expect(listGoals.body.isError).toBe(false);
    const unknown = await request(app).post("/api/tethr/assistant/tools/call").set("authorization", `Bearer ${token}`).send({ name: "drop_tables", arguments: {} }).expect(200);
    expect(unknown.body.isError).toBe(true);
    await updateIntegrations(companyId, { connectors: { "Tethr tools": { mode: "off" } } });
    const off = await request(app).post("/api/tethr/assistant/tools/call").set("authorization", `Bearer ${token}`).send({ name: "score_list", arguments: {} }).expect(200);
    expect(off.body.content[0].text).toMatch(/turned off/);
  });

  it("a one-off private turn (the Slack idea check) can only look things up", async () => {
    const token = issueHookToken({ companyId, threadId: "t", runId: "00000000-0000-4000-8000-000000000002", privateTurn: true });
    const list = await request(app).post("/api/tethr/assistant/tools/list").set("authorization", `Bearer ${token}`).expect(200);
    // Scoring, keyword ideas, reading goals and the team: yes. Saving goals, making documents'
    // siblings that change things, agents, tasks, memory: no.
    const names = list.body.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["goals_list", "team_list"]));
    for (const blocked of ["save_goal", "save_metric", "record_metric", "create_agent", "assign_task", "update_agent", "memory"]) {
      expect(names).not.toContain(blocked);
    }
    for (const [name, args] of [
      ["save_goal", { title: "Planted by a Slack message" }],
      ["assign_task", { agent: "@x", title: "Do something" }],
      ["memory", { target: "company", operations: [{ action: "add", content: "Planted." }] }],
    ] as const) {
      const call = await request(app).post("/api/tethr/assistant/tools/call").set("authorization", `Bearer ${token}`).send({ name, arguments: args }).expect(200);
      expect(call.body.isError).toBe(true);
      expect(call.body.content[0].text).toMatch(/isn't available in this one-off check/);
    }
  });
});
