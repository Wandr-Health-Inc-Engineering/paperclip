# CLAUDE.md — Tethr on Paperclip

Guidance for Claude Code (and any agent) working in this repo. Read this first, every
session. It is the operating contract for the **Tethr buildout**; the phase-by-phase plan
lives in `docs/tethr-buildout/`.

---

## What this repo is

This is **Mark's fork of [Paperclip](https://github.com/paperclipai/paperclip)**, and
**Tethr is a product built inside it the way Chrome is built on Chromium** (see
`ARCHITECTURE-LOCAL.md`). Paperclip core is the engine — companies, agents, heartbeats,
routines (cron), approvals, budget policies, cost events, activity log, storage service.
Tethr is Wandr Health's marketing/distribution operator, layered on top **through the
engine's own seams**, never by forking the engine.

- `origin` = `github.com/Wandr-Health-Inc-Engineering/paperclip` (Wandr fork). Work branch: `mark-sandbox`; the buildout branch is `tethr-buildout` (off `mark-sandbox`).
- `upstream` = `github.com/paperclipai/paperclip` (the public project). We merge *from* it; we never push *to* it.
- Tethr V1 (12 phases) + V2 (6 phases) are **already built and complete** (2026-06-12). The buildout in `docs/tethr-buildout/` is deployment + live integrations + laptop migration on top of that — not a rebuild. Read `docs/tethr-buildout/00-current-state-and-gap-analysis.md` for what already exists.

### Layer map (from ARCHITECTURE-LOCAL.md)

```
Layer 3  Content   Wandr company (seeded): ONE agent — Tethr (@tethr), the coordinator
Layer 2  Tethr     server/src/tethr/** — routing, gating, drive, memory, notify, llm, seed, tools
Layer 1  Shell     ui/src/pages/tethr/** — Console, Company, Queue, Drive, Runs, Budgets, Audit, Memory, Settings, AgentPage
Layer 0  Paperclip untouched engine (heartbeats, routines, approvals, budgets, costs, storage)
```

**Phase 11 clean slate (2026-07-11, Mark's call — 12 agents were overwhelming to manage):**
the default org is now company **Wandr** (prefix `WD`) with a single agent, **Tethr**
(`@tethr`) — the orchestrator / AI chat / coordinator. Tag `@tethr` on Slack, DM the bot, or
use the Console chat: every request lands on Tethr (`@tethr.chat` answers directly,
`@tethr.plan` drafts internal briefs to the Drive). Specialists get re-added one at a time as
rows in Tethr's routing table. Seed: `seed/tethr-core.ts`. Router resolution:
`org.getRouterProfile` — `@tethr` first, `@helm` legacy fallback. Slack answers now post back
into the originating thread/DM.

The old **Wandr Growth** org (CEO → Helm → Atlas/Compass/Voyager/Sonar/Tailwind/Ledger/
Herald/Beacon + Sentry/Pulse, 22 subagents, 4 divisions) is **archived on first boot, never
deleted** — the parts bin for re-adds. Its seed stays in `seed/seed.ts`/`wandr-growth.ts`
(`POST /api/tethr/seed {"org":"growth"}`), its tests still run against it, and all tool/check
code (Sentry, Pulse, Google Ads, Keyword Planner) stays live and allowlisted.

### AI organization — the CEO + the conductor (phase 12, Mark's model 2026-07-12)

"Run like Paperclip intended" = an org, not one chatbot. Mark's shape (his exact call):

- **@tethr = the conductor (Jarvis).** `reportsTo: null`, a SEPARATE root — the
  communicator/manager between the human team and the agents, off to the side, NOT in the
  command chain. Its title/mission were reframed to "Conductor — the interface between the team
  and the agents." Still the router (`getRouterProfile`).
- **CEO (`@ceo`, codename "CEO") = head of the AGENT org.** `reportsTo: null` too (a second
  root, tier 0). Holds the mission, sets priorities, delegates; specialists report up to IT.
  Real agent (not the old hollow placeholder): `@ceo.plan` subagent drafts a priorities brief
  (internal → Drive), $25/mo hard-stop, daily 8 AM planning heartbeat **seeded PAUSED**.
  Seed: `seed/ceo.ts` `seedCeoAgent(db, companyId)` — additive + idempotent, run from
  `maybeAutoSeed` (fills the live org on boot) and the default `/seed` endpoint. It also adds a
  `@ceo` routing row to @tethr. Rendered in the tier-0 banner on the Company page (divisionId
  null; the banner's old hardcoded "placeholder" label is gone). Tests: `tethr-ceo.test.ts`.
- **Specialists** report to the CEO. Add one at a time, each seeded paused, each a row in
  @tethr's routing table. First one: **Radar** (@radar, market research) — born via the
  factory. (Journal, the blog writer, is deferred: Mark decided rerouting his existing
  Claude blog flow into Tethr isn't cost-efficient; the org does NET-NEW work instead.)
- **Factory tool grants are real (2026-07-13 fix).** A created agent's tools used to be
  dropped on the floor — `tethr_subagents` had no `tools` column and `toolsetForSubagent`
  read a static code allowlist that never listed factory agents, so every CEO-created agent
  got baseline-only (drive/memory/escalate) and could never fetch. Now: `tethr_subagents.tools`
  (migration **0093**, nullable jsonb) holds the authoritative grant; the factory persists
  `spec.tools` per subagent; `toolsetForSubagent` prefers the DB grant (NULL = fall back to the
  static allowlist for the built-in agents). `seed/backfill-tools.ts` heals pre-0093 factory
  agents (identified by their `tethr-factory` budget-policy author) with a read-only research
  default (`web_fetch,reddit_scan,cdc_scan,keyword_ideas`), run from `maybeAutoSeed` + `/seed`.
  Locked by `tethr-agent-tools.test.ts` + factory tests.
- **CDC is a 403 wall — use `cdc_scan`, not `web_fetch` on www.cdc.gov (2026-07-13).**
  `www.cdc.gov` (Akamai) 403s every server-side GET regardless of user-agent, so direct
  fetches always dead-ended. `web_fetch` now short-circuits known bot-walled hosts with an
  actionable redirect (no more "proceed with what you know" — that invited fabrication), and
  `cdc_scan` merges two *fetchable* feeds: CDC travel notices (`wwwnc.cdc.gov` RSS) + WHO
  Disease Outbreak News (`who.int` OData JSON), fixture fallback only if both fail.
- **Tinkr (`@tinkr`) = the org mechanic** (phase 12, Mark's spec — "Tinkr" no e). Modifies
  existing agents: rename / title+mission / budget / subagent spec / pause-resume /
  schedule. Reached ONLY via @tethr routing (no Tinkr Slack bot). Every change is staged by
  the `stage_org_change` tool (granted solely to `@tinkr.change`) as a gated `org_change`
  output (`org` sensitivity gates) → Queue + Slack → approving APPLIES it
  (`gating.approveOrgChange` → `org-changes.ts` `applyOrgChange`) and logs it in
  **`tethr_org_changes`** (migration 0092) with before/after. **Revert is git-style**: the
  Company-page change log's Revert button (`POST /org-changes/:id/revert`) stages the
  INVERSE change through the same gate; history is append-only. Guardrails: @tethr/@ceo/
  @tinkr can't be renamed/paused; $100/mo budget ceiling; no create/delete. Rename cascades
  tag everywhere (profile, subagent tags, adapterConfig, all routing tables). Seed:
  `seed/tinkr.ts` ($10/mo cap, no heartbeat, reports to CEO). Tests: `tethr-tinkr.test.ts`.
- **Patch (`@patch`) = the debug agent** (phase 12, Mark's spec 2026-07-13, name "Patch").
  Tag `@tethr` when something breaks; Tethr routes to Patch. It reads the failure log via the
  **`read_failures`** tool (recent `tethr_route_runs` where status=failed or error set — request +
  error + last hops; **DB only, no filesystem, company-scoped**; granted ONLY to `@patch.diagnose`),
  diagnoses the root cause, and writes a **Claude-Code-ready fix report** (what broke · likely
  file/cause · paste-ready prompt · any human step) into the shared workspace under `07 Debug/`
  (via the `[file-under: 07 Debug]` directive). Read-only — it never applies a fix. Reports are
  `internal` → auto-publish (no gate). Seed: `seed/patch.ts` (@patch reports to CEO, $10/mo cap,
  **no heartbeat**, on-request only; @tethr routing row for error/broke/failed/debug keywords).
  Wired into `maybeAutoSeed` + `/seed`. Tests: `tethr-patch.test.ts`. `KIND_BY_SUBAGENT_KEY.diagnose
  = "document"`.
- **Slack images (2026-07-13 fix):** every inbound Slack image is normalized through **sharp**
  (`fetchSlackImageAttachments` in slack.ts) — decode + EXIF-rotate + resize ≤1568px + re-encode
  JPEG — so iPhone HEIC and oversized photos work, and a non-image (a Slack login page returned
  when the bot lacks the `files:read` scope) throws in sharp and is dropped with an actionable log
  instead of 400-ing the whole request. Accepted mimetype widened to `image/*` (sharp is the
  gatekeeper). **Manual gate: the Slack app needs the `files:read` scope** or image downloads
  return HTML.
- **Slack formatting:** outbound answers pass through `toSlackMrkdwn` (slack.ts) — GFM
  headers/bold/tables/links → Slack mrkdwn (tables become labeled bullets). Never post raw
  `##`/`**`/pipes again.

## Where the Tethr layer lives (all additive)

- `server/src/tethr/**` — the whole L2 engine: `routing.ts`, `worker.ts`, `gating.ts`, `drive.ts`, `org.ts`, `memory.ts`, `notify.ts`, `digest.ts`, `state.ts`, `export.ts`, `adapter.ts`, `index.ts`, plus `llm/` (mock ↔ claude), `tools/` (allowlisted registry), `seed/` (`wandr-growth.ts`).
- `server/src/routes/tethr.ts` — the Tethr REST surface. (`routes/health.ts` = the existing `/health` + `/api/health` health endpoints — reuse, don't add another.)
- `ui/src/pages/tethr/**` + `ui/src/components/tethr/**` — the 10 pages.
- `packages/db/src/schema/tethr_*.ts` — 8 tables (`tethr_divisions`, `tethr_agent_profiles`, `tethr_subagents`, `tethr_route_runs`, `tethr_outputs`, `tethr_drive*`, `tethr_memories`, `tethr_notifications`). Migrations through **0094**.

## Merge-safe rule (non-negotiable)

**Add files; don't edit core.** New Tethr behavior goes in the paths above. If a core
(non-`tethr`) file *must* change, keep it a one-liner and **log it in `DECISIONS.md`**
under "Core changes (keep merge-safe)". As of 2026-06-12: 12 core files / ~231 lines
touched; the one substantive fix (company `remove()` FK ordering) is upstreamable. Keep
that list short.

## How to run

```bash
pnpm install        # once
pnpm dev            # server :3100 + UI :5173, embedded Postgres, auto-migrate, auto-seed
```

First boot auto-seeds the clean-slate org: **Wandr** (prefix `WD`) — one agent, **Tethr**
(`@tethr`), with `chat` + `plan` subagents, an Operations division, budgets ($100/mo company
line, $25/mo Tethr cap, hard-stop on) and a Drive README; any existing "Wandr Growth" org is
archived (recoverable), never deleted. No Docker / external DB / API key needed: embedded
Postgres + deterministic **mock LLM** out of the box. Docker path: `make compose-up` (Postgres 17 + server + bundled
UI on :3100). Re-seed (idempotent): `curl -X POST http://localhost:3100/api/tethr/seed -d '{}' -H 'content-type: application/json'`.

**Dev env is loaded from the Paperclip instance dir, not repo `.env`:**
`~/.paperclip/instances/default/.env` (holds `TETHR_BUNDLE_PATH`, `TETHR_LIVE_FETCH`, etc.).

### Env knobs (`.env.example` lists all)

| Var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | swaps every agent from mock → live Claude (`llm/claude.ts`, plain fetch) |
| `TETHR_CLAUDE_MODEL` | the "work" model — chat answers, plans, drafts, vision (default `claude-sonnet-5`) |
| `TETHR_CLAUDE_FAST_MODEL` | the cheap routing model — classify/plan hops (default `claude-haiku-4-5`) |
| `TETHR_LIVE_FETCH=true` | enables real read-only CDC/web fetches via allowlisted tools (Reddit falls back to fixtures — blocks unauth) |
| `TETHR_AUTO_REVISE=false` | turn off auto-revision on "request changes" |
| `TETHR_BUNDLE_PATH` | path to the `/tethr` spec bundle; seeder imports real agent markdown (else vendored specs) |
| `TETHR_AUTOSEED=false` | skip auto-seed at startup |
| `DATABASE_URL` | external Postgres instead of embedded (cloud) |
| `PAPERCLIP_STORAGE_PROVIDER` / `PAPERCLIP_STORAGE_S3_*` | `local_disk` (default) → `s3` for cloud file bytes |
| `PAPERCLIP_MIGRATION_AUTO_APPLY=true` | run migrations on boot (deploy) |

Cloud swap details: **`MIGRATION-NOTES.md`** (DB / storage / LLM / notifier / secrets are
all one env var or one small provider each — no caller changes).

## How to test

```bash
cd server && npx vitest run src/__tests__/tethr.test.ts    # the Tethr suite
pnpm test                                                   # full suite (run after every phase)
node scripts/tethr-e2e.mjs                                  # browser e2e of the Sonar loop (dev stack must be up)
node scripts/tethr-screenshots.mjs                          # 32-capture screenshot deliverable → ~/Desktop/tethr-screenshots/
```

**Known pre-existing failure (NOT ours, do not "fix"):** `heartbeat-comment-wake-batching`
×2 fails on the fork baseline. Everything in the Tethr suite must stay green.

## Deploy (Railway)

Config-as-code: **`railway.toml`** (repo root) builds the root `Dockerfile` (multi-stage;
`production` stage serves UI + API on :3100), healthcheck `/api/health`. One managed
Postgres, mock LLM. Deploy = `railway up` after the one-time `railway login/init/add` (full
runbook: `tasks/phase-1.md`; the account-linked steps are gate **A1** in `MANUAL-STEPS.md`).

- **Env vars live as Railway service variables** (never in git): `DATABASE_URL`
  (`${{Postgres.DATABASE_URL}}`, internal → no sslmode), `PAPERCLIP_MIGRATION_AUTO_APPLY=true`,
  `BETTER_AUTH_SECRET`, `PAPERCLIP_PUBLIC_URL`. Live LLM (`ANTHROPIC_API_KEY`) is added only
  in Phase 3.
- **Railway URL:** _(set after first deploy — update here)_.
- **Ephemeral FS caveat:** Railway wipes the container FS on redeploy. All durable data is in
  managed Postgres and survives; only uploaded Drive file *bytes* (local_disk) are lost on
  redeploy until the S3/R2 swap. Attach a Railway Volume at `/paperclip` to persist them now.
- **First-run auth:** deploy defaults to `authenticated`/`private` (org not world-readable) —
  first visit creates the admin login (better-auth, stored in Postgres). Fallback for the
  shakedown: `PAPERCLIP_DEPLOYMENT_MODE=local_trusted`. Real multi-user logins land in Phase 9.

## Slack (#scout)

Both directions run through `server/src/tethr/`, gated on env so local dev stays offline.

- **Outbound:** the `Notifier` `slack` channel (`notify.ts`) posts real `chat.postMessage`
  when `SLACK_BOT_TOKEN` is set, else logs. Default channel `C0AE02FJR5Y` (override
  `SLACK_SCOUT_CHANNEL`). Attach Block Kit via a notification's `slackBlocks`.
- **Recommendation format** (`recommendation.ts`): `buildRecommendation()` → `{ text, body,
  blocks }`. The standard agent post — what's wrong / why it matters / affected
  URL·page·**file path (plain text, copy-safe for @Cursor)** / codename / severity, footer
  "Reply in-thread and tag @Cursor to fix." Black/white, no emoji. Reused by Phases 4 & 8.
- **Inbound (two transports, one handler):** a tagged/DM'd/link message → `interpretSlackEvent`
  → `routeInboundKickoff` → **Helm** (the router) — same entry point as the Console chat. A **DM**
  (`channel_type:"im"`) treats any text as a request; a channel needs a mention/link. Transports:
  (1) **Events API** `POST /api/tethr/slack/events` (signature-verified, for cloud/public URL);
  (2) **Socket Mode** (`startSlackSocketMode`, boot via `initTethr`→`maybeAutoSeed`) — outbound
  WebSocket via `SLACK_APP_TOKEN`, **no public URL**, the local-first path. Node ≥ 22 (global
  WebSocket). `../scout` was absent → built fresh. **Local run guide: `LOCAL.md`.**
- **Env:** `SLACK_BOT_TOKEN` (send/recv), `SLACK_APP_TOKEN` (Socket Mode/local),
  `SLACK_SIGNING_SECRET` (Events API only), optional `SLACK_SCOUT_CHANNEL`, `TETHR_SLACK_COMPANY_ID`.
  Cloud Slack app: gate **A2** in `MANUAL-STEPS.md`; local: `LOCAL.md`.
- **Manual outbound test:** `SLACK_BOT_TOKEN=… node scripts/tethr-slack-send.mjs` (gate A3).

## Terminal client — CLI (phase 14, 2026-07-14)

A third way to reach Tethr besides Console + Slack, for terminal-native engineers:
**`scripts/tethr-cli.mjs`** — a single-file, **zero-dependency** Node ≥20 client (plain `fetch`
+ `node:readline`). One-shot (`node scripts/tethr-cli.mjs "what bugs do I need to fix?"`) or REPL
(no args). Routes through the SAME REST surface the Console uses (`POST /route` → poll
`/route-runs/:id`), streams hops live, renders the answer with a light markdown→ANSI pass.
REPL commands: `/queue`, `/approve <n|id>`, `/reject <n|id>`, `/agents`, `/status`, `/runs`,
`/new`, `/help`, `/exit`. Thread continuity in-session (keeps `threadId`). **Zero server/engine/
UI changes, no deps, no migrations** (merge-safe). Auto-finds the local port (`:3100`/`:5173`)
when `TETHR_URL` is unset. **No npm package** — the single zero-dep file with a `#!/usr/bin/env
node` shebang IS the executable; `scripts/tethr-cli-install.sh` symlinks it onto PATH as `tethr`
(the run-directly guard is realpath-aware so it fires through the symlink). Pure formatters
locked by `server/src/__tests__/tethr-cli.test.ts` (18).
- **Security:** adds no new privilege (same surface as the UI). `TETHR_TOKEN` is env-only, never
  printed/logged; **nothing is written to disk** (thread state in memory only); `/approve`/`/reject`
  need an explicit id/index and echo the item (no bulk mutation); errors strip headers. The real
  boundary is network reach — server binds loopback by default; remote access = **Tailscale**
  (recommended) or `authenticated` mode + board API key; the CLI prints a warning on any
  non-loopback `TETHR_URL`. `medical/public/spend/pr` stay hard-gated regardless of caller.
  Full run + remote-access guide: **`LOCAL.md` §6**.

## Folder Command Center — local 00 Tethr viewer (phase 14, 2026-07-15)

A double-clickable local app to read + organize the **00 Tethr** Google Drive folder WITHOUT
opening the Tethr web app — modeled on Mark's Wandr Social Command Center (local server + static
UI, operates directly on the synced folder). **`scripts/tethr-command-center/`**: `server.mjs`
(zero-dep Node http server over `TETHR_MIRROR_DIR`), `public/` (vanilla JS UI — folder tree +
Markdown reader with an inlined safe MD→HTML renderer + new-folder/rename/move/archive),
`start.command` (launcher → opens `http://localhost:4848`). **Independent of the Tethr server/DB**
— pure fs. **Safety = fsdrive parity:** loopback-only bind, every path confined to the 00 Tethr
root (traversal stripped), archive = soft-move to `99 Archive` (never hard-delete), names
sanitized, single-writer port guard, MD content HTML-escaped before render. Verified live: tree,
MD/table/front-matter render, create/rename/archive, traversal blocked. Merge-safe (new files
only). Run/README: `scripts/tethr-command-center/README.md`.

**Native macOS app (phase 14, 2026-07-16, Mark's ask — "standalone lightweight app… hybrid
preview + finder window holding the Tethr aesthetic").** A real `Tethr Command Center.app` that
opens in **its own window, no browser**. `macapp/main.swift` (~200 lines, AppKit + WebKit, zero
deps) puts a `WKWebView` in an `NSWindow` (transparent black titlebar, `.topbar` inset 34px so the
traffic lights clear the app's own top bar), boots the SAME `server.mjs` as a hidden child on a
**private freePort()** (not 4848 — no collision), polls it, then loads. **Adds no privilege** (same
loopback server, just wrapped). **Child lifecycle is leak-proof:** stopped on quit; Swift traps
SIGTERM/SIGINT to kill it; and the server self-exits if the parent app vanishes (SIGKILL/crash) via
the new `TETHR_CC_PARENT_PID` liveness watch in server.mjs (guarded → inert for the browser path).
`build-app.sh` compiles (`swiftc`, needs Xcode CLT), bundles server+UI into Resources
(self-contained → draggable to /Applications), renders an on-brand `.icns` via `make-icon.swift`
(CoreGraphics, best-effort), ad-hoc-signs + clears quarantine. Built app is **gitignored**
(`scripts/tethr-command-center/build/`). Node ≥20 still required at run time (auto-finds
Homebrew/nvm/Volta). The **00 Tethr** Drive launcher (`Open Tethr Command Center.command`) opens the
`.app` if built, else the browser version. Verified live: boots, serves the real tree (200), clean
titlebar chrome (screenshotted), SIGTERM+SIGKILL both clean up the child.

## Claude subscription backend — run the org on Claude Pro/Max (phase 14, 2026-07-15)

A third LLM backend besides mock + API key: **`server/src/tethr/llm/claude-code.ts`**
(`ClaudeCodeProvider`) drives the local **Claude Code CLI** headless
(`claude -p --output-format json --system-prompt … --allowedTools "" --model …`), which is
authenticated with the operator's **personal Claude Pro/Max subscription** — so @tethr and the
org bill to the subscription, not per-token API. **Flip:** set `TETHR_LLM_BACKEND=claude-code`
(+ optional `TETHR_CLAUDE_CODE_MODEL`/`_FAST_MODEL`, default work=sonnet/fast=haiku) and restart.
Selection is in `llm/index.ts` (`getTethrLlmBackend`, `tethrLiveAvailable`); status exposes
`llm.backend`. classify/generate/plan/proposeAgent are single-shot; **runAgentic uses a text-only
`ACTION <name> {json}` protocol** (the CLI won't call Tethr's tools natively, and its own tool
machinery hijacks "tool" framing — so the model writes an ACTION line, Tethr executes it via
`callTool`, feeds the result back; read-only allowlist unchanged). **Tradeoffs:** per-call
latency + a few thousand tokens of Claude Code overhead → hits subscription rate limits faster
(pair with the throttle); cost is subscription-metered so no marginal dollars (token usage +
`total_cost_usd` still reported for the usage gauge). Flipping the whole instance to subscription
billing is a **go-live decision (Mark's flip)**, like setting the API key. Verified live in
isolation (classify/generate/runAgentic all run on the subscription). Merge-safe: new provider +
selection wiring only.

## Company page: System vs Organization divider (phase 14, 2026-07-15)

The Company page (`ui/src/pages/tethr/TethrCompany.tsx`) now splits the roster into two
labeled, divider-separated sections: **Organization** (the mission org — the @ceo tier-0 banner,
its specialists like @radar, and divisions) and **System · infrastructure** (the tooling that
runs the org — @tethr conductor, @tinkr mechanic, @patch debug — beside the command chain, not in
it). `SYSTEM_ORDER = ["@tethr","@tinkr","@patch"]` classifies by `profile.tag`; system agents are
excluded from ceoReports + divisions and rendered in their own 3-card section, and a division that
only existed to host a system agent (Operations/@tethr) is dropped (`orgDivisions` filter). Pure
UI grouping — no API/schema change. Verified live.

## Token-saving strategies (phase 14, 2026-07-15)

Implemented cost/token reductions across both LLM backends (researched via the claude-api skill):
- **Prompt caching on the API provider** (`llm/claude.ts`, GA `cache_control:{type:"ephemeral"}`, no
  beta header). Cached ONLY where a prefix repeats: **`runAgentic`** caches system+tools (one
  breakpoint) + a moving message-tail breakpoint so each tool-loop turn re-reads the growing history
  at ~0.1× instead of full price; **`generate`/`proposeAgent`** cache the agent's stable identity
  system prompt across its calls. Classify/plan are NOT cached (one-shot + per-request-varying → the
  1.25× write would never be read). Helpers `systemParam`/`markMessagePrefixCache`; kill switch
  `TETHR_CLAUDE_CACHE=false`.
- **Claude Code backend auto-caches** (verified: `cache_creation`/`cache_read` in the CLI JSON) — the
  lever there is overhead, so `claude-code.ts` passes **`--strict-mcp-config`** (loads no MCP servers:
  cuts ~16k tokens of MCP-tool context per call, verified 15945→0, and isolates the provider from the
  operator's personal MCP config) + `--exclude-dynamic-system-prompt-sections`.
- **Model tiering** (both backends): cheap **Haiku** for classify/plan hops, **Sonnet** for
  generate/agentic work (env: `TETHR_CLAUDE_MODEL`/`_FAST_MODEL`, `TETHR_CLAUDE_CODE_MODEL`/`_FAST_MODEL`;
  bump work→opus for quality). **runAgentic turn caps** (CLI default 5, API 8) bound loop spend.
- The **usage throttle** (below) is the hard cost ceiling when subscription usage runs high.

## Usage throttle — global pause/resume (phase 14, 2026-07-15)

The kill switch for subscription usage: a per-company **"agents paused"** flag that stops ALL
LLM work — heartbeats AND routed requests (Console/Slack/CLI/API) — until resumed.
**`server/src/tethr/throttle.ts`**: persistent instance-dir JSON (`tethr-paused.json`, same
pattern as the overseer roster) — `isAgentsPaused` (fast sync hot-path check), `getThrottleState`,
`setThrottle`. Checked at two choke points: `routing.ts` routeRequest (right after `onStarted` —
records the run as done with `PAUSED_MESSAGE`, no LLM call) and `adapter.ts` execute top (heartbeat
skips before any mode). Control surfaces: **Slack** — `pause`/`resume` commands in `commands.ts`
(aliases "pause agents"/"resume agents"/"throttle"…), dispatched in `slack.ts` `routeInboundKickoff`
BEFORE the LLM so it works even at your limit; **UI** — a toggle on the Providers page
(`TethrSettings.tsx` `ThrottleCard`, inverts to black when paused) + a global **"● AGENTS PAUSED"**
pill by the bell (`TethrBell.tsx`, polls every 30s, click → Providers); **REST** — `GET`/`POST
/tethr/:companyId/throttle`. Verified live: pause blocks a route with no LLM call, UI inverts, pill
appears, resume clears. Merge-safe: new module + additive hooks (no core edits). Budget-change and
compliance gates are unaffected.

## Live mode (Claude) & budgets

- **Flip live:** set `ANTHROPIC_API_KEY` (+ optional `TETHR_CLAUDE_MODEL`, default
  `claude-sonnet-4-6`) and restart — `getTethrLLMProvider()` (`llm/index.ts`) swaps mock →
  `ClaudeProvider` at boot. `TETHR_LIVE_FETCH=true` turns the three web tools from fixtures to
  real read-only GETs. **Flip back:** unset `ANTHROPIC_API_KEY`.
- **Budgets are real now (Phase 3 fix).** Two seams were broken: the adapter reported no cost
  and only Tailwind's cap hard-stopped. Fixed additively — `llm/pricing.ts` prices token usage
  (`claude-sonnet-4-6` = $3/$15 per MTok, override with `TETHR_PRICE_INPUT_PER_MTOK` /
  `TETHR_PRICE_OUTPUT_PER_MTOK`), `adapter.ts` emits `resultJson.costUsd` for **live runs only**
  (mock stays $0), and `seed.ts` sets `hardStopEnabled: true` for every agent policy. Cost flows
  into core `cost_events`; the hard-stop fires in core `services/budgets.ts`. Re-seed a fresh DB
  for the seed change to apply. Read spend on the TethrBudgets page.
- **Safety envelope (locked by `__tests__/tethr-live-safety.test.ts`):** a live Sonar run cannot
  write outside the DB-backed Tethr Drive (no `fs`/`exec`; Sonar lacks `drive_write`) and cannot
  publish externally except the `notify`→Slack tool, which is granted to `@sonar.leads` only and
  gated by `SLACK_BOT_TOKEN`. Allowlists are hard-enforced in `worker.ts`; gating blocks
  `medical`/`public`/`spend`/`pr` publishes without an approval. Keep the org-level Anthropic
  spend limit ($25/mo) on permanently.

## Reliability division — Sentry (Phase 4, the V1 loop)

**Sentry** is the site auditor in the (now active) Reliability division. It runs a
deterministic, read-only audit of travelwithwandr.com's public pages and posts ≤3 findings/day
to #scout in the standard recommendation format; a human tags `@Cursor` in-thread to fix.

- **Checks** (`checks/site-audit.ts`, pure + unit-tested): meta title/description, JSON-LD
  presence/validity, broken internal links, GA4 `G-WP11MQFLQ5` / GTM `GTM-N7K829F8` presence,
  duplicate titles. Structural/technical only — **never** medical-content correctness.
- **Runner** (`checks/sentry.ts`): fetches the fixed page list, dedupes against `tethr_memories`
  (14-day window; fingerprint stored in memory content), posts via the Notifier, records each.
- **Heartbeat mode:** `adapter.ts` `heartbeatMode: "site_audit"` (sibling of Helm's `digest`).
  Sentry is **seeded paused** ($20/mo cap, hard-stop on) — enable its heartbeat only after a
  reviewed run. `TETHR_SENTRY_DRY_RUN=true` previews findings (in `resultJson`) without posting.
- **Config env:** `TETHR_SENTRY_SITE` (default `https://travelwithwandr.com`),
  `TETHR_SENTRY_GA4_ID`, `TETHR_SENTRY_GTM_ID`, `TETHR_SENTRY_DRY_RUN`.
- The fix loop is **Cursor's native Slack integration** — nothing is built for it (gate B3).
- **Pulse** (Phase 8) is the second Reliability agent, same #scout loop: `checks/pulse.ts` +
  `tools/posthog.ts` run 3 read-only PostHog queries (error spike / dead event / funnel drop)
  with a **PHI denylist** on event names. Seeded paused, $20/mo cap, inert until `POSTHOG_API_KEY`
  is set and `tools/pulse-events.json` is filled. Heartbeat mode `pulse_audit`; preview with
  `TETHR_PULSE_DRY_RUN=true`.

## Memory & published-content dedupe (Phase 6)

`tethr_memories` is keyword (`ilike`) recall. `published-memory.ts` adds a dedup layer:
`gating.ts` records a company-scoped `published-content` memory on every publish; `routing.ts`
warns (advisory, never blocks) on a duplicate-topic content request. Backfill the blueprint
corpus once via `POST /api/tethr/:companyId/seed-memory` (or `scripts/tethr-seed-memory.mjs`,
`TETHR_MEMORY_SEED_PATH`) — idempotent. Embeddings/graph decision deferred with triggers in
`docs/adr/0002-memory-architecture.md`.

## Observability & ops (Phase 9)

`observability.ts`: `reportServerError` → #scout, throttled 1/error-class/hour; `deepHealthCheck`
→ `GET /api/tethr/health/deep` (200/503, for an uptime pinger). `adapter.ts` reports heartbeat
failures through it. `digest.ts` `generateWeeklySummary` posts total + per-agent spend vs cap.
Ops guide (restart, kill switches, rollback, uptime, access) = **`RUNBOOK.md`**. Access control
uses core **better-auth** (authenticated mode) — a 3-user setup, not a build.

## Google integrations — Ads, Keywords, Drive (recycled from Scout)

Ported from `scout-wandr-app` (raw fetch, no SDK). Setup + safety: **`GOOGLE-SETUP.md`**.

- **Google Ads** (`tools/google-ads.ts`, tool `google_ads_report`) — **READ-ONLY** overview/
  campaigns/keywords/search-terms. Granted to **Tailwind** + **Ledger**. No mutate functions were
  ported: agents analyze + recommend; any account/spend change stays a human-approved `spend`-gated
  output. Locked by `tethr-google.test.ts`. Reuses `GOOGLE_ADS_*` (already in the instance env).
- **Keyword Planner** (`tools/keyword-planner.ts`, tool `keyword_ideas`) — real search volume;
  granted to **Atlas** + **Beacon**. Needs a Basic/Standard dev token (Explorer → clear error).
- **Google Drive** (`tools/google-drive.ts`) — service-account writer scoped to **one shared
  folder** (`TETHR_GDRIVE_FOLDER_ID`); `gating.ts` mirrors every published deliverable there
  (best-effort, never fails a publish). Inert until `TETHR_GDRIVE_SA_KEY[_PATH]` + folder id set.

## Agent autonomy — auto/manual approval, a CEO that acts, cofounder alerts (phase 14, 2026-07-14)

Agents can now operate with real autonomy, safely bounded. Migration **0094** adds
`auto_approve` + `overseer_role` to `tethr_agent_profiles`.

- **Per-agent auto/manual approval.** Each agent has an Auto/Manual toggle (agent page,
  `TethrAgentPage.tsx` Approvals card; PATCH `/agents/:id/profile`). In **auto**, the agent's
  gated `org` decisions (agent_proposal, org_change) apply without a human — via the hook in
  `gating.createOutput` (calls the in-closure `decide({reviewer:"auto:@tag"})`, logs
  `actorType:"system"`). **HARD boundary, enforced structurally:** auto-approve fires ONLY for
  `sensitivity === "org"`, so **spend/medical/public/pr can NEVER auto-approve**; **budget-change
  org_changes are carved out too** (`op === "update_budget"` → always manual, Mark's rule).
  Auto-created/modified agents still **start paused** — enabling a heartbeat stays a human action.
  Locked by `tethr-autoapprove.test.ts`.
- **The CEO can act.** `propose_agent` tool (`tools/internal.ts`, granted only to `@ceo.plan`)
  → `proposals.proposeAgent` → gated `agent_proposal`. So the CEO proposes the agents its brief
  recommends; approved (or auto-approved) → `instantiateAgentFromSpec` builds it PAUSED reporting
  to the CEO. `@ceo.plan` guidance updated (propose one agent per genuine gap, never a duplicate).
- **Role-based overseer roster** (`overseers.ts`): `tech`→Frank, `exec`→Alec, `growth`→Mark, a
  per-company JSON in the instance dir (`TETHR_OVERSEERS_FILE` test override; env-seedable via
  `TETHR_OVERSEER_{TECH,EXEC,GROWTH}_{NAME,SLACK_ID}`). Each agent has an `overseerRole`; `@ceo`
  seeded exec, `@patch` seeded tech; **new agents auto-route by domain** (`inferOverseerRole`
  keyword match on role/mission, wired into `instantiateAgentFromSpec`). Roster edited on Settings;
  role picked per-agent on the agent page. `resolveOverseer` now = roster[overseerRole] (per-agent
  `overseerSlackId` override still wins). **No flat Mark default.**
- **Slack alerts** (`slack.ts` `dmOverseer` → `postSlackMessage` to a `U…` id, no-op without
  id/token): `gating.createOutput` DMs the agent's overseer — a gated item that still needs a human
  ("needs your approval"), or a heartbeat deliverable ("filed: <title>" — the silent-CEO-brief gap).
  Auto-approved items don't nag. Manual gate: set the 3 Slack member IDs in Settings (MANUAL-STEPS
  C6a); add the Slack `im:write` scope if proactive DMs bounce.
- **00 Tethr full-screen viewer** (`drive/DriveViewer.tsx`): an "Open viewer" launcher on the
  00 Tethr section → a portaled full-screen reader (folder tree + large MD-first file pane +
  new-folder/rename/archive), reusing the fs source + `readFsFile` (no new backend).

## Drive page redesign — 00 Tethr as the main drive (phase 13, 2026-07-13)

The Drive page was reframed so the **Google Drive-synced `00 Tethr` folder is the main view**
(clean, capitalized `01 Briefs`/`02 Documents`/`07 Debug` — what the team sees), with two
toggles revealing Tethr's **internal working drive** (the DB) and **other Google Drive folders**
(an allowlist the user adds). All three render in **one drag-and-drop file manager**.
- **`fsdrive.ts`** — generic, root-confined fs ops (`listFsChildren`/`fsCreateFolder`/`fsMove`/
  `fsArchive`) making synced folders human-modifiable; every op guarded by `resolveWithinRoot`
  (exported from `mirror.ts`), names sanitized, "delete" = soft move to `99 Archive` (never
  hard). Plus the **mounts allowlist**: add/list/remove folders, stored in
  `tethr-drive-mounts.json` in the instance dir (`TETHR_MOUNTS_FILE` overrides for tests); each
  added folder MUST be an existing dir under `dirname(mirrorDir())` (the Google Drive "My
  Drive" holding 00 Tethr) — only Drive folders the user picks, never arbitrary fs; 00 Tethr
  itself excluded. Routes: `/fsdrive/list|folder|move|archive` + `/fsdrive/mounts`
  (GET/POST/DELETE), `mount=mirror|ext:<id>`. **Agents never reach any of this — UI only.**
- **UI** (`ui/src/pages/tethr/drive/`): `adapters.ts` (`DriveSource` = fs/internal, same verbs)
  + `FileManager.tsx` (one store-agnostic component: breadcrumbs, new-folder/rename/archive
  dialogs, **`@dnd-kit` drag-to-move** — drag a row onto a folder or breadcrumb; within a
  single source only). `TethrDrive.tsx` = 00 Tethr main + two `Switch` toggles + the mounts
  section (+Add folder). fs sources are manage-only (no in-app content preview yet — open in
  Drive/Finder); internal keeps its preview via the old panel (still in git history).
- Tests: `tethr-fsdrive.test.ts` (11 — confinement, soft-delete, mount-under-Drive guard).
  Verified live: created a folder in 00 Tethr (hit disk), added "10 Partnerships & Programs"
  (showed real Drive contents scoped to it), move endpoint relocates on disk. **v2 (Google
  API / service-account "folders shared with Tethr") still deferred** — this uses the local
  desktop-sync mount, no Google setup.

## Drive as a file manager (phase 12, D1 built — internal DB drive)

The Drive page is now a real file manager, not a read-only browser. `drive.ts` adds
**human-only** ops — `createFolder`, `moveNode` (reparent + rename; a folder move rewrites
every descendant path in one SQL prefix-swap), `archiveNode` (soft delete = move to
`/archive`, **never** a hard delete). Routes: `POST /drive/folder`, `/drive/node/:id/move`,
`/drive/node/:id/archive` (all `assertCompanyAccess`). UI (`TethrDrive.tsx`): folder tree +
show/hide toggle, move dialog (tree destination picker, self-exclusion), rename, new-folder.
**Agents never call these** — they only `putFile` into their own folders; move/organize is a
person's job. Locked by `tethr-drive-manager.test.ts` (10 tests).

**D2 — shared Google Drive workspace, v1 BUILT via desktop sync (2026-07-13).** The
service-account API path hit permission blocks, so v1 needs **zero Google credentials**: Mark
runs Google Drive for Desktop, and `server/src/tethr/mirror.ts` projects every published
deliverable as a plain file into the synced folder (`TETHR_MIRROR_DIR` →
`~/Library/CloudStorage/GoogleDrive-contact@travelwithwandr.com/My Drive/00 Tethr`); the Drive
client uploads them. Design contract (Mark's spec): the DB stays the system of record; the
folder is a **write-once-per-publish projection** tracked in `tethr_outputs.meta.mirror` —
humans freely delete/move/rename in the folder and nothing breaks or resurrects (backfill
skips anything with meta.mirror set; `?force=true` overrides). Partner-facing taxonomy
(strict kind allowlist — answer/agent_proposal/org_change NEVER mirror): 01 Briefs · 02
Documents · 03 Research · 04 Content/{Blog Drafts,Press,Itineraries} · 05 Ads & Analytics ·
06 Strategy · 99 Archive (human-only). Agents can file elsewhere/other formats with
`[file-under: …]` / `[format: md|pdf|pptx|docx]` directives atop their output (parsed+stripped
in worker.ts, sanitized, destination shown in the approval). Renderers in `mirror-render.ts`
(marked+playwright PDF, pptxgenjs, docx — dynamic imports, fall back to .md). The single live
call site is gating.publishToDrive (best-effort, publish never fails); collision = output-uuid
front matter (own file → overwrite; other output → ` (<id8>)` suffix); writes are same-dir
dot-temp + atomic rename. Live view: `GET /tethr/:companyId/mirror/tree` (stateless readdir,
no contents) + a "Google Drive" toggle panel on TethrDrive.tsx; backfill route
`POST /mirror/backfill`; status shows `mirror:{enabled,dir}`. Tests: `tethr-mirror.test.ts`
(20; inert-under-test guard, `TETHR_MIRROR_ALLOW_TEST=1` temp-dir hatch). **V2 (cloud) = the
old service-account plan** — scope `drive` + read/list/move API functions — still pending
Mark's Google setup.

## Brand lock (any UI work)

Urbanist + JetBrains Mono · pure black/white · 2px borders · **no gradients, no color, no
emoji noise** · minimal wireframe aesthetic. Light + dark + mobile. Edit brand only via
**`ui/src/lib/brand.ts`** and **`ui/src/styles/tethr-theme.css`** — nowhere else. Any UI
prompt still restates this spec.

## Hard boundaries (never cross)

- **Never touch PHI / clinical systems / the website's medical-content correctness.** Tethr is marketing/distribution only. Medical *content* decisions are a licensed-human domain — structural/technical findings only.
- **Internal-only output.** Nothing auto-publishes; nothing auto-merges; no medical content decisions ever. The compliance gate (`server/src/tethr/gating.ts`) hard-blocks `medical`/`public`/`spend`/`pr` outputs behind a core `approvals` row — there is no advisory bypass. Keep it hard in every phase.
- **Never modify the live Drive engine** at `05 Marketing /Claude Marketing/` — it's the current production system, retired workflow-by-workflow in Phase 5, **read as reference only, never edited**. Same for `05 Marketing /Command Center/` originals (copy, never move).
- **Never modify `terraform/`** — the preserved Azure path (hosting is Railway-first now; Azure stays in-repo as the future migration).
- **Every autonomous agent keeps its stated budget cap.** Any phase adding autonomous runs states a per-agent cap. Caps are enforced by core `budget_policies` + `cost_events` hard-stops.
- **Secrets are never committed** — env vars only; `.env.example` has blanks for every knob.
- **Never push or merge automatically.** Commit locally per phase; a human pushes/merges.

## Working conventions

- **Plan first.** Each phase: write the plan to `tasks/phase-N.md` before executing. Under the RUN-ALL meta-prompt the plan is written then executed without an approval pause **except at hard gates** (below); the standalone phase files use an explicit approve-between-prompts flow.
- **Commit per phase** on `tethr-buildout`: `phase N: <summary>`. Run `pnpm test` and fix Tethr regressions before moving on.
- **Delegate read-heavy exploration** (large source reads, log analysis, external-repo audits) to subagents to protect context.
- **Keep this file current.** Anything a future session needs → add it here.

### Hard gates (stop for Mark; otherwise queue in MANUAL-STEPS.md and skip forward)

1. Anything needing Mark's accounts: `railway login/init/up`, Slack app creation, setting `ANTHROPIC_API_KEY` / `SLACK_BOT_TOKEN` / `POSTHOG_API_KEY` / `CC_PASSWORD` on Railway.
2. The **first real Slack post** to `#scout`, the **first live-LLM spend**, and **enabling any heartbeat** — each needs one explicit "go".
3. Phase 5 **parity judgments** (only Mark judges output parity) and **pausing laptop crons** (only Mark touches the laptop).

At a gate: print the exact commands / dashboard steps, add them to
`docs/tethr-buildout/MANUAL-STEPS.md`, and skip forward to unblocked work.

## Buildout status (keep updated each phase)

| Phase | Name | State |
|---|---|---|
| 0 | Repo ground truth & Scout audit | **built** (this commit) |
| 1 | Deploy Tethr to Railway | code-ready; blocked on Railway account |
| 2 | Slack: real senders + inbound surface | **code built** (sender + recommendation format + inbound events, 14 tests); blocked on Slack app **A2** |
| 3 | Go live with Claude (supervised) | **code + safety built** (budget cap now enforces; 8 safety/pricing tests); blocked on `ANTHROPIC_API_KEY` **B1/B2** |
| 4 | V1 recommendation loop (Sentry → #scout → @Cursor → PR) | **code + tests built** (auditor, 4 checks, dedupe, seeded paused); needs P2/P3 live + Cursor **B3** |
| 5 | Migrate laptop workflows | pending; parity/cron gates are Mark's |
| 6 | Memory upgrade (dedupe) | **built + tested** (`published-memory.ts`, publish-record hook, routing warning, seed endpoint, ADR-0002); corpus backfill is 1 manual step |
| 7 | Command Center → cloud | pending; source in Drive, not repo |
| 8 | Error-patching agent (Pulse / PostHog) | **code + tests built** (3 rules, PHI denylist, seeded paused); blocked on `POSTHOG_API_KEY` **C2** + fill config |
| 9 | Observability, budgets, access control | **built** (error→#scout throttled, deep health route, weekly spend digest, RUNBOOK; auth = core better-auth, 3-user setup) |
| 10 | Scale review vs $1M-no-hiring | excluded (needs steady-state data) |
| 11 | Clean slate: one coordinator (@tethr) | **built + tested** (`seed/tethr-core.ts`, router resolution, Slack thread answers, 8 tests); old org archived not deleted; Slack app rename = manual **A2** |

Full run instructions: `docs/tethr-buildout/RUN-ALL-PROMPT.md`. Remaining human actions
(the deliverable Mark cares about most): `docs/tethr-buildout/MANUAL-STEPS.md`.
