# Tethr — engineering guide

**Audience:** an engineer picking this repo up cold and needing to understand what it is,
what we added, how a request actually flows through it, and where the guardrails are.

**Status as of 2026-08-01:** built and running locally against a live Claude backend. Not
deployed. 23 Tethr test files, **262 tests, all green**. Branch: `tethr-buildout` (identical
content to `mark-sandbox`).

If you read only one thing after this file, read `CLAUDE.md` — it's the operating contract and
is kept current per phase. This document is the map; `CLAUDE.md` is the changelog.

---

## 1. What this repo is

This is **Wandr's fork of [Paperclip](https://github.com/paperclipai/paperclip)**, an
open-source orchestration engine for running a company with AI agents.

**Tethr is a product built inside Paperclip the way Chrome is built on Chromium.** Paperclip
core is the engine. Tethr is Wandr Health's marketing/distribution operator layered on top,
**through the engine's own seams** — never by forking the engine.

```
Layer 3  Content    The seeded org: agents, divisions, budgets, routing tables (DB rows)
Layer 2  Tethr      server/src/tethr/**   — routing, gating, drive, memory, notify, llm, tools, seed
Layer 1  Shell      ui/src/pages/tethr/** — Console, Company, Queue, Drive, Runs, Budgets, Audit, Memory, Settings
Layer 0  Paperclip  untouched engine — heartbeats, routines (cron), approvals, budget policies,
                    cost events, activity log, storage service, auth
```

Remotes:
- `origin` → `github.com/Wandr-Health-Inc-Engineering/paperclip` (our fork). Branches:
  `master` (baseline), `mark-sandbox` (integration), `tethr-buildout` (work).
- `upstream` → `github.com/paperclipai/paperclip` (public project). **We merge *from* it. We
  never push *to* it.**

`master` is currently ~914 commits behind `upstream/master`. That gap is the main maintenance
debt; the additive design below is what keeps closing it tractable.

### The merge-safe rule (non-negotiable)

**Add files; don't edit core.** New behavior goes in `server/src/tethr/**`,
`ui/src/pages/tethr/**`, `packages/db/src/schema/tethr_*.ts`. If a core file *must* change, it
stays a one-liner and gets logged in `DECISIONS.md` under "Core changes (keep merge-safe)".

Current total: **12 core files, ~231 lines**, and every one is a registration point (route
mount, nav entry, schema barrel export, adapter registry). The single substantive fix — a FK
ordering bug in company `remove()` — is upstreamable.

If you find yourself editing a core file to make Tethr work, that's the signal you've missed a
seam. Ask before doing it.

---

## 2. Running it

```bash
pnpm install
pnpm dev
```

Server on `:3100`, UI on `:5173`. Embedded Postgres, auto-migrate, auto-seed. **No Docker, no
external DB, no API key required** — the default LLM provider is a deterministic mock, so the
whole system runs offline and the test suite is hermetic.

Docker path: `make compose-up` (Postgres 17 + server + bundled UI on `:3100`).

### Environment

**Dev env is read from the Paperclip instance dir, not repo `.env`:**
`~/.paperclip/instances/default/.env`. This trips people up — a var you add to the repo `.env`
will appear to do nothing.

| Var | Effect |
|---|---|
| `TETHR_LLM_BACKEND` | `mock` (default) · `claude` (API key) · `claude-code` (Claude Pro/Max subscription via local CLI) |
| `ANTHROPIC_API_KEY` | swaps mock → live Claude API |
| `TETHR_CLAUDE_MODEL` / `_FAST_MODEL` | work model (chat/plan/draft/vision) / cheap routing model |
| `TETHR_CLAUDE_CODE_MODEL` / `_FAST_MODEL` | same split for the subscription backend |
| `TETHR_LIVE_FETCH=true` | real read-only web/CDC fetches instead of fixtures |
| `TETHR_BUNDLE_PATH` | path to the agent spec bundle the seeder imports |
| `TETHR_MIRROR_DIR` | the Google-Drive-synced `00 Tethr` folder deliverables are projected into |
| `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` / `SLACK_SIGNING_SECRET` | Slack send / Socket Mode / Events API |
| `SLACK_SCOUT_CHANNEL` | channel override (name is legacy; default is now **#tethr**) |
| `DATABASE_URL` | external Postgres instead of embedded |
| `PAPERCLIP_STORAGE_PROVIDER` + `PAPERCLIP_STORAGE_S3_*` | `local_disk` (default) → `s3` |
| `PAPERCLIP_MIGRATION_AUTO_APPLY=true` | run migrations on boot (deploy) |
| `TETHR_AUTOSEED=false` | skip auto-seed at startup |

`.env.example` lists every knob with blank values. **Secrets are never committed.**

### Tests

```bash
cd server && npx vitest run src/__tests__/tethr.test.ts     # the main Tethr suite
cd server && npx vitest run $(ls src/__tests__/ | grep tethr | sed 's|^|src/__tests__/|')
pnpm test                                                    # everything
```

**Known pre-existing failure that is NOT ours:** `heartbeat-comment-wake-batching` ×2 fails on
the fork baseline. Don't "fix" it. Everything with `tethr` in the filename must stay green.

### Current live state (this machine)

```
LLM       live · backend claude-code (Mark's Claude subscription) · sonnet
Agents    not paused
Mirror    enabled → ~/…/My Drive/00 Tethr
Slack     tokens set, Socket Mode, one channel #tethr (C0BGK29482J)
DB        embedded Postgres, 3 companies (Wandr = active; Wandr Growth = archived; Wandr Health)
```

---

## 3. The data model

Nine additive `tethr_*` tables in `packages/db/src/schema/`. Migrations through **0094**.

| Table | Holds |
|---|---|
| `tethr_divisions` | first-class divisions; `status: active \| shell` |
| `tethr_agent_profiles` | per-agent Tethr identity: tag, codename, mission, approval gate, **routing table**, standing rules, `auto_approve`, `overseer_role` |
| `tethr_subagents` | the fine-tuned specs: route-when, not-here, reads, steps, output contract, guardrails, done-when, escalation, sensitivity, **`tools` grant (0093)** |
| `tethr_route_runs` | every routed request with its full hop trail (classify → route → do → each tool call) |
| `tethr_outputs` | work products; a gated one links a core `approvals` row |
| `tethr_drive_nodes` / `tethr_drive_versions` | internal Drive: folder tree, versioned files, tags. Bytes go through core `StorageService` |
| `tethr_memories` | per-company + per-agent keyword recall (`ilike`) |
| `tethr_notifications` | in-app notification centre |
| `tethr_org_changes` | append-only before/after log of every applied org change (0092) |

**The DB is the system of record.** Routing tables, agent specs, and tool grants live in rows,
not in code — which is why the seeders are idempotent and why there are boot "heal" functions
(see §7).

---

## 4. How a request actually flows

This is the core loop. Everything — Console, Slack, CLI, REST, heartbeat — funnels into
`routing.ts` `routeRequest`.

```
request text (+ optional images, thread id, origin key)
   │
   ├─ throttle check ......... agents paused? → record run done, no LLM call
   │
   ├─ CLASSIFY .............. router agent (@tethr; @helm for legacy orgs) reads its
   │                          routing table (DB) and picks a target @agent
   │                          → fast/cheap model
   │
   ├─ ROUTE ................. target agent classifies to one of its subagents
   │                          (@agent.subagent) → fast/cheap model
   │
   └─ DO .................... worker.ts renders the subagent's spec as a system prompt,
                              runs the agentic tool loop against its allowlisted toolset,
                              produces a work product → work model
                                 │
                                 └─ gating.ts decides: publish, or stage behind a
                                    human approval
```

Every hop — including each individual tool call — is written to the route run **and** the core
activity log, so any request's path is fully reconstructable after the fact. That trail is what
the Runs page and `@patch`'s `read_failures` tool read.

**Key files:**
- `routing.ts` (521 lines) — the engine. `ROUTING-MODEL.md` as code.
- `worker.ts` (419 lines) — the "do" step. Maps subagent key → output kind, renders the spec,
  runs tools, hands off to gating. Also parses the `[file-under: …]` / `[format: …]` directives
  an agent can put atop its output.
- `gating.ts` (690 lines) — the compliance layer (§5).
- `adapter.ts` (249 lines) — registers `tethr_llm` through `registerServerAdapter`, the
  documented core seam. **This is why a Tethr agent is a first-class Paperclip employee:**
  heartbeats, cron routines, "run now", run logs, and cost events all flow through unmodified
  Paperclip machinery. The adapter's `execute()` runs the loop above instead of spawning a CLI.
- `index.ts` — `initTethr(db)` (one call from `createApp`) + `maybeAutoSeed(db)` (one call from
  server startup, deliberately kept out of `createApp` so API tests never seed as a side effect).

### The LLM layer

`llm/index.ts` picks one of three providers at boot:

| Backend | File | Notes |
|---|---|---|
| `mock` | `llm/mock.ts` | deterministic keyword scorer. Default. Makes tests hermetic and dev free. |
| `claude` | `llm/claude.ts` | plain `fetch` against the Anthropic API. GA prompt caching. |
| `claude-code` | `llm/claude-code.ts` | drives the local Claude Code CLI headless — bills to a **personal Claude Pro/Max subscription**, not per-token API. |

Two things worth knowing about `claude-code`:
1. The CLI won't call Tethr's tools natively, so `runAgentic` uses a **text-only
   `ACTION <name> {json}` protocol**: the model writes an ACTION line, Tethr executes it via
   `callTool`, feeds the result back. Same read-only allowlist.
2. It passes `--strict-mcp-config` so it loads no MCP servers — cuts ~16k tokens of context per
   call and isolates the provider from whatever MCP config the operator has personally.

Cost: `llm/pricing.ts` prices token usage; `adapter.ts` emits `resultJson.costUsd` for **live
runs only** (mock stays $0). That flows into core `cost_events`, and the hard stop fires in core
`services/budgets.ts`. Budgets are genuinely enforced, not decorative.

**Token-saving measures in place:** prompt caching on the API provider (system+tools breakpoint
plus a moving message-tail breakpoint in `runAgentic`; classify/plan deliberately *not* cached
since a one-shot call would pay the 1.25× write and never read it), model tiering (haiku for
classify/plan, sonnet for the work), and `runAgentic` turn caps (CLI 5, API 8).

---

## 5. The guardrails — read this section before changing anything

The whole system is designed so an agent **cannot** do damage without a human. These are
structural, not advisory.

### 5.1 The compliance gate

Every output carries a `sensitivity`. Four of them are **hard-gated**: `medical`, `public`,
`spend`, `pr` — plus `destructive` (file archive) and `org` (org changes).

A gated output is created with a linked core `approvals` row and can only reach `published`
through `gating.decide("approve")`. **There is no advisory bypass** — `publish` checks the
approval row itself, so a gated output without an approved approval cannot ship. Reviewer and
reason are recorded in the core activity log.

### 5.2 Auto-approve is deliberately narrow

Agents have an Auto/Manual toggle. In auto, gated decisions apply without a human — **but only
for `sensitivity === "org"`**. The check is structural, so `spend`/`medical`/`public`/`pr`/
`destructive` can *never* auto-approve. Budget changes get defense in depth: they're carved out
by op (`update_budget` → always manual) *and* stamped `sensitivity: "spend"` at both creation
sites. Auto-created or auto-modified agents still **start paused** — enabling a heartbeat is
always a human action.

### 5.3 Deletion is a soft archive, always

The only way an agent can "delete" a file is `@filer` → `stage_file_archive` → gated
`destructive` output → human confirms → **soft move** (shared Drive → `99 Archive`; internal
Drive → `/archive`). Never a hard delete; the repo is grep-proofed for this. Validation is
root-confined, files-only, with protected paths; apply re-validates, and a vanished file closes
the output `rejected` rather than wedging the Queue.

### 5.4 Tool allowlists are hard-enforced

`tools/index.ts` — a baseline of `drive_list`, `drive_read`, `recall_memory`, `escalate` for
everyone, plus a per-subagent grant. Resolution order: **the DB grant on `tethr_subagents.tools`
wins** (that's what makes factory-created agents actually work), falling back to the static
`ALLOWLIST` for the hand-built agents. Unknown tool names are dropped, never invented.

Single-holder tools, granted to exactly one subagent each:
`stage_org_change` → `@tinkr.change` · `stage_file_archive` → `@filer.archive` ·
`read_failures` → `@patch.diagnose` · `propose_agent` → `@ceo.plan`.

Google Ads is **read-only** — no mutate functions were ported. Agents analyze and recommend; any
spend change is a human-approved `spend`-gated output.

### 5.5 Hard boundaries that never move

- **Never touch PHI, clinical systems, or the website's medical-content correctness.** Tethr is
  marketing/distribution only. Structural and technical findings only; medical *content*
  decisions are a licensed-human domain.
- Nothing auto-publishes externally. The only outward path is the `notify` → Slack tool, granted
  to one subagent and gated on `SLACK_BOT_TOKEN`.
- Every autonomous agent keeps a stated budget cap, enforced by core hard-stops.
- Never modify `terraform/` (preserved Azure path) or the live Drive engine at
  `05 Marketing /Claude Marketing/` (production; read-only reference).
- **Never push or merge automatically.** A human does that.

`server/src/__tests__/tethr-live-safety.test.ts` locks the envelope: a live run cannot write
outside the DB-backed Drive (no `fs`, no `exec`) and cannot publish externally.

### 5.6 The usage throttle

A per-company "agents paused" flag (`throttle.ts`, persisted as JSON in the instance dir) that
stops **all** LLM work — heartbeats and routed requests alike. Two choke points: `routeRequest`
(right after `onStarted`) and `adapter.execute` (before any mode). Control it from Slack
(`pause` / `resume` — dispatched *before* the LLM so it works even at your rate limit), the
Providers settings page, or `GET`/`POST /tethr/:companyId/throttle`.

---

## 6. The org — who the agents are

The seeded company is **Wandr** (prefix `WD`). Ten agents, two roots, all currently `idle`
(no heartbeats enabled).

```
@tethr  — the conductor (Jarvis)        [root, tier 0, NOT in the command chain]
  ├── @tinkr   the org mechanic
  ├── @patch   the debug agent
  └── @filer   the file archivist

@ceo    — head of the agent org          [second root, tier 0]
  ├── @radar   market research
  ├── @remedy
  ├── @cgo
  ├── @rank    SEO / search-demand strategist
  └── @tank    GEO / LLM-visibility analyst
```

The split matters: `@tethr` is the **interface between the human team and the agents** and the
router for every surface. `@ceo` heads the mission org and holds priorities. System agents sit
*beside* the org, not inside the CEO's command chain — the Company page renders them in a
separate "System · infrastructure" section.

`reportsTo` is **org-chart only**. Routing is table-based (rows in each agent's profile), so
changing the chart never changes where a request goes.

**How you talk to it:** tag `@tethr` in Slack, DM the bot, use the Console chat, or run the CLI.
All four hit the same `routeRequest`.

Notable agents:
- **`@tinkr`** modifies existing agents (rename, title/mission, budget, spec, pause/resume,
  schedule). Every change is staged as a gated `org_change`; approving *applies* it and logs
  before/after in `tethr_org_changes`. **Revert is git-style** — the Company page's Revert button
  stages the *inverse* change through the same gate. History is append-only. Guardrails:
  `@tethr`/`@ceo`/`@tinkr` can't be renamed or paused, $100/mo ceiling, no create/delete.
- **`@patch`** reads the failure log (`tethr_route_runs` where status=failed — DB only, no
  filesystem, company-scoped) and writes a Claude-Code-ready fix report into `07 Debug/`.
  Read-only; it never applies a fix.
- **`@rank` / `@tank`** are the marketing specialists, grounded in Wandr's actual marketing docs.
  `@rank` enforces a hard catalog-fit gate (only topics routing to a real Wandr Rx). `@tank`
  audits AI-citation readiness — it *infers* citation likelihood from auditable signals, since it
  has no tool to query the engines directly.

The old **Wandr Growth** org (22 subagents, 4 divisions) is **archived on first boot, never
deleted** — it's the parts bin for re-adds, its seed still ships, and its tests still run.

Budgets: $100/mo company line, per-agent hard-stops ($25 `@tethr`, $50 `@radar`, $10-15 for the
rest), `hardStopEnabled: true` on every policy.

---

## 7. Seeding and boot heals

`seed/` holds one file per agent plus `seed.ts` (dispatcher), `tethr-core.ts` (the org),
`wandr-growth.ts` (the legacy org). **Every seeder is additive and idempotent** — safe to re-run.

```bash
curl -X POST http://localhost:3100/api/tethr/seed -H 'content-type: application/json' -d '{}'
```

Because routing tables and specs live in the **DB**, re-seeding doesn't fix an already-seeded
org whose rows are stale. That's what the boot heals in `maybeAutoSeed` are for — each is
idempotent and best-effort:

| Heal | Fixes |
|---|---|
| `reapOrphanedRouteRuns` | runs left `running` by a crash |
| `healInboxApprovedOutputs` | outputs desynced by the retired core Inbox |
| `healTethrRoutingCopy` | stale routing-table copy on `@tethr`/`@ceo`, and row order |
| `healSystemAgentParents` | re-parents system agents from `@ceo` to `@tethr` |
| `backfill-tools` | gives pre-0093 factory agents a read-only research default |

**If you change seeded copy or structure, you almost certainly need a matching heal.** This is
the single most common source of "it works on a fresh DB but not on mine".

Two related landmines, both already hit once:
- **The core Inbox is retired — the Queue is the ONLY approval surface.** The Inbox's Approve
  called core `POST /approvals/:id/approve`, which flips the approvals row but never calls
  `gating.decide`, so the item vanished from the Inbox while the output stayed silently gated.
  `/inbox*` now redirects to `/queue`. **Never edit core Inbox/approvals files to "fix" Tethr
  approvals.**
- **Watch the mock keyword scorer** when editing routing copy. `llm/mock.ts` `tokenize` keeps
  tokens longer than 2 chars, so common words ("the", "org") leak into the score and can perturb
  routing tests. Keep routing copy free of stopword noise.

---

## 8. Surfaces

### 8.1 REST

`server/src/routes/tethr.ts` — 53 endpoints under `/api/tethr`. The shape:

```
POST /tethr/:companyId/route                 the entry point every client uses
GET  /tethr/:companyId/route-runs/:id        poll for hops + result
GET  /tethr/:companyId/overview              org roster + divisions
POST /tethr/:companyId/outputs/:id/decide    approve / reject / request changes
GET  /tethr/:companyId/drive…                internal DB drive (+ folder/move/archive)
GET  /tethr/:companyId/fsdrive…              the synced Google Drive folder (+ mounts)
GET  /tethr/:companyId/mirror/tree           live read-only view of 00 Tethr
GET  /tethr/:companyId/budgets · /audit · /memories · /runs · /notifications
GET|POST /tethr/:companyId/throttle          the global pause switch
GET  /tethr/:companyId/status                LLM backend, storage, mirror, sha
GET  /tethr/health/deep                      200/503 for an uptime pinger
POST /tethr/slack/events                     Slack Events API (signature-verified)
POST /tethr/seed                             idempotent re-seed
```

Every company-scoped route runs `assertCompanyAccess`.

### 8.2 UI

`ui/src/pages/tethr/` — Console, Company, Queue, Drive, Runs, Budgets, Audit, Memory, Settings,
AgentPage.

**Brand lock, restate it in any UI prompt:** Urbanist + JetBrains Mono, pure black/white, 2px
borders, **no gradients, no color, no emoji**, minimal wireframe aesthetic, light + dark +
mobile. Edit brand **only** via `ui/src/lib/brand.ts` and `ui/src/styles/tethr-theme.css`.

The Drive page is a real file manager: the Google-Drive-synced `00 Tethr` folder is the main
view, with toggles for Tethr's internal DB drive and other allowlisted Drive folders — all three
through one drag-and-drop component (`drive/FileManager.tsx`, `@dnd-kit`). Agents never reach
any of the fs ops; those are UI-only.

### 8.3 Slack

Both directions run through `server/src/tethr/slack.ts`, gated on env so local dev stays offline.

**One channel: `#tethr` (`C0BGK29482J`, private — the bot must be invited).** Everything lands
there: recommendations, approval nudges, overseer posts, the weekly spend digest, launcher
up/down posts. The env knob keeps its legacy name `SLACK_SCOUT_CHANNEL` for deploy continuity;
the code default is `DEFAULT_TETHR_CHANNEL`.

Inbound has two transports and one handler: **Socket Mode** (`SLACK_APP_TOKEN`, no public URL —
the local-first path, Node ≥22 for global WebSocket) and the **Events API** (signature-verified,
for cloud). Both go `interpretSlackEvent` → `routeInboundKickoff` → the router. A DM treats any
text as a request; a channel needs a mention or a link. Answers post back into the originating
thread.

Two details you'd otherwise rediscover the hard way:
- Outbound text passes through `toSlackMrkdwn` — GFM headers/bold/tables/links → Slack mrkdwn
  (tables become labelled bullets). Never post raw markdown.
- Inbound images are normalized through **sharp** (decode, EXIF-rotate, resize ≤1568px,
  re-encode JPEG) so iPhone HEIC works, and a non-image (e.g. the Slack login page you get back
  when the app lacks the `files:read` scope) throws in sharp and is dropped with an actionable
  log instead of 400-ing the request. **The Slack app needs `files:read`.**

### 8.4 CLI

`scripts/tethr-cli.mjs` — single-file, **zero-dependency** Node ≥20 client (plain `fetch` +
`node:readline`). One-shot or REPL. Routes through the same REST surface the Console uses;
streams hops live. Commands: `/queue`, `/approve`, `/reject`, `/agents`, `/status`, `/runs`,
`/new`. Auto-finds the local port when `TETHR_URL` is unset.

No npm package — the file *is* the executable; `tethr-cli-install.sh` symlinks it onto PATH.
Security: adds no new privilege, `TETHR_TOKEN` is env-only and never printed, **nothing is
written to disk**, approve/reject need an explicit id and echo the item. The real boundary is
network reach — the server binds loopback by default; remote access is Tailscale or
authenticated mode. See `LOCAL.md` §6.

### 8.5 Command Center (macOS app)

`scripts/tethr-command-center/` — a zero-dep local http server over the synced `00 Tethr` folder
plus a vanilla-JS UI, wrapped by `macapp/main.swift` (~200 lines, AppKit + WKWebView) into a real
`.app`. Independent of the Tethr server and DB — pure fs. Same safety parity as `fsdrive`:
loopback-only, root-confined, soft archive, sanitized names, escaped MD. Child process lifecycle
is leak-proof in both directions (Swift traps SIGTERM/SIGINT; the server self-exits if the parent
vanishes, via `TETHR_CC_PARENT_PID`). Built app is gitignored.

---

## 9. Where deliverables land

Two drives, and the distinction matters:

1. **Internal Drive** — `tethr_drive_nodes` / `_versions` in Postgres, bytes via core
   `StorageService`. This is the **system of record**.
2. **Shared workspace** — the Google-Drive-synced `00 Tethr` folder on disk. `mirror.ts` projects
   every published deliverable there as a plain file; the Drive desktop client uploads it. **Zero
   Google credentials required** (the service-account API path hit permission blocks; that's V2).

The projection is **write-once-per-publish**, tracked in `tethr_outputs.meta.mirror`. Humans can
freely delete, move, or rename in the folder and nothing breaks or resurrects — backfill skips
anything with `meta.mirror` set unless you pass `?force=true`.

Taxonomy (strict kind allowlist — `answer`, `agent_proposal`, `org_change` **never** mirror):
`01 Briefs` · `02 Documents` · `03 Research` · `04 Content/{Blog Drafts,Press,Itineraries}` ·
`05 Ads & Analytics` · `06 Strategy` · `07 Debug` · `99 Archive` (human-only).

Agents can redirect with `[file-under: …]` and `[format: md|pdf|pptx|docx]` directives atop their
output (parsed and stripped in `worker.ts`, sanitized, and shown in the approval). Renderers live
in `mirror-render.ts` (marked + playwright for PDF, pptxgenjs, docx — all dynamic imports that
fall back to `.md`).

The single live call site is `gating.publishToDrive`, best-effort — **a mirror failure never
fails a publish**. Collisions resolve via output-uuid front matter; writes are same-dir dot-temp
plus atomic rename.

---

## 10. Deploy

Config-as-code in `railway.toml` — builds the root `Dockerfile` (multi-stage; the `production`
stage serves UI + API on `:3100`), healthcheck `/api/health`. One managed Postgres.

**Not yet deployed.** `railway login/init/up` needs Mark's account.

Two things to know before the first deploy:
- **Railway wipes the container FS on redeploy.** All durable data is in managed Postgres and
  survives; only uploaded Drive file *bytes* (local_disk) are lost. Attach a Railway Volume at
  `/paperclip`, or do the S3/R2 swap.
- **First-run auth** defaults to `authenticated`/`private`; the first visit creates the admin
  login (better-auth, stored in Postgres).

Env vars live as Railway service variables, never in git. Cloud swap details for DB / storage /
LLM / notifier / secrets are in `MIGRATION-NOTES.md` — each is one env var or one small provider,
with no caller changes.

---

## 11. Open items an engineer would want to know

- **`@ceo` is currently in `error` status.** Its planning heartbeat (read Drive → plan → draft)
  runs over two minutes on the subscription backend and was hitting the per-call timeout in
  `llm/claude-code.ts`. The ceiling was raised to 600s; the error clears on the next successful
  run. No heartbeats are enabled right now, so nothing is retrying on its own.
- **`master` is ~914 commits behind `upstream/master`.** The longer it sits the harder the merge,
  though the additive design keeps it tractable.
- **`GET /tethr/:companyId/status` reports `"slack (mock)"` unconditionally** — it's a hardcoded
  string in `routes/tethr.ts`, not real state. Slack is genuinely live. Cosmetic, but misleading.
- **`ARCHITECTURE-LOCAL.md` is stale** — it still describes the pre-Phase-11 org (Wandr Growth,
  CEO → Helm, 22 subagents). Layer map and seam descriptions are still accurate; the org section
  is not. `CLAUDE.md` is the current source of truth.
- **`docs/tethr-buildout/MANUAL-STEPS.md` status table is stale** — it lists Phases 2 and 3 as
  blocked on the Slack app and the Anthropic key, but both are configured and running locally.
- **PostHog is not configured** (`POSTHOG_API_KEY` unset), so `@pulse` is inert and `@tank`
  recommends AI-referral traffic (chatgpt.com / perplexity.ai referrers) as a proxy metric.
- **`www.cdc.gov` is a 403 wall** (Akamai blocks every server-side GET regardless of user-agent).
  Use the `cdc_scan` tool, which merges two *fetchable* feeds — CDC travel notices RSS from
  `wwwnc.cdc.gov` and WHO Disease Outbreak News JSON. `web_fetch` short-circuits known bot-walled
  hosts with an actionable redirect rather than letting the model improvise.

---

## 12. Map of the docs

| File | What's in it |
|---|---|
| **`CLAUDE.md`** | the operating contract, kept current every phase. **Start here after this file.** |
| `DECISIONS.md` | every core file touched, with reason — the merge-safe ledger |
| `ARCHITECTURE-LOCAL.md` | layer map and seams (org section is stale) |
| `LOCAL.md` | running locally, Slack setup, CLI remote access |
| `RUNBOOK.md` | ops: restart, kill switches, rollback, uptime, access |
| `MIGRATION-NOTES.md` | the cloud swap: DB / storage / LLM / notifier / secrets |
| `GOOGLE-SETUP.md` | Google Ads, Keyword Planner, Drive service account |
| `docs/tethr-buildout/USING-TETHR.md` | plain-English walkthrough: what's Paperclip vs what's ours |
| `docs/tethr-buildout/MANUAL-STEPS.md` | remaining human actions (status table is stale) |
| `docs/adr/` | architecture decision records (e.g. 0002 memory) |

---

## 13. If you're going to change something

1. Read `CLAUDE.md` first — it's more current than any other doc.
2. Put new code in `server/src/tethr/**`, `ui/src/pages/tethr/**`, or `packages/db/src/schema/tethr_*.ts`.
3. Touching a core file? One line, and log it in `DECISIONS.md`. If it's more than one line,
   raise it before writing it.
4. Changing seeded copy or structure? Write the matching boot heal.
5. Run the Tethr suite. All 262 must stay green.
6. Commit locally. **Don't push or merge without a human.**
