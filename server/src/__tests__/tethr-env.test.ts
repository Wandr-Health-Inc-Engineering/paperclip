import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { parse } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteEnv, formatEnvValue, listEnv, parseEnvExample, readEnvValue, setEnv } from "../tethr/env-file.ts";
import { classify, isPrivateHost } from "../tethr/assistant/policy.ts";

// Phase 19.2: the Environment page — the instance .env, edited like a hosting
// dashboard's environment variables.

let dir!: string;
let file!: string;
const ORIGINAL = `# Tethr settings
ANTHROPIC_API_KEY=sk-old
# Jev
TYPESAFE_API_KEY=

PAPERCLIP_PUBLIC_URL=http://localhost:3100
DUP=one
DUP=two
`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tethr-env-"));
  file = path.join(dir, ".env");
  fs.writeFileSync(file, ORIGINAL);
  process.env.TETHR_ENV_FILE = file;
});

afterEach(() => {
  delete process.env.TETHR_ENV_FILE;
  for (const k of ["TETHR_TEST_NEW", "TYPESAFE_API_KEY", "DUP", "QUOTED"]) delete process.env[k];
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tethr env — the .env file", () => {
  it("lists names and status, never values", async () => {
    const env = await listEnv();
    expect(env.path).toBe(file);
    expect(env.entries.map((e) => e.key)).toEqual(["ANTHROPIC_API_KEY", "TYPESAFE_API_KEY", "PAPERCLIP_PUBLIC_URL", "DUP"]);
    expect(env.entries[0]).toMatchObject({ set: true, length: 6, secret: true, core: false });
    expect(env.entries[1]).toMatchObject({ set: false, secret: true });
    expect(env.entries[2]).toMatchObject({ core: true, secret: false });
    expect(JSON.stringify(env)).not.toContain("sk-old");
    expect(await readEnvValue("ANTHROPIC_API_KEY")).toBe("sk-old");
    expect(await readEnvValue("NOPE")).toBeNull();
    expect(await readEnvValue("../etc")).toBeNull();
  });

  it("replaces in place, keeps every other line, and applies to the running server", async () => {
    expect(await setEnv("TYPESAFE_API_KEY", "ts_live_123")).toEqual({ ok: true });
    expect(await setEnv("TETHR_TEST_NEW", "hello world")).toEqual({ ok: true });
    expect(await setEnv("DUP", "three")).toEqual({ ok: true });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# Tethr settings\nANTHROPIC_API_KEY=sk-old\n# Jev\nTYPESAFE_API_KEY=ts_live_123\n");
    expect(text.match(/^DUP=/gm)).toHaveLength(1); // a later duplicate would have overridden the edit
    expect(parse(text)).toMatchObject({ TYPESAFE_API_KEY: "ts_live_123", TETHR_TEST_NEW: "hello world", DUP: "three" });
    expect(process.env.TYPESAFE_API_KEY).toBe("ts_live_123");
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe("600");
    expect((await listEnv()).entries.find((e) => e.key === "TYPESAFE_API_KEY")?.active).toBe(true);
  });

  it("writes any single-line value so dotenv reads it back exactly", async () => {
    for (const v of ["plain-token_1.2:3/4@x+y=z", "has spaces # and hash", "it's", "a'b`c", "", 'x="y"']) {
      expect(await setEnv("QUOTED", v)).toEqual({ ok: true });
      expect(parse(fs.readFileSync(file, "utf8")).QUOTED).toBe(v);
    }
    expect(formatEnvValue("two\nlines")).toMatchObject({ error: expect.stringMatching(/single line/) });
    expect(formatEnvValue(`a'b"c\`d`)).toMatchObject({ error: expect.any(String) });
    expect(await setEnv("1BAD", "x")).toMatchObject({ error: expect.any(String) });
    expect(await setEnv("BAD-NAME", "x")).toMatchObject({ error: expect.any(String) });
  });

  it("removes a key from the file and the running server", async () => {
    process.env.DUP = "two";
    expect(await deleteEnv("DUP")).toEqual({ ok: true });
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/^DUP=/m);
    expect(process.env.DUP).toBeUndefined();
    expect(await deleteEnv("DUP")).toMatchObject({ error: expect.stringMatching(/isn't in the file/) });
  });

  it("reads the known settings and their notes from .env.example", () => {
    const s = parseEnvExample(`# ---- Tethr ----
# Live Claude calls
ANTHROPIC_API_KEY=
# The work model
TETHR_CLAUDE_MODEL=

# Claude Code models. Defaults: sonnet / haiku.
TETHR_CLAUDE_CODE_MODEL=
TETHR_CLAUDE_CODE_FAST_MODEL=
`);
    expect(s).toEqual([
      { key: "ANTHROPIC_API_KEY", description: "Live Claude calls" },
      { key: "TETHR_CLAUDE_MODEL", description: "The work model" },
      { key: "TETHR_CLAUDE_CODE_MODEL", description: "Claude Code models. Defaults: sonnet / haiku." },
      { key: "TETHR_CLAUDE_CODE_FAST_MODEL", description: "Claude Code models. Defaults: sonnet / haiku." },
    ]);
  });
});

describe("tethr env — routes", () => {
  const appFor = async (actor: Record<string, unknown>) => {
    const { tethrRoutes } = await import("../routes/tethr.ts");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    // The env routes only touch the file (and a best-effort activity log).
    app.use("/api", tethrRoutes({} as never));
    return app;
  };
  const company = "11111111-1111-4111-8111-111111111111";
  const admin = { type: "board", source: "local_implicit", userId: "mark", isInstanceAdmin: true };

  it("is for instance admins only, lists without values, and reveals on POST", async () => {
    const app = await appFor(admin);
    const list = await request(app).get(`/api/tethr/${company}/env`).expect(200);
    expect(list.body.entries.map((e: { key: string }) => e.key)).toContain("ANTHROPIC_API_KEY");
    expect(JSON.stringify(list.body)).not.toContain("sk-old");
    const reveal = await request(app).post(`/api/tethr/${company}/env/reveal`).send({ key: "ANTHROPIC_API_KEY" }).expect(200);
    expect(reveal.body.value).toBe("sk-old");
    expect(reveal.headers["cache-control"]).toBe("no-store");
    await request(app).put(`/api/tethr/${company}/env`).send({ key: "TETHR_TEST_NEW", value: "v1" }).expect(200);
    expect(parse(fs.readFileSync(file, "utf8")).TETHR_TEST_NEW).toBe("v1");
    await request(app).put(`/api/tethr/${company}/env`).send({ key: "bad key", value: "v" }).expect(400);
    await request(app).delete(`/api/tethr/${company}/env/TETHR_TEST_NEW`).expect(200);

    const member = await appFor({ type: "board", source: "session", userId: "u2", isInstanceAdmin: false });
    await request(member).get(`/api/tethr/${company}/env`).expect(403);
    const agent = await appFor({ type: "agent", agentId: "a1", companyId: company });
    await request(agent).post(`/api/tethr/${company}/env/reveal`).send({ key: "ANTHROPIC_API_KEY" }).expect(403);
  });

  it("refuses to seed for anyone but an instance admin", async () => {
    // Refused before the database is touched (the app has none here).
    for (const actor of [
      { type: "none" },
      { type: "board", source: "session", userId: "u2", isInstanceAdmin: false },
      { type: "agent", agentId: "a1", companyId: company },
    ]) {
      const app = await appFor(actor);
      await request(app).post("/api/tethr/seed").send({ org: "growth" }).expect(403);
      await request(app).post("/api/tethr/seed").send({}).expect(403);
    }
  });
});

describe("tethr chat — no pages on this Mac or its network", () => {
  const ctx = { workspaceDir: "/w", readableRoots: ["/w"], internalAddresses: ["travelwithwandr.com"] };

  it("blocks WebFetch to loopback and private hosts, allows the public web", () => {
    for (const url of [
      "http://localhost:3100/api/tethr/x/env",
      "http://127.0.0.1:3100/api/health",
      "http://2130706433/",
      "http://[::1]:3100/",
      "http://10.0.0.5/",
      "http://192.168.1.20/",
      "http://169.254.169.254/latest/meta-data",
      "http://printer.local/",
      "not a url",
    ]) {
      expect(classify("WebFetch", { url, prompt: "p" }, ctx).cls, url).toBe("blocked");
    }
    expect(classify("WebFetch", { url: "https://example.com/a", prompt: "p" }, ctx).cls).toBe("web");
    expect(isPrivateHost("172.20.1.1")).toBe(true);
    expect(isPrivateHost("172.32.1.1")).toBe(false);
    expect(isPrivateHost("fcbarcelona.com")).toBe(false);
    expect(isPrivateHost("100.100.1.1")).toBe(true); // Tailscale
  });
});
