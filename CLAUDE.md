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
- **Specialists** (next: **Journal** — the daily blog writer, renamed from the old "Atlas")
  report to the CEO. Add one at a time, each seeded paused, each a row in @tethr's routing
  table. The old Atlas `blog` subagent spec (in `wandr-growth.ts`) is the reference for
  Journal's flow — but it reads Mark's Drive docs (content calendar, GEO checklist, pillar
  spec, brand voice), so replicating his CURRENT flow needs his input / the Drive.

## Where the Tethr layer lives (all additive)

- `server/src/tethr/**` — the whole L2 engine: `routing.ts`, `worker.ts`, `gating.ts`, `drive.ts`, `org.ts`, `memory.ts`, `notify.ts`, `digest.ts`, `state.ts`, `export.ts`, `adapter.ts`, `index.ts`, plus `llm/` (mock ↔ claude), `tools/` (allowlisted registry), `seed/` (`wandr-growth.ts`).
- `server/src/routes/tethr.ts` — the Tethr REST surface. (`routes/health.ts` = the existing `/health` + `/api/health` health endpoints — reuse, don't add another.)
- `ui/src/pages/tethr/**` + `ui/src/components/tethr/**` — the 10 pages.
- `packages/db/src/schema/tethr_*.ts` — 8 tables (`tethr_divisions`, `tethr_agent_profiles`, `tethr_subagents`, `tethr_route_runs`, `tethr_outputs`, `tethr_drive*`, `tethr_memories`, `tethr_notifications`). Migrations through **0089**.

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

## Drive as a file manager (phase 12, D1 built)

The Drive page is now a real file manager, not a read-only browser. `drive.ts` adds
**human-only** ops — `createFolder`, `moveNode` (reparent + rename; a folder move rewrites
every descendant path in one SQL prefix-swap), `archiveNode` (soft delete = move to
`/archive`, **never** a hard delete). Routes: `POST /drive/folder`, `/drive/node/:id/move`,
`/drive/node/:id/archive` (all `assertCompanyAccess`). UI (`TethrDrive.tsx`): folder tree +
show/hide toggle, move dialog (tree destination picker, self-exclusion), rename, new-folder.
**Agents never call these** — they only `putFile` into their own folders; move/organize is a
person's job. Locked by `tethr-drive-manager.test.ts` (10 tests).

**D2 — point it at the real Google Drive (NOT built; gated on Mark's Google setup, `GOOGLE-SETUP.md`).**
Mark's chosen reach (2026-07-12): **"Tethr + folders you share"** — agents stay locked to the
Tethr folder; the UI can move files between Tethr and any *other* folder Mark shares with the
service account. This needs: (1) scope upgrade `drive.file` → `drive` (drive.file only sees
app-created files — can't list human-added/shared files); (2) new read/list/move Drive API
functions in `google-drive.ts`; (3) per-agent subfolders under the Tethr folder (mirror is one
flat folder today). Full-Drive reach (option "your whole Drive") was declined — it would need
Mark's own OAuth + a whole-Drive token.

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
