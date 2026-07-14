#!/usr/bin/env node
// Tethr in the terminal — a Claude-Code-style client for the Tethr engine.
//
// Talk to @tethr from a shell instead of Slack:
//
//   node scripts/tethr-cli.mjs "what bugs do I need to fix?"   # one-shot
//   node scripts/tethr-cli.mjs                                  # REPL
//   node scripts/tethr-cli.mjs /queue                           # one-shot command
//
// A request routes through the SAME engine the Console and Slack use
// (@tethr -> classify -> the right agent -> tools -> gating); hops stream live,
// then the answer renders with a light markdown->ANSI pass. Zero dependencies —
// plain fetch + node:readline. No server, engine, or UI changes.
//
// SECURITY (this client adds no new privilege — it calls the same REST surface
// the UI uses; the real boundary is who can reach the port):
//   * Loopback is the safe default. `TETHR_URL` defaults to localhost; if it
//     points anywhere else the CLI prints a one-time remote-access warning
//     (in local_trusted mode anyone who can reach the port is an instance admin
//     — use Tailscale, never an untrusted LAN). See LOCAL.md.
//   * `TETHR_TOKEN` is read from the environment only (never a flag → never in
//     shell history), sent as a bearer token, and NEVER printed or logged.
//   * No state is written to disk — thread continuity lives in memory for the
//     REPL session only.
//   * Errors print status + a truncated body snippet, never request headers.
//   * `/approve` and `/reject` require an explicit queue index or id and echo
//     the item before applying — no blind or bulk mutation. The engine still
//     hard-gates medical/public/spend/pr behind approvals regardless.
//
// Env: TETHR_URL (default http://localhost:3100), TETHR_COMPANY_ID (optional —
// else auto-resolved), TETHR_TOKEN (optional, for `authenticated` mode).

import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ENV_URL = process.env.TETHR_URL?.trim().replace(/\/+$/, "") || null;
// When TETHR_URL is unset, probe the two local dev ports: :3100 (split `pnpm dev`
// / Docker / deploy) and :5173 (vite-middleware `pnpm dev`). Both are loopback,
// so this is purely a DX convenience — no security surface. An explicit
// TETHR_URL is always honored verbatim (and could be a remote/Tailscale host).
const LOCAL_CANDIDATES = ["http://localhost:3100", "http://localhost:5173"];
let BASE_URL = ENV_URL ?? LOCAL_CANDIDATES[0];
const TOKEN = process.env.TETHR_TOKEN?.trim() || null;
const ENV_COMPANY_ID = process.env.TETHR_COMPANY_ID?.trim() || null;

const FETCH_TIMEOUT_MS = 20_000; // per request
const POLL_INTERVAL_MS = 600; // matches the Console's live poll
const POLL_MAX_MS = 3 * 60_000; // hard wall-clock cap on a single run
const TERMINAL_STATUSES = new Set(["done", "gated", "failed"]);

// ---------------------------------------------------------------------------
// ANSI (degrades to plain text when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------

const COLOR = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const wrap = (code) => (s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = wrap("1");
const dim = wrap("2");
const underline = wrap("4");
const invert = wrap("7");

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests — no I/O, no color by default)
// ---------------------------------------------------------------------------

/** Is this URL a loopback address? Non-loopback => a remote instance (warn). */
export function isLoopbackUrl(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

/** Strip a bearer token from any string before it could ever be printed. */
export function redactToken(text, token) {
  if (!token) return text;
  return String(text).split(token).join("[redacted]");
}

export function truncate(text, n) {
  const s = String(text ?? "");
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Parse a REPL line into a slash command, or null if it's a plain message. */
export function parseCommand(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  const [head, ...rest] = trimmed.slice(1).split(/\s+/);
  return { name: head.toLowerCase(), args: rest, arg: rest[0] ?? null, note: rest.slice(1).join(" ") || null };
}

/** One hop -> a single mono line. `route`/`agent`/`subagent`/`tool` glyphs. */
export function formatHop(hop, { color = false } = {}) {
  const paint = color ? { d: dim, b: bold } : { d: (s) => s, b: (s) => s };
  const glyph =
    hop.layer === "tool"
      ? "·  ·"
      : hop.layer === "subagent"
        ? "·  →"
        : hop.layer === "agent"
          ? " →"
          : "▸"; // helm/router
  const tag = hop.actorTag ? paint.b(hop.actorTag) : "";
  const decision = hop.decision ? ` ${hop.decision}` : "";
  const reason = hop.reason ? paint.d(` — ${truncate(hop.reason, 88)}`) : "";
  return `  ${paint.d(glyph)} ${tag}${decision}${reason}`.replace(/\s+$/, "");
}

/**
 * Light markdown -> terminal. With `color`, wraps in ANSI; without, strips the
 * markers to clean plain text (this is the mode the tests assert on).
 */
export function renderMarkdown(md, { color = false } = {}) {
  const lines = String(md ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    const fence = line.match(/^\s*```/);
    if (fence) {
      inFence = !inFence;
      continue; // drop the fence markers themselves
    }
    if (inFence) {
      out.push(color ? dim(`  ${line}`) : `  ${line}`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const text = renderInline(heading[2], color);
      out.push(color ? bold(text) : text);
      continue;
    }
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${renderInline(bullet[2], color)}`);
      continue;
    }
    out.push(renderInline(line, color));
  }
  return out.join("\n");
}

/** Inline markdown: **bold**, `code`, [text](url). */
function renderInline(text, color) {
  let s = String(text ?? "");
  // Links: [text](url) -> "text (url)"
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, t, u) => `${t} (${u})`);
  // Bold: **x** / __x__
  s = s.replace(/(\*\*|__)(.+?)\1/g, (_m, _d, t) => (color ? bold(t) : t));
  // Inline code: `x`
  s = s.replace(/`([^`]+)`/g, (_m, t) => (color ? invert(` ${t} `) : t));
  return s;
}

// ---------------------------------------------------------------------------
// HTTP (auth header applied here; token never leaves this function's inputs)
// ---------------------------------------------------------------------------

async function api(path, { method = "GET", body } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err?.name === "TimeoutError" ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : err?.message;
    throw new ApiError(`Cannot reach Tethr at ${BASE_URL} (${redactToken(reason ?? "network error", TOKEN)})`, 0);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.error ?? truncate(text, 200) ?? res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new ApiError(
        `${res.status} — the server needs auth. Set TETHR_TOKEN to a board API key (see LOCAL.md).`,
        res.status,
      );
    }
    throw new ApiError(redactToken(String(detail), TOKEN), res.status);
  }
  return data;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Company resolution
// ---------------------------------------------------------------------------

/** Pick a reachable local port when TETHR_URL is unset (loopback probe only). */
async function resolveBaseUrl() {
  if (ENV_URL) {
    BASE_URL = ENV_URL;
    return;
  }
  for (const candidate of LOCAL_CANDIDATES) {
    try {
      const res = await fetch(`${candidate}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        BASE_URL = candidate;
        return;
      }
    } catch {
      // try the next candidate
    }
  }
  BASE_URL = LOCAL_CANDIDATES[0]; // fall back; the next call surfaces a clear error
}

async function resolveCompany() {
  if (ENV_COMPANY_ID) return { id: ENV_COMPANY_ID, name: null };
  const companies = await api("/api/companies");
  if (!Array.isArray(companies) || companies.length === 0) {
    throw new ApiError("No companies found on this instance. Is the dev stack seeded?", 0);
  }
  // Prefer the clean-slate default (Wandr / @tethr) then any Wandr, then single.
  const exact = companies.find((c) => c.name === "Wandr");
  const wandr = exact ?? companies.find((c) => /wandr/i.test(c.name ?? ""));
  const chosen = wandr ?? companies[0];
  return { id: chosen.id, name: chosen.name ?? null, ambiguous: !wandr && companies.length > 1 };
}

// ---------------------------------------------------------------------------
// Run a request through the engine, streaming hops
// ---------------------------------------------------------------------------

async function runRequest(companyId, text, threadId) {
  const started = await api(`/api/tethr/${companyId}/route`, {
    method: "POST",
    body: { request: text, threadId: threadId ?? undefined },
  });
  const runId = started.routeRunId;
  const nextThreadId = started.threadId ?? threadId ?? null;

  stdout.write(dim("  · routing…\n"));

  let printed = 0;
  const deadline = Date.now() + POLL_MAX_MS;
  let run = null;
  while (Date.now() < deadline) {
    run = await api(`/api/tethr/${companyId}/route-runs/${runId}`);
    const hops = Array.isArray(run.hops) ? run.hops : [];
    for (const hop of hops.slice(printed)) stdout.write(`${formatHop(hop, { color: COLOR })}\n`);
    printed = hops.length;
    if (TERMINAL_STATUSES.has(run.status)) break;
    await sleep(POLL_INTERVAL_MS);
  }

  if (!run || !TERMINAL_STATUSES.has(run.status)) {
    stdout.write(dim(`\n  (still working after ${POLL_MAX_MS / 1000}s — check /runs later, run ${short(runId)})\n`));
    return { threadId: nextThreadId, ok: false };
  }

  stdout.write("\n");
  if (run.status === "failed") {
    stderr.write(`${bold("Failed:")} ${redactToken(run.error ?? "unknown error", TOKEN)}\n`);
    return { threadId: nextThreadId, ok: false };
  }

  const answer = (run.resultText ?? "").trim();
  if (answer) stdout.write(`${renderMarkdown(answer, { color: COLOR })}\n`);

  const gated = (Array.isArray(run.outputs) ? run.outputs : []).filter((o) => o.status === "gated");
  if (gated.length) {
    stdout.write(dim(`\n  ${gated.length} item(s) staged for approval — /queue to review:\n`));
    for (const o of gated) {
      stdout.write(dim(`    · ${o.title ?? o.kind} [${o.sensitivity}] ${short(o.id)}\n`));
    }
  }
  const footer = [run.agentId ? null : null, run.durationMs ? `${run.durationMs}ms` : null, run.llmProvider]
    .filter(Boolean)
    .join(" · ");
  if (footer) stdout.write(dim(`  · ${footer}\n`));
  return { threadId: nextThreadId, ok: true };
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

async function cmdQueue(ctx) {
  const outputs = await api(`/api/tethr/${ctx.companyId}/outputs?status=gated`);
  ctx.queue = Array.isArray(outputs) ? outputs : [];
  if (!ctx.queue.length) {
    stdout.write(dim("  Queue is empty — nothing awaiting approval.\n"));
    return;
  }
  stdout.write(bold(`  Queue — ${ctx.queue.length} awaiting approval\n`));
  ctx.queue.forEach((o, i) => {
    stdout.write(
      `  ${bold(String(i + 1))}. ${o.title ?? o.kind} ${dim(`[${o.sensitivity}·${o.kind}]`)} ${dim(short(o.id))}\n`,
    );
    if (o.preview) stdout.write(dim(`     ${truncate(o.preview.replace(/\s+/g, " "), 96)}\n`));
  });
  stdout.write(dim("  Decide with /approve <n> [note] or /reject <n> [note].\n"));
}

async function cmdDecide(ctx, decision, ref, note) {
  if (!ref) {
    stderr.write(dim(`  Usage: /${decision === "approve" ? "approve" : "reject"} <n|id> [note]\n`));
    return;
  }
  // Resolve a queue index (from the last /queue) or a raw id.
  let id = ref;
  const asIndex = Number(ref);
  if (Number.isInteger(asIndex) && asIndex >= 1 && ctx.queue[asIndex - 1]) {
    id = ctx.queue[asIndex - 1].id;
  }
  // Show what we're about to decide (never blind).
  let output;
  try {
    output = await api(`/api/tethr/${ctx.companyId}/outputs/${id}`);
  } catch (err) {
    stderr.write(`  ${err.message}\n`);
    return;
  }
  const label = `${output.title ?? output.kind} [${output.sensitivity}·${output.kind}]`;
  stdout.write(dim(`  ${decision === "approve" ? "Approving" : "Rejecting"}: ${label} ${short(id)}\n`));
  try {
    await api(`/api/tethr/${ctx.companyId}/outputs/${id}/decide`, {
      method: "POST",
      body: { decision, note: note || undefined },
    });
    stdout.write(bold(`  ${decision === "approve" ? "Approved" : "Rejected"}.`) + dim(" (refresh /queue)\n"));
  } catch (err) {
    stderr.write(`  Could not ${decision}: ${err.message}\n`);
  }
}

async function cmdAgents(ctx) {
  const data = await api(`/api/tethr/${ctx.companyId}/overview`);
  const agents = Array.isArray(data.agents) ? data.agents : [];
  stdout.write(bold(`  Agents — ${agents.length}\n`));
  for (const a of agents) {
    const ag = a.agent ?? {};
    const spend = ag.budgetMonthlyCents
      ? ` ${dim(`$${((ag.spentMonthlyCents ?? 0) / 100).toFixed(2)}/$${(ag.budgetMonthlyCents / 100).toFixed(0)}`)}`
      : "";
    const pending = a.pendingApprovals ? ` ${bold(`${a.pendingApprovals} pending`)}` : "";
    const status = ag.status === "active" ? ag.status : dim(ag.status ?? "");
    stdout.write(`  ${bold(ag.name ?? "?")} ${dim(ag.title ?? "")} · ${status}${spend}${pending}\n`);
  }
}

async function cmdStatus(ctx) {
  const s = await api(`/api/tethr/${ctx.companyId}/status`);
  stdout.write(bold("  Status\n"));
  stdout.write(`  llm    ${s.llm?.mode ?? "?"} · ${s.llm?.provider ?? "?"} · ${s.llm?.model ?? "?"}\n`);
  stdout.write(`  mirror ${s.mirror?.enabled ? `on · ${s.mirror.dir}` : "off"}\n`);
  stdout.write(dim(`  url    ${BASE_URL}${isLoopbackUrl(BASE_URL) ? "" : "  (remote)"}\n`));
}

async function cmdRuns(ctx) {
  const runs = await api(`/api/tethr/${ctx.companyId}/route-runs?limit=10`);
  const list = Array.isArray(runs) ? runs : [];
  stdout.write(bold(`  Recent runs — ${list.length}\n`));
  for (const r of list) {
    const st = r.status === "failed" ? bold("failed") : dim(r.status);
    stdout.write(`  ${dim(short(r.id))} ${st}  ${truncate((r.requestText ?? "").replace(/\s+/g, " "), 70)}\n`);
  }
}

function cmdHelp() {
  stdout.write(
    [
      bold("  Tethr terminal client"),
      "  Type a message to route it through @tethr. Commands:",
      `    ${bold("/queue")}                 items awaiting approval`,
      `    ${bold("/approve")} <n|id> [note]  approve a queued item`,
      `    ${bold("/reject")}  <n|id> [note]  reject a queued item`,
      `    ${bold("/agents")}                the org roster + spend`,
      `    ${bold("/status")}                llm mode/model + mirror`,
      `    ${bold("/runs")}                  the last 10 runs`,
      `    ${bold("/new")}                   start a fresh conversation thread`,
      `    ${bold("/help")}   ${bold("/exit")}`,
      "",
    ].join("\n") + "\n",
  );
}

async function dispatchCommand(ctx, cmd) {
  switch (cmd.name) {
    case "queue":
    case "q":
      return cmdQueue(ctx);
    case "approve":
    case "a":
      return cmdDecide(ctx, "approve", cmd.arg, cmd.note);
    case "reject":
    case "r":
      return cmdDecide(ctx, "reject", cmd.arg, cmd.note);
    case "agents":
      return cmdAgents(ctx);
    case "status":
      return cmdStatus(ctx);
    case "runs":
      return cmdRuns(ctx);
    case "new":
      ctx.threadId = null;
      stdout.write(dim("  New thread.\n"));
      return;
    case "help":
    case "h":
    case "?":
      return cmdHelp();
    case "exit":
    case "quit":
      ctx.done = true;
      return;
    default:
      stderr.write(dim(`  Unknown command /${cmd.name} — /help for the list.\n`));
  }
}

// ---------------------------------------------------------------------------
// REPL + one-shot
// ---------------------------------------------------------------------------

function printHeader(company) {
  const name = company.name ? `${company.name}` : short(company.id);
  stdout.write(`${bold("tethr")} ${dim("·")} ${name} ${dim("·")} ${dim(BASE_URL)}\n`);
  if (company.ambiguous) {
    stdout.write(dim("  (multiple companies — set TETHR_COMPANY_ID to pin one)\n"));
  }
  if (!isLoopbackUrl(BASE_URL)) {
    stdout.write(
      bold("  ⚠ remote instance: ") +
        "anyone who can reach this port is an admin in local_trusted mode.\n" +
        dim("    Use Tailscale, never an untrusted LAN. See LOCAL.md.\n"),
    );
  }
}

async function repl(ctx) {
  cmdHelp();
  const rl = createInterface({ input: stdin, output: stdout });
  while (!ctx.done) {
    let line;
    try {
      line = await rl.question(`${bold("@tethr")} ${dim("›")} `);
    } catch {
      break; // Ctrl-D / stream closed
    }
    const text = line.trim();
    if (!text) continue;
    const cmd = parseCommand(text);
    try {
      if (cmd) {
        await dispatchCommand(ctx, cmd);
      } else {
        const { threadId } = await runRequest(ctx.companyId, text, ctx.threadId);
        ctx.threadId = threadId;
      }
    } catch (err) {
      stderr.write(`  ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  rl.close();
  stdout.write(dim("  bye.\n"));
}

async function oneShot(ctx, input) {
  const cmd = parseCommand(input);
  if (cmd) {
    await dispatchCommand(ctx, cmd);
    return 0;
  }
  const { ok } = await runRequest(ctx.companyId, input, null);
  return ok ? 0 : 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (id) => (id ? String(id).slice(0, 8) : "");

async function main() {
  const input = process.argv.slice(2).join(" ").trim();
  await resolveBaseUrl();
  let company;
  try {
    company = await resolveCompany();
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  const ctx = { companyId: company.id, threadId: null, queue: [], done: false };
  printHeader(company);

  if (input) {
    const code = await oneShot(ctx, input).catch((err) => {
      stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    });
    process.exit(code);
  }
  await repl(ctx);
  process.exit(0);
}

// Only launch when run directly — importing for tests must not start the REPL.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
