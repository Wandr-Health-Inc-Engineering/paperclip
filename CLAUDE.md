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
- **Filer (`@filer`) = the file archivist** (phase 15, 2026-07-19). The ONLY way an agent can
  "delete" a file: ask @tethr ("delete the file …") → routes to `@filer.archive` → the
  **`stage_file_archive`** tool (granted solely to @filer.archive) validates and stages a gated
  **`drive_change`** output with the new **`destructive`** sensitivity → the human confirms in the
  Queue or by replying "approve"/"confirm" in the Slack thread → `gating.approveDriveChange` applies
  a SOFT archive (shared 00 Tethr → `99 Archive` via `fsArchive`; internal Drive → `/archive` via
  `archiveNode`) — **never a hard delete** (grep-proofed). `destructive` is gated AND structurally
  excluded from auto-approve (only `org` auto-approves), so a deletion can never happen without an
  explicit human yes. Validation (`drive-changes.ts`): root-confined, files-only, protected paths
  (99 Archive, /archive, root, root-level "00 " docs + the launcher), unique-basename fuzzy
  resolution in the shared store; apply re-validates — a vanished file closes the output
  `rejected` + `meta.applyError` (Queue never wedges) and Slack says so honestly. Seed:
  `seed/filer.ts` (reports to CEO, $10/mo hard-stop, no heartbeat) in `maybeAutoSeed` + `/seed`.
  Tests: `tethr-filer.test.ts` (11). No DB migration (kind/sensitivity are text columns).
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

### Phase 16 — growth operations control plane (2026-11-07, Mark as COO)

**Identity:** Tethr is Wandr's **growth operations control plane** — its job right now is
**acquiring customers** (go-to-market + growth). Every recurring piece of growth work is a
workflow with an owner, a cadence, a deliverable and a gate; @tethr is the front door, @ceo sets
the weekly growth plan and delegates, specialists do the work as **tasks**, humans approve in the
**Queue**. Patient-data wall unchanged. Plan: `tasks/phase-16.md`.

**Delegation backbone (16a, built) — Tethr now rides Paperclip's tasks (issues):**
- **Agents work tasks.** A wake carrying `context.issueId` (assignment, delegated sub-task,
  roll-up, routine task) runs `executeTask` in `adapter.ts`: load the task (brief, comments,
  children) → claim it (`checkout`) → `routeRequest` at that agent with invocation `task` →
  comment the result → move it (`nextTaskStatus`: answer/published → `done`, gated → `in_review`,
  delegated/open children → `blocked`, failed → left to core recovery). No task id → the old
  standing heartbeat, unchanged. Digest/site_audit/pulse modes run as before and close their task.
- **Agents delegate.** `delegate_task` (tools/internal.ts), granted to `@ceo.plan` + `@tethr.plan`:
  creates a child task for an agent by tag and wakes it (core `createChild` +
  `queueIssueAssignmentWakeup`). From a Console/Slack run with no task, a **root task** owned by
  the delegator is created first. When the last child closes, `tasks.setStatus` wakes the
  parent's owner (`issue_children_completed`) → roll-up run with delegation OFF → root `done`.
  Limits (`TASK_LIMITS`): depth ≤ 2, ≤ 6 children per task, no self/unknown/paused targets.
  Delegated tasks carry `originId = "tethr:delegation"`. Delegators see the live agent roster in
  their system prompt.
- **Queue closes the loop.** Outputs made while working a task carry `meta.taskIssueId`;
  `gating.decide` (now a wrapper over `decideOutput`) moves the task by the output's FINAL status:
  approve → `done` (wakes parent), reject → `cancelled`, changes requested → stays `in_review`
  (revisions keep the link).
- **Why the wake helpers live in tasks.ts:** core wakes parents/dependents in the issue PATCH
  *route*, not the service — Tethr updates via the service, so `tasks.ts` mirrors those side
  effects. No core files edited.
- **Mock:** `parseDelegations` ("delegate X to @rank and Y to @tank") makes delegation
  deterministic offline. Tests: `tethr-tasks.test.ts` (8, incl. full end-to-end chains through
  core's real wake/run loop).
- **Explicit hand-offs go to the head of growth.** A request that names a hand-off ("delegate X
  to @rank and Y to @tank", `parseDelegations` in `delegation-parse.ts`) is routed `@tethr →
  @ceo` before planning/classification, so it becomes tracked tasks instead of one named
  specialist doing it inline. The CEO routing row also claims growth-plan / campaign / delegate
  phrasing (propagated to live orgs by `healTethrRoutingCopy`).

**Growth workflows + growth board (16, built):**
- `seed/growth-workflows.ts` — four recurring growth playbooks as core routines, **all seeded
  PAUSED with their schedule trigger disabled** (Mark switches each on from its routine page):
  Weekly growth plan (@ceo, Mon) · SEO + AI-search content engine (@ceo → delegates @rank +
  @tank, Tue) · Seasonal demand scan (@rank, monthly) · Weekly growth review (@tethr, Fri). The
  routine description IS the playbook — when it fires, core opens a task with that brief and the
  owner works it in task mode. Also reframes @ceo as **"Head of growth"** (title + mission), only
  where they're still the seeded defaults. Wired into `maybeAutoSeed` + `POST /tethr/seed`.
- **Growth board** — `GET /tethr/:companyId/growth` (`growth.ts` `growthBoard`) + page
  `ui/src/pages/tethr/TethrGrowth.tsx` at `/growth` (top of Operate nav): counts, "waiting on you"
  glass cards that deep-link to the Queue item, lanes (Working · Waiting on sub-tasks · Up next),
  done this week, and the workflows with on/paused state. Tests in `tethr-tasks.test.ts` (11).
- Verified live: "plan our spring-break malaria push: delegate keyword research to @rank and a
  GEO audit of the malaria page to @tank" → @tethr → @ceo → WD-2 (@rank) + WD-3 (@tank) worked
  and closed → @ceo roll-up closed WD-1, all visible on the board.
- **Next:** the memory layer (Phase 17: kinds, `remember` tool, relevance recall, editable Memory
  page); Hermes as an agent when Mark installs it (`hermes_local` adapter already in the fork).

### Fresh start — only @tethr (phase 18, 2026-11-07)

Mark's call, the first step of the chat-first Tethr v1 plan (each chat thread will drive one real
Claude Code session with his connectors — built separately under `server/src/tethr/assistant/**`).
The specialists were barely used (in the last 100 requests @tethr handled 35, each of the others
1–9; @ceo sat in an error state), so they are **archived, not deleted**, and Tethr starts fresh with
@tethr alone. Their code and seed functions stay in the repo as the parts bin.
- **Archive** (`seed/fresh-start.ts` `archiveSpecialists(db, companyId)`): finds @ceo @radar @remedy
  @cgo @rank @tank @tinkr @patch @filer by profile tag (@radar/@remedy/@cgo exist only in the DB,
  factory-made) → agent `status: "paused"`, `pauseReason: "archived: fresh start"` (**never
  terminated** — core refuses to resume a terminated agent); pauses their routines and disables
  those routines' triggers (the `archiveWandrGrowth` pattern), plus @tethr's own "Weekly growth
  review" (no default briefs); strips every @tethr routing row whose `to` is one of those tags.
  Idempotent ("ensure archived" — a specialist added later is merged in).
- **Stash = run-once marker:** what it changed (prior agent status/pauseReason/pausedAt, routine
  statuses, enabled triggers, removed routing rows + their index) is written to the instance-dir
  **`tethr-archive.json`** (`TETHR_ARCHIVE_FILE` overrides it for tests). `maybeAutoSeed` and
  `POST /tethr/seed` call `archiveSpecialistsOnce`: a company with any record (archived or
  restored) is never re-archived, so a restore survives restarts.
- **Restore** (`restoreSpecialists`): puts back exactly what was stashed — prior statuses (an agent
  someone had paused keeps its own reason), routine statuses, triggers re-enabled through the
  routine service (fresh `nextRunAt`), routing rows at their old positions. Anything a human
  changed since is left alone. The record flips to `restored`.
- **Routes (humans only — agents get 403):** `GET /tethr/:companyId/specialists/archive` (state),
  `POST …/specialists/archive`, `POST …/specialists/restore` (409 when nothing is archived). Both
  mutations write to the activity log.
- **No more auto-seeding them:** `maybeAutoSeed` and `POST /tethr/seed` run the specialist seeds
  (`seedCeoAgent`, `seedTinkrAgent`, `seedPatchAgent`, `seedFilerAgent`, `seedRankAgent`,
  `seedTankAgent`) and `seedGrowthWorkflows` only when **`TETHR_SEED_SPECIALISTS=true`** — and then
  skip the boot archive (opting in means you want them live). Their suites call the seed
  functions directly, unchanged. `healTethrRoutingCopy` re-adds the @ceo row only when one is
  already there, so it never undoes the strip.
- **Routing fallback:** `routing.ts` `runAgentStep` sends work aimed at a `paused`/`terminated`
  agent to @tethr (a `fallback → @tethr` hop; @tethr's own subagents classify it; the original
  chain keys are dropped). Orgs without @tethr (the legacy Wandr Growth org) keep the old
  behavior. With no @ceo row there's no explicit hand-off either, so a Slack/chat ask never
  reaches @ceo.
- **Company page:** archived agents leave the Organization/System sections and sit in a collapsed
  **Archived** group at the bottom (frost panel, chevron toggle, "Restore all" with an inline
  confirm). Classified by `pauseReason === "archived: fresh start"` (`TETHR_ARCHIVE_PAUSE_REASON`).
- **Cost fix (same phase):** `adapter.ts` reported a run's cost only in `resultJson.costUsd`, but
  core `heartbeat.updateRuntimeState` bills the TOP-LEVEL `result.costUsd` — so live heartbeat and
  task runs recorded $0. It now returns both.
- Tests: `tethr-fresh-start.test.ts` (12 — archive idempotent, routines/triggers off, rows
  stripped, heal doesn't re-add @ceo, restore exact, fallback to @tethr, no @ceo hand-off,
  top-level cost).

## Where the Tethr layer lives (all additive)

- `server/src/tethr/**` — the whole L2 engine: `routing.ts`, `worker.ts`, `gating.ts`, `drive.ts`, `org.ts`, `memory.ts`, `notify.ts`, `digest.ts`, `state.ts`, `export.ts`, `adapter.ts`, `index.ts`, plus `llm/` (mock ↔ claude), `tools/` (allowlisted registry), `seed/` (`wandr-growth.ts`).
- `server/src/routes/tethr.ts` — the Tethr REST surface. (`routes/health.ts` = the existing `/health` + `/api/health` health endpoints — reuse, don't add another.)
- `ui/src/pages/tethr/**` + `ui/src/components/tethr/**` — the 10 pages.
- `packages/db/src/schema/tethr_*.ts` — 8 tables (`tethr_divisions`, `tethr_agent_profiles`, `tethr_subagents`, `tethr_route_runs`, `tethr_outputs`, `tethr_drive*`, `tethr_memories`, `tethr_notifications`; later `tethr_goal_metrics`, `tethr_members`, `tethr_ideas`). Migrations through **0096**.

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

**DB tests as root:** embedded Postgres won't start as root, so the DB-backed Tethr suites
silently skip. Run them as a regular user: `useradd -m tester`, make
`server/node_modules/.vite-temp` and `.vite` writable, then
`su tester -c "cd server && HOME=/home/tester npx vitest run src/__tests__/tethr"`.

**Cloud container / running as root:** embedded Postgres refuses to init as root. Use the
system one instead: `service postgresql start`, set the `postgres` password, `createdb paperclip`,
then `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/paperclip PAPERCLIP_MIGRATION_AUTO_APPLY=true pnpm dev:once`.

First boot auto-seeds an unnamed starter company, **"Your company"** (`TETHR_STARTER_COMPANY_NAME`
in packages/shared, prefix `WD`, no description; setup step 1 names it, and the seed finds it again
by its prefix, never by name), with one agent, **Tethr**
(`@tethr`), with `chat` + `plan` subagents, an Operations division, budgets ($100/mo company
line, $25/mo Tethr cap, hard-stop on) and a Drive README; any existing "Wandr Growth" org is
archived (recoverable), never deleted; the specialists stay archived (phase 18 fresh start). No Docker / external DB / API key needed: embedded
Postgres + deterministic **mock LLM** out of the box. Docker path: `make compose-up` (Postgres 17 + server + bundled
UI on :3100). Re-seed (idempotent, instance admins only; a local curl in local_trusted mode is the admin): `curl -X POST http://localhost:3100/api/tethr/seed -d '{}' -H 'content-type: application/json'`.

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
| `TETHR_SEED_SPECIALISTS=true` | seed the archived specialists (CEO/Tinkr/Patch/Filer/Rank/Tank) + growth workflows on boot and `/seed` again, and skip the fresh-start archive (default off: only @tethr, phase 18) |
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

## Slack (#tethr)

Both directions run through `server/src/tethr/`, gated on env so local dev stays offline.

**One channel: `#tethr` (`C0BGK29482J`, private — the bot must be invited).** Consolidated
2026-07-24 (Mark's call): everything Tethr says in Slack lands here — agent recommendations,
gated-approval nudges, overseer DMs' channel posts, the weekly spend digest, and the desktop
launcher's server up/down posts. `#scout` (`C0AE02FJR5Y`) is retired as a Tethr target; older
docs/phase files below still say "#scout" where they describe the loop's *shape* — the channel
id is the only thing that moved. The env knob keeps its name (`SLACK_SCOUT_CHANNEL`) so existing
deploys don't break; the code default is `DEFAULT_TETHR_CHANNEL` in `slack.ts`.

- **Outbound:** the `Notifier` `slack` channel (`notify.ts`) posts real `chat.postMessage`
  when `SLACK_BOT_TOKEN` is set, else logs. Default channel **#tethr** `C0BGK29482J` (override
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
- **Thread approvals are approver-only (2026-11-07 fix).** Replying "approve"/"reject" in a Slack
  thread decides its pending gated item ONLY when the sender's Slack member id is on the overseer
  roster (Settings → overseers) or in `TETHR_SLACK_APPROVER_IDS` (`U123:Mark,U456`); anyone else
  gets "decide it in the Queue" and nothing is applied. The approval is logged as "<name> (Slack)"
  (was a hard-coded "mark (Slack)" for any replier). `resolveSlackApprover` in slack.ts; locked by
  `tethr-slack.test.ts` + `tethr-tinkr.test.ts`. **Manual step:** set the three Slack IDs in Settings
  (MANUAL-STEPS C6a) or Slack thread approvals are refused.
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
it). `SYSTEM_ORDER = ["@tethr","@tinkr","@patch","@filer"]` classifies by `profile.tag`; system agents are
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

## Chat (formerly the Console) — one ongoing chat + side chats (phase 17, 2026-11-07)

Mark's model (after using Claude's chat-style products): the Console is a chat, ChatGPT/
Hermes-like. **One ONGOING main chat with @tethr** that everything goes into by default, plus
**side chats** he opens on purpose for a focused task or side project. "Don't rework
everything yet" — the app shell and other pages are unchanged; only the Console route was rebuilt.
**Renamed "Chat"** (Mark: "I don't like that it's called console"): route `/chat`
(`ui/src/pages/tethr/TethrChat.tsx`, export `TethrChat`), `/console` redirects there, nav/palette
label "Chat". Run records still store `invocationSource: "console"` (data, unchanged).
- **Main chat = a normal routing thread whose `threadId` is the company id** — stable across
  devices, no storage (a run id can never equal a company id; routing only reads `threadId` to
  load the last 5 turns, trimmed, as context, so cost doesn't grow with the chat).
- **Side chats** = ordinary threads (threadId = first run id) listed in the instance-dir
  `tethr-chats.json` (`server/src/tethr/chats.ts`, `TETHR_CHATS_FILE` test override). Old
  one-off Console requests are NOT listed (they stay in Activity). Closing a side chat only
  drops it from the list.
- **Routes:** `GET /tethr/:companyId/chats` (main + side chats with run counts/last activity),
  `POST /chats {request}` (opens a side chat with its first message), `DELETE /chats/:threadId`
  (main can't be removed), `GET /chats/:threadId/runs?limit=` (newest runs oldest-first, each
  with its outputs). `routing.listThreadRuns` / `threadStats` back them.
- **UI** (`TethrChat.tsx`) — **one area, no panel-in-a-panel (Mark's call):** the conversation
  sits directly on the page and scrolls (fading) to the top. A **sidebar icon** at the top-left
  (badge = side-chat count) slides out a glass drawer: the main chat pinned on top ("tethr ·
  Your ongoing chat · always here", pin icon, no remove), then **Team** (phase 23: each agent's
  own chat, below), then side chats (hover X removes one from the list) and New. Beside the icon a chip names where you are: **"tethr ONGOING"** in the
  main chat (Mark, 2026-11-08: "it should be clear it's the main ongoing chat you can't delete"),
  or a side chat's title with a back-to-tethr button. The empty main chat says it's the ongoing
  chat; its suggestions are company-neutral. Messages:
  yours on the right; reply = route chips expandable to the full RouteFlow, status + time, the
  answer as Markdown, filed outputs as links. Pill composer at the bottom (Enter sends). URL: `/chat` = the ongoing chat,
  `?chat=<threadId>` = side, `?chat=new` = a side chat being started. **Gated outputs render as
  inline approval cards (Mark's pick) calling the same `outputs/:id/decide` endpoint as the
  Queue** — same gate, the Queue still lists everything. (The bell's "ask tethr" was removed
  2026-11-10; a notification opens its card instead.) Locked by `tethr-chats.test.ts`.

## Chat on a real Claude session (phase 18, 2026-11-07) — the v1 core

Approved plan: each Chat thread drives ONE Claude Code session (resumed per thread) with
Mark's claude.ai connectors, instead of Tethr's multi-agent routing (which averaged 35s/reply,
remembered nothing Mark said, and could only read). Spike findings: `tasks/phase-18-0-spike.md`.
- **Runner** `server/src/tethr/assistant/runner.ts` (`getAssistantRunner(db).send/stop`) calls
  core's claude-local adapter `execute()` directly (`getServerAdapter("claude_local")`):
  `promptTemplate:"{{context.tethrPrompt}}"` (no work-loop contract), persona via
  `instructionsFilePath` (static — changing it forces fresh sessions), one Tethr skill via
  `paperclipRuntimeSkills` (keeps Paperclip's curl skill out), `dangerouslySkipPermissions:false`,
  extraArgs `--settings <per-turn> --permission-mode dontAsk --include-partial-messages --tools
  <builtins>`. One row in `tethr_route_runs` per turn (`invocationSource:"chat"`, statuses
  queued/running/done/failed/stopped; text streams into `resultText`, tool steps into `hops` —
  no raw tool results stored). One turn per thread, ≤2 concurrent. Checks throttle + budget
  block before each turn; records tokens via `costService.createEvent` (heartbeatRunId null;
  subscription = 0¢). Session per thread in `tethr-chats.json` (`sessions`); rotates past ~150k
  context tokens.
- **Two env must-haves (verified):** `ANTHROPIC_API_KEY: ""` in the child env (the instance
  .env holds an old API key; without blanking it the CLI fails "Invalid API key" instead of using
  Mark's subscription login; opt out with `TETHR_ASSISTANT_BILLING=api`), and
  `MCP_CONNECTION_NONBLOCKING: "false"` (otherwise a RESUMED turn starts before claude.ai
  connectors reconnect, Claude Code marks their tools "removed", and the model says the connector
  is down). Never pass `--strict-mcp-config` (it drops the connectors) or `--bare` (drops hooks).
- **Workspace** `assistant/workspace.ts`: `00 Tethr/tethr/` (Drive-synced; fallback instance
  dir): generated `CLAUDE.md` (rewritten only if it carries the marker) + `@Memory.md` (long-term
  memory Claude edits on "remember…"; edits are seen on resume) + `files/` for deliverables.
- **Approval gate** (`assistant/gate.ts` + `policy.ts` + `POST /tethr/hooks/:phase`): a
  PreToolUse/PostToolUse hook script (content-addressed in the instance dir) forwards every tool
  call with a per-turn bearer token; pre **fails closed**. `classify()` → read / draft / write /
  public (email or invite outside `internalAddresses`) / money (Stripe writes, all Mercury) /
  medical / builtin / workspace / shell / blocked; `decide()` by connector mode off/read/ask/auto
  (money/public/medical always ask). Built-in reads only inside 00 Tethr; writes only inside the
  workspace; `CLAUDE.md` protected; Bash off unless `shell:"ask"`. Deny messages start
  "Tethr approval gate:" and the persona says they're genuine (otherwise the model treats them as
  injections).
- **Smooth streaming (2026-11-08, Mark: "the text comes out in clunks"):** the runner flushes
  `resultText` every 250ms and the chat polls every 500ms, so text lands in bursts.
  `components/tethr/StreamingMarkdown.tsx` reveals it word by word, trailing the stream by ~0.7s
  (`lib/tethr-stream.ts`: `targetRate`, `smoothRate`, `revealEnd` cuts at word ends and holds back
  bare list/heading markers, `closeOpenMarkdown` closes an open fence/inline code/bold). Each new
  word fades up from a soft blur: a rehype plugin wraps words in `span.tethr-w`; the components are
  module-level so react-markdown's positional keys keep old words mounted and only new ones play
  the fade (core `MarkdownBody` builds its components per render, which remounts everything, so
  it's used only once the reveal has caught up). A turn already finished on load shows whole. The
  chat follows the growing answer with a ResizeObserver. Tests: `ui/src/lib/tethr-stream.test.ts`.
- **Approvals (phase 18.3)** `assistant/grants.ts` + `hook-handler.ts`: an "ask" call becomes a
  gated Tethr output kind **`external_action`** (sensitivity `external`, or `public`/`spend`/
  `medical`; both are text columns → no migration) with `routeRunId` = the turn (inline chat
  card) → Queue item + Slack DM like any gated output. `gating.decide` approve →
  `approveExternalAction`: status `approved`, a ONE-TIME grant (thread + sha256 of the canonical
  tool input, 24h) and a wake: a note with the exact call + a system turn ("Mark approved: …").
  The gate consumes the grant atomically (`consumeGrant`, `for update skip locked`) → the call
  runs once; PostToolUse closes the card `published`. Reject → note for the next turn, no wake.
  Same call again needs a new approval; a changed input never rides on one. Default mode is now
  **ask** (approval required); Auto per connector in Integrations (money/public/medical still ask).
  Persona: never self-confirm — make the call and let the gate ask; "Notes from Tethr" /
  "[From Tethr, not Mark]" are genuine. Auto-revise is skipped for `external_action`.
- **Integrations page (phase 18.4)** `TethrSettings.tsx` (route `/tethr-settings`, nav "Integrations"): per-connector
  Off/Read/Ask/Auto (`KNOWN_CONNECTORS` + tools seen on real turns; headless init doesn't list
  claude.ai connectors, so no probe), scope notes (Gmail/Slack/Drive), default mode, inside-Wandr
  addresses, shell Off/Ask, chat model + engine, throttle + overseers; old provider cards folded
  under "Classic engine". `GET|PUT /tethr/:companyId/integrations` (`sanitizeIntegrationsPatch`:
  Mercury never Auto; people only).
- **Config** `server/src/tethr/integrations.ts` → instance-dir `tethr-integrations.json`:
  defaultMode (ask), per-connector mode + scope (Mercury/Canva/Figma off), internal
  addresses, shell, `assistant{engine session|routing, model}`, discovered tool names (from real
  turns). `GET|POST /tethr/:companyId/chat-engine` is the rollback switch.
- **Routes:** `POST /tethr/:companyId/chats/:threadId/messages`, `POST /chats` (side chat via the
  runner), `POST /chat-turns/:runId/stop`, `POST /chats/:threadId/reset`. UI `TethrChat.tsx`
  `SessionTurn`: streaming answer (`StreamingMarkdown`, below), then (while it runs) one "background task" pill at the foot
  of the turn (`Working`: nebula, what it's doing, elapsed, "N steps" that opens the list, Stop),
  and after it a one-line steps summary under the answer (`StepsSummary`). Steps never list
  above the answer, so the text doesn't jump (Mark, 2026-11-08). File chips; approval cards have
  Approve / Reject / **Reply** (`CardReply`: sends `About your request "<title>": …` to the
  thread and leaves the card open; the per-turn CLAUDE.md "Talking with the team" tells tethr to
  answer it and not repeat the call). Older routing-engine turns keep `Turn`.
- **Side panel + Memory page (phase 18.5)** — files open in the chat like Claude artifacts:
  `ui/src/components/tethr/OutputPanel.tsx` is an opaque (`tethr-window`) right slide-out (~600px /
  52%; full-width sheet on phones; Esc/X closes; Drive link) that reuses the Drive's `PreviewBody` +
  `fsSource(c,"mirror")`. File hops are stored relative to 00 Tethr (`tethr/files/x.md`); the chat
  lists a thread's files (`panelFilesOf` in TethrChat.tsx, version = latest run+step so a re-edit
  refreshes) and **auto-opens a file that lands while you watch** (not on page load; Memory.md edits
  only show a chip). The conversation pads right so nothing hides under the panel.
  **Memory page** (`TethrMemory.tsx`, Company → Settings → Memory) now reads/edits **Memory.md**
  (the chat's real memory; preview ↔ edit, Save). `GET|PUT /tethr/:companyId/assistant/memory`
  (`readMemoryFile`/`writeMemoryFile` in workspace.ts): a save must echo the file's mtime — if
  Claude edited it meanwhile → 409 with the newer content, and the UI offers "Load tethr's version"
  / "Keep mine". Atomic write, people only, activity-logged. The old `tethr_memories` log is folded
  under "Older agent log". Verified live: checklist file → panel auto-opened + file in Drive;
  "remember …" → Memory.md edited → a NEW side chat recalled it with no tool call; editor save +
  stale-save 409.
- **Security hardening (phase 18.6, after a full review)** — keep these invariants:
  - **The chat writes ONLY `files/**` and `Memory.md`** in its workspace (`workspaceWriteRefusal`
    in policy.ts): never a dot path, `CLAUDE*.md` or `.mcp.json` (case-insensitive). Verified
    live: a hook in `<workspace>/.claude/settings.json` RUNS under `claude -p` (no trust dialog),
    so a planted settings file = shell on Mark's Mac. Because the workspace is in a SHARED Drive
    folder, `ensureWorkspace` also sweeps `.claude`/`.mcp.json`/`CLAUDE.local.md` (root) and nested
    `CLAUDE.md` (under files/) into `<assistantHome>/quarantine/<ts>/` before every turn (activity
    `tethr_workspace_quarantined`). `--setting-sources user` would block project hooks but ALSO
    stops CLAUDE.md (memory) loading, so it's not used. External `@` imports (outside the
    workspace) don't load under `-p` (tested), so Memory.md can't pull in other local files.
  - **Web pages after connector data ask:** once a thread's session uses any connector it's
    "tainted" (`chats.ts` `tainted`, persisted); then `WebFetch` to a host outside
    `internalAddresses` domains is an approval card (a URL can carry data out). `POST
    /chats/:threadId/reset` clears it with the session.
  - **Always ask:** money, public (incl. a Gmail reply/forward with no explicit recipients),
    medical, and the new **destructive** class (Drive trash/update, Gmail trash, Calendar delete,
    Sheets clear, Docs delete, delete/trash/remove verbs) — sensitivity `destructive`.
  - **Approval cards show exactly what runs:** every input field, full text, rendered as PLAIN
    text in the chat card and the Queue (never Markdown); calls over 30k chars are refused.
    A failed approved call records `grant.status: "failed"`, not "Sent".
  - **Only a person drives the chat:** messages / side chats / stop / reset / chat-engine
    require a user actor (agents get 403).
  - **Stores:** every instance-dir JSON write goes through `tethr/atomic.ts` (`writeAtomic`,
    random temp names; `serialize` per-file read-modify-write). Turn setup errors fail the turn
    (never stuck "running"); session rotation uses the LAST call's prompt size (the result usage
    is summed over the turn).
- Tests: `tethr-assistant-policy` (16), `-events` (7), `-runner` (8, embedded PG, fake execute),
  `-gate` (13: hold → approve → run once → done; no replay; expiry; reject; auto vs always-ask;
  full plain-text card; size cap; web taint; failed send), `-memory` (4), `tethr-atomic` (3),
  `tethr-integrations` (6).

## Tethr tools in the chat — Jev list scoring (phase 19, 2026-11-07)

Mark's pick for **Jev** (TypeSafe AI's decision model: yes/no probabilities, pick-from-list,
0–N scores; it never writes text; ~$0.042 per million input tokens, output free) is **scoring
growth lists**. The chat's Claude session gets Tethr's own tools as an MCP server named
**`tethr`** (plan: `tasks/phase-19.md`):
- **Bridge:** each turn passes `--mcp-config <file>` (per-turn, mode 0600, deleted after the turn;
  it holds the turn's hook token). The config points at a zero-dependency stdio bridge script,
  `assistant/tools-bridge.ts` `BRIDGE_SOURCE`, content-addressed in the instance dir like the hook
  script.
- **Server side:** the bridge forwards `tools/list` and `tools/call` to
  `POST /api/tethr/assistant/tools/:op`, which uses hook-token auth. The work runs in the server,
  so the TypeSafe and Google Ads keys never reach the Claude process.
- **Never use `--strict-mcp-config`:** it would drop Mark's claude.ai connectors.
- **Tools** (`assistant/tethr-tools.ts`):
  - **`keyword_ideas`**: Keyword Planner volumes; `save_as` writes a CSV of every idea.
  - **`score_list`**:
    - Takes `items` or `from_file` (a CSV, JSON or line file in `files/`, root-confined), plus up
      to 8 criteria: `score` levels (worst first), `yes_no` (`want: no` when yes is bad), or
      `choice`.
    - Sends one Jev request per item, 8 at a time, retrying 429/529. A weighted 0–100 composite
      ranks the list, and answers Jev was unsure of are flagged "check".
    - Writes every row to a CSV (text that a spreadsheet would run as a formula gets a leading
      `'`).
    - At most 500 items per call. A `from_file` list over the limit scores its first 500 rows,
      with a note.
    - A bad key (401) or a malformed question (422) stops the run early.
- Jev client: `server/src/tethr/jev.ts` (raw fetch).
- **Gate:**
  - Connector **"Tethr tools"** (server `tethr`) is class `read`: allowed unless set Off in
    Integrations.
  - Off adds the deny rule `mcp__tethr`, skips the bridge, and the endpoint refuses too.
  - These tools don't taint the thread. Unknown `mcp__tethr__*` tools are blocked.
  - Items go to TypeSafe's servers; Jev doesn't train on them, but keep patient data out.
- **UI:**
  - A tool call with `save_as` becomes a file hop, so the CSV is a chip and opens in the side
    panel.
  - CSVs now render as a table in the panel and the Drive (`filePreview.tsx` `CsvTable`, first
    500 rows).
  - Integrations shows whether Jev is connected.
- **Env:** `TYPESAFE_API_KEY` (blank = score_list says so and Claude scores the list itself),
  `TETHR_JEV_MODEL` (default `jev-latest`), `TYPESAFE_API_URL`. The key is Mark's to add
  (MANUAL-STEPS C6c).
- **Verified live against a local stand-in Jev:**
  - real Google keyword ideas (518), then score_list from the file
  - the CSV chip opens as a table
  - a 518-row file scores its first 500 in a 16s resumed turn
  - The model name in the result shows when scores came from the stand-in; Claude flagged the
    identical stand-in scores instead of presenting them.
- Tests: `tethr-jev.test.ts` (18). Jev itself has NOT been called for real: there's no key yet.

**Chat polish + attachments (phase 19.1, Mark's notes):**
- **Type scale:** chat answers use `.tethr-chat-md` (`tethr-theme.css`, unlayered). Upstream's unlayered
  `.paperclip-markdown` (15px, 600-weight headings) beat Tailwind's `text-[14px]`, so answers ran a
  size larger than the bubble and composer. Now everything reads at 14px, inline code at 0.86em
  (weight 400), and headings step up only slightly at weight 500.
- **Composer:** paperclip, text and send arrow are all 36px tall with a 20px line, so their centers
  line up. The hint row lines up with the text start and the arrow's right edge.
- **Attach:**
  - The paperclip button, drag-and-drop or a pasted screenshot upload each file straight away
    (`POST /tethr/:companyId/chats/attachments`, multer, people only, 20 MB, 6 per message).
  - Types: images, PDFs and text only, since Claude's Read can't open Office files.
  - Uploads go to `<workspace>/files/uploads/<date>/` (safe names, never overwrite, Claude config
    names refused) and sync to Drive.
  - The message carries trailing `[Attached file: files/uploads/…]` lines that Claude opens with
    Read (`assistant/attachments.ts`).
  - Send routes validate that each path is a real upload. The runs route splits the markers into
    `attachments` (with `panelPath`), and the bubble shows chips that open in the side panel.
  - Verified live: an attached CSV was read and answered in 8s. Tests:
    `tethr-attachments.test.ts` (5).

**Environment page (phase 19.2, Mark: "like Vercel"):** `/environment` (`TethrEnv.tsx`, nav under
Integrations) edits the instance `.env` (`resolvePaperclipEnvPath()`, i.e.
`~/.paperclip/instances/default/.env`; `TETHR_ENV_FILE` overrides it in tests) through
`server/src/tethr/env-file.ts`.
- **Who can use it:** instance admins only (board actor with `isInstanceAdmin`); agents and plain
  members get 403.
- **Values:** `GET /tethr/:companyId/env` lists names and status only, never values. A value comes
  back only from `POST /env/reveal` (`Cache-Control: no-store`). The activity log records key
  names, never values.
- **Writes:**
  - `PUT /env` and `DELETE /env/:key` keep every other line and comment.
  - A later duplicate of the edited key is dropped, since it would win.
  - Values are quoted so dotenv reads them back exactly; values spanning several lines are
    read-only here.
  - The file is written atomically and set to mode 600.
  - Saving also sets `process.env`, so settings read on demand apply immediately. Boot-time ones
    need a restart, and rows show when the running server's value differs from the file.
- **Page:** "core" keys (`PAPERCLIP_*`, `BETTER_AUTH_*`, `DATABASE_URL`…) ask before changing.
  Pasting `KEY=value` lines adds them in bulk. "Other settings tethr understands" lists the keys in
  `.env.example` that aren't set yet, with their comment notes.
- **Chat hardening that came with it:** the chat's `WebFetch` is blocked for loopback and
  private-network hosts (`isPrivateHost` in policy.ts). In local_trusted mode the Tethr API
  answers loopback requests as Mark, so a fetched page there would read his data.
- Tests: `tethr-env.test.ts` (7). Verified live: added and removed a dummy key, and the real .env
  came back byte-identical.

## Startup intro (2026-11-08)

Mark asked for a startup animation when signing in or opening the desktop client.
`ui/src/components/tethr/StartupIntro.tsx` (mounted once in `App.tsx`) + pure timing/rules in
`ui/src/lib/tethr-intro.ts` + styles at the end of `tethr-theme.css` (`.tethr-intro*`).
- **What it shows (the nebula + a terminal, 2026-11-08):** on the app's own ground, tethr's nebula
  (`Nebula.tsx`, sized in em) swirls in out of a blur and settles, its core flares once, "tethr"
  rises under it in Geist 200, light passes over the reeds. Under it a small black terminal
  (`.tethr-intro-term`, Mark: "a black square typing that says connecting… a bit hacker-ish")
  types `$ tethr connect`, then dot-leader lines `handshake <host> … ok`, `workspace <company> … ok`
  (`new … set up next` while the company still has its starter name), `agents @tethr … online`,
  and `connecting…` until the shell is ready, then `ready.` (the one green). The frames are pure
  (`terminalFrame`/`leaderLine` + `TERMINAL` timings in tethr-intro.ts), written by the same RAF
  clock as the exit, so they finish before `holdMin`. Then the stage lifts away and the shell's own entrance
  (sidebar slide, main rise) plays: `html.tethr-intro-hold` pauses those animations while the
  overlay covers them. Monochrome; the only colors are the status dot and `ready.`.
- **When it plays** (`introReason`): right after signing in (`requestIntro()` in `Auth.tsx` sets
  sessionStorage `tethr.intro.pending`); on desktop app start (user agent `TethrDesktop/`, once
  per app run via sessionStorage `tethr.intro.seen`); `?intro` on first load previews it. Never in
  a plain browser tab otherwise, never on its own on /auth, /invite, /board-claim, /cli-auth.
- **Timing:** leaves at ~1.95s once `#main-content` has rendered (or after 3.5s on a screen
  without it), at most 9s; click or any key skips. A desktop intro that lands on a public page
  (signed out → /auth) counts that page as ready (`introReady`), so it never holds over the
  sign-in form. The timing clock starts on the first painted frame, the same moment the CSS
  animation starts, so they can't drift apart on a slow first frame.
  Reduced motion: a still card, ~0.9s.
- **Desktop app's "not running" page** (`scripts/tethr-launcher/AppWindow.swift`, local-only)
  shows the nebula dim and slowly turning.
- **Dev service worker:** core's `sw.js` registers in production only; in dev, `main.tsx`
  unregisters it and clears its cache (it served hours-old modules after a failed request during a
  dev-server restart, e.g. the old intro). Logged in DECISIONS.md.
- Tests: `ui/src/lib/tethr-intro.test.ts` (when it plays, ready, leaving, the terminal frames).
- **Desktop launcher widget** (`scripts/tethr-launcher/widget.html`, local-only) is Smoked Glass
  too: brand ground + frost cards, a 50px nebula beside "tethr", status as a 6px dot + mono label,
  pill buttons, and the transcript as a black terminal with `$` prompts. The native window
  background matches the ground (main.swift), so nothing flashes white. Rebuild with `build.sh`.

## Desktop app terminal (2026-11-09)

Mark: "a small icon at the bottom I can click… so I don't have a separate terminal." The desktop
app's window has a terminal panel at the bottom.
- **How to open it:** the terminal icon beside the account row at the foot of the sidebar
  (`ui/src/components/tethr/DesktopTerminalButton.tsx`, mounted in core `SidebarAccountMenu.tsx`,
  logged in DECISIONS.md), View → Terminal, or ⌃`. ⌃` puts the keyboard in it; the icon only
  shows it (click into it to type). Hide keeps the shell running; Restart starts a fresh one.
  The divider drags, and the height is remembered.
- **Where it runs:** in the launcher itself (`scripts/tethr-launcher/TerminalPanel.swift`,
  local-only). `forkpty` starts your login shell (`$SHELL`, as `-zsh`) in the repo, with
  `TERM=xterm-256color`, the first time the panel opens (not at every launch). xterm.js 6
  (`vendor/xterm/`, MIT, bundled, no CDN) draws it in a second WKWebView that loads `terminal.html`
  from the app bundle. Quitting the app or Restart hangs up the shell and reaps it.
- **Invariants (security review, 2026-11-09):**
  - The page's only command is `{terminal: "toggle" | "state"}` on `tethrApp`, accepted from the
    tethr page's main frame only (`isAppURL`); the app answers with a `tethr-terminal` window
    event `{open}`. **A page never moves the keyboard:** its toggle opens the panel without focus
    and won't close it while you're typing in it (`pageToggleTerminal`). Otherwise a bad page
    could send your typing, Enter included, into the shell, or catch keys meant for it.
  - Keys and output pass only between the terminal's own view and the app (handler `term`,
    accepted only from the exact bundled `terminal.html`, main frame; every navigation refused).
    The Tethr server never sees the shell, and no Tethr page can type into it or read from it.
  - The shell starts clean: signals at their defaults with none blocked (the app ignores
    SIGINT/SIGTERM, and ignored signals survive execve), and no file descriptor but 0-2 (the
    app's other files, like the dev server's log pipe, are closed in the child; the PTY master
    is close-on-exec).
  - Keys the shell can't take yet wait in an outbox and are retried, so a big paste is never cut
    short and the UI never blocks.
- The icon renders only inside the desktop app (user agent `TethrDesktop/` and the `tethrApp`
  handler), never in a browser. Test: `DesktopTerminalButton.test.tsx` (2).
- **It wears tethr's theme** (Mark: "needs to be cohesive"). The app window's theme probe sends
  tethr's stored choice (`paperclip.theme`: system/light/dark, polled each second because Night →
  Auto on a dark Mac changes no class) and the page's color tokens. The window's appearance is
  pinned for Day/Night and left to the Mac for Auto (pinning on the resolved color froze Auto,
  since the page reads the Mac through the window). The terminal takes Day/Night from its own
  view's appearance (pushed by `viewDidChangeEffectiveAppearance`, because a background page's
  media-query event doesn't always fire), and the tokens (`TerminalTheme`: known names, plain
  hex/rgb() values only) color it as the Finder's `tethr-window` surface on the ground with the
  12px gutter. Geist/Geist Mono are bundled in `vendor/geist/` (OFL); the terminal loads nothing
  from the network. The widget and the status page follow the same choice.
- **One window (Mark, 2026-11-09):** the app opens the Tethr window only, and it shows a status page
  (starting / not running / error with Start and Copy error) until the server answers. Closing it
  (X) keeps tethr running in the background and brings up the small widget (preference *Show the
  Widget When the Window Closes*); opening the window hides the widget; Window → Widget (⇧⌘L)
  toggles it. Closing windows never quits (`applicationShouldTerminateAfterLastWindowClosed` is
  false); ⌘Q does, and stops tethr only if the app started it.
- **Rebuild** the app with `scripts/tethr-launcher/build.sh` after changing the launcher; a
  running app picks up the new build when it's reopened.

## tethr as a product: company, team, goals that adjust, ideas (phase 21, 2026-11-08)

Mark's notes after the onboarding walkthrough: tethr will be sold as its own product, so onboarding
starts with the company; the mission is built in; goals stay realistic on their own; tethr adapts
its pace so nobody is overwhelmed; and **tethr watches** (if Mark and Alec talk about something in
Slack, it suggests an idea). Plan: `tasks/phase-21.md`.
- **Company and team (21.1).**
  - **Members:** `tethr_members` (migration 0096): name, email, position (preset key), title, role
    admin/member, status active/invited, `user_id` (null until hosted logins), `slack_user_id`.
    The admin is created in setup step 1. Invites are "coming soon".
  - **Positions:** `positions.ts`, each with a one-line focus (CTO: tech fixes that give clients a
    better experience).
  - **Mission:** built in (`mission.ts` `TETHR_MISSION`). The root goal is
    "<Company>: grow with a small team", kept in sync by `companyProfileService.saveCompanyStep`
    (`company.ts`). The chat's `save_goal` saves areas only and can't touch the root goal.
  - **What the chat reads every turn:** CLAUDE.md gets `## The company` and `## Your team`
    (`companyContextText`), marked as data, plus `## Goals`.
  - **No hard-coded names:** the persona is company-neutral (static: changing it forces fresh
    sessions). The rhythm playbooks, interview brief, tool descriptions and gate wording ("approval
    in tethr", "[From Tethr, not the user]") no longer name Wandr or Mark.
  - **Slack approver:** the admin's Slack member ID can approve from Slack (`slack.ts`).
- **Goals that adjust themselves (21.2, `goal-pace.ts`).**
  - **Setup choice:** growth pace Steady/Balanced/Ambitious (+5/15/30% on the trend) and
    `autoAdjust` (on by default).
  - **When:** after each measurement recorded through `recordMeasurementAndReviewTarget` (the chat's
    `record_metric` and the REST route; `goals.recordMeasurement` itself only records), with 3 or
    more points, if the target is more than 15%
    off "realistic" (trend projected to the date, plus uplift, never below the start or latest) and
    the last 2 points agree it's behind or ahead.
  - **How far:** halfway there, at most ±25% per change, once every 14 days, never in the last week.
  - **Recorded:** in `tethr_goal_metrics.adjustments`, the activity log and a bell notification of
    kind `goal`. The scorecard tile says "tethr eased it from 200 on …".
  - **Interview:** the brief proposes trend-plus-pace targets and still saves only what's agreed.
- **Ideas pace (21.4, `pace.ts`).**
  - **Mechanism:** a token bucket per company in `tethr-pace.json`.
  - **Levels:** Light (about 3 a week), Normal (about 1 a day), Busy (about 3 a day).
  - **Adapting:** useful/answered ×1.25, not now ×0.7, ignored ×0.8, bounded by the level. Two
    ignored in a row double the conversation cooldowns.
  - **Hours:** 8am to 7pm in the setup time zone, weekdays (Busy: weekends too). Ideas outside
    hours are dropped, not queued.
- **The watcher (21.3, `watch.ts`).**
  - **Shape:** one `Watcher` class holds the in-memory state (conversations, cooldowns, idea
    threads); `startWatch(db)` makes the running one and `hearSlackEvent(payload)` feeds it.
  - **Hearing Slack:** `hearSlackEvent` is fed by Socket Mode and the events route. It takes human messages
    in channels, private channels and group DMs tethr is in. DMs to tethr stay requests; a message
    that @mentions tethr puts the conversation on cooldown. Messages stay **in memory only, at most
    2 hours**.
  - **When a conversation counts as settled:** 4 quiet minutes, at least 3 messages with
    substance. Cooldowns: 6 hours per conversation, 2 hours per channel.
  - **Other sources:** a goal behind pace twice or a target just hit (once a week per metric), and
    a quiet stretch.
  - **The idea check:** `askForIdea` sends a **private one-off turn** (`runner.sendPrivate(...)`,
    the `PRIVATE_TURN` style in runner.ts) in the "Ideas" side chat. The model gets the excerpt; tethr's record keeps a one-line
    summary. `--no-session-persistence` means no Claude transcript, and no session resumes. The
    model replies with one 2-4 sentence idea or `NO_IDEA`.
  - **Delivery (`deliverIdea`: `saveIdea`, then Slack, main-chat card, bell):**
    - Slack: a reply in that thread (a channel conversation gets a thread under its last message).
      Goal and quiet ideas go to the admin by DM, else #tethr.
    - The main chat: a card (route run with sourceKey `tethr-idea`, Useful / Not now) plus a
      next-turn note.
    - The bell: kind `idea`.
  - **Outcomes:** a reply in tethr's thread or a main-chat message within 2 hours means answered;
    24 hours with no signal means ignored.
  - **Loop:** `startWatch` in `boot.ts`, once a minute, never under tests. **Nothing happens until
    setup's "Rhythm and ideas" step is saved.**
  - **Routes:** `GET /tethr/:companyId/ideas`, `POST /ideas/:id/feedback {useful|not_now}`. Chat
    runs carry `idea` for the card.
- **Setup page (21.5):** six steps. **Phase 27 reordered them** (Your company, Focus and pace,
  Connections, Rhythm and ideas, On its own, Goals interview; no Finish step): see that section. Routes `PUT /setup/company` and `PUT /setup/focus` replace
  `/setup/basics`; `PUT /setup/rhythm` also takes `ideas`. Slack scopes for listening are
  MANUAL-STEPS C6e.
  - **Guided onboarding (2026-11-08, Mark: "land me fresh… put me through a detailed
    onboarding"):** an untouched setup opens on a **welcome** (`setup/Welcome.tsx`: the nebula, a
    word-by-word "Hello. Let's set up tethr." at monument scale, what tethr is, how setup goes
    with minutes per step, what to have ready, and what's always true), then one step at a time:
    a sticky progress rail (desktop) or segments (phone), "step n of 6 · about m min", the form,
    and beside it a guide from `setup/guide.ts` (`STEP_GUIDE`: why it matters, what tethr does
    with it, what you'll need, a tip). Saving a step moves to the next; Back and "Skip for now"
    (connections, interview, rhythm) sit in the footer. Styles: `.tethr-welcome*`/`.tethr-onboard*`.
  - **First launch lands on the setup:** `useFirstRunToSetup` (SetupNavItem.tsx) sends the first
    chat of a window (no `?chat=`) to `/setup` while setup is incomplete, once per window
    (sessionStorage `tethr.setup.landed`, also set when the setup page opens), so "Look around
    first" and the chat stay reachable after.
  - **Connections fixes open in place** (`setup/fixes.ts` + `ConnectStep.tsx`): Fix on a row shows
    what to paste and where to find it, with a field per key saved through `PUT /env` (instance
    admins), a connector Off/Read/Ask/Auto switch saved to Integrations, or "Go to step 1". Setup
    re-reads its checks on open (`staleTime: 0`, `refetchOnMount: "always"`) and when the step
    opens, and the Environment and Integrations pages invalidate the setup query on save (a Jev
    key saved there showed as missing until the 30s cache expired).
  - **The interview reasons out loud:** the brief asks for what it will look at and why, what it
    found (numbers, period, oddities), the math, why this measure and target, and an easier and
    a harder option; connector summaries only, no export downloads (those need approval).
  - **Where it lives:** the goals, setup and ideas routes are in `server/src/routes/tethr-setup.ts`
    (mounted by `routes/tethr.ts`; `requirePerson` is in `routes/tethr-people.ts`). The page is
    `TethrSetup.tsx` plus one file per step in `ui/src/pages/tethr/setup/` (`shared.ts` = steps,
    done rules, `useRefreshSetup`; `controls.tsx` = Field, Toggle, Segmented, buttons).
- **Verified live on a throwaway instance** (`PAPERCLIP_INSTANCE_ID=tethr-verify`, deleted
  after):
  - The six steps, in light, dark and phone.
  - A target eased from 200 to 169 with its reason, the bell and the tile line.
  - An idea card in the main chat; Useful raised the pace to 1.25 a day.
- **Not run live:** a real Slack conversation turning into an idea (needs C6e). The watcher's
  pipeline is covered end to end in tests with a fake runner and poster.
- **Tests:** `tethr-company` (5), `tethr-goal-pace` (7), `tethr-pace` (6), `tethr-watch` (15),
  `tethr-setup` updated.
- **Shared helpers (clean-code pass, 2026-11-08):** `time.ts` (`SECOND`/`MINUTE`/`HOUR`/`DAY`),
  `ids.ts` `stableThreadId(name, companyId)` (the Operations and Ideas chats), `metric-format.ts`
  (`formatMetricValue`, `roundForUnit`), `best-effort.ts` `logFailure(what)` for `.catch()` on
  side effects that must not fail the caller, `assistant/turns.ts` `waitForTurn` (polls a chat turn,
  stops it past its limit). `ui/src/components/tethr/Chip.tsx` = the shared chip surface and
  `ChoiceChip`. Use these instead of re-writing them.

## Review fixes (2026-11-08) — invariants to keep

- **New files never overwrite.** `atomic.ts` `writeNewFile` claims a name with an exclusive
  create (`stem (2).ext` when taken) before writing atomically. Chat attachments and the tethr
  tools' CSVs (`score_list`/`keyword_ideas` `save_as`) use it, so two pasted `image.png`s each
  keep a file and a CSV never lands on the list being scored. A tool result that saved a file ends
  with `[Saved file: files/…]`; the chat's file chip comes from that line (events.ts), not from
  the call's input.
- **Goal text is one line in CLAUDE.md** (`oneLine` in goals.ts: titles and names stored that way,
  methods flattened when rendered), and the block says it's data, not instructions. One
  measurement per day: a second value for the same date replaces the first; no date = today at
  noon UTC.
- **Rhythm:** a turn the usage throttle answered is `skipped` (task cancelled, no Slack), not done.
  A scheduled turn past 20 minutes is STOPPED, so the task and the chat agree. Slack gets a
  heads-up only (`rhythmSlackText`: what's ready + a link when `PAPERCLIP_PUBLIC_URL` is set, and
  for the scorecard its numbers from the goals store), never the chat's write-up, which can
  mention customers. "Measure now" re-creates a routine deleted on the Routines page.
- **Wipe:** the Drive folder, the chat workspace (Memory.md, files/) and transcripts are shared by
  every company, so a wipe touches them only when no company stays (`plan.keptCompanies`).
- **Gate:** WebFetch hosts are DNS-resolved before allowing (`resolvesToPrivateHost`); a name
  that resolves to loopback/LAN is blocked. The tools endpoint applies the same `decide()` as the
  hook (Read mode blocks the goal-saving tools there too).
- **Stores:** `tethr-archive.json` now goes through `serialize` + `writeAtomic` like the others.
- **Environment page:** a multi-line paste names the settings it replaces and the core ones.
- **Startup:** server startup imports `tethr/boot.ts` (no static engine imports); `TaskRunState`
  lives in `task-run-state.ts` so routing doesn't load the issue service.

## Security review fixes (2026-11-08): invariants to keep

- **Fetches stay on the public web.** `server/src/tethr/net.ts` owns `isPrivateHost`,
  `resolvesToPrivateHost` and `fetchPublic` (policy.ts re-exports the first two). The classic
  engine's `web_fetch`/`reddit_scan`/`cdc_scan` go through `fetchPublic`: node http(s) with a
  `lookup` that refuses loopback, LAN, link-local and CGNAT addresses at connect time (so DNS
  rebinding can't swap the address after the check), address literals refused up front, redirects
  followed by hand (at most 5), one timeout for the whole chain, no pooled sockets, bodies capped
  at 5 MB before and after unzipping (raw deflate without the zlib wrapper is read too). Before this, a Slack message could get `@tethr.chat` to fetch
  `http://127.0.0.1:3100/api/tethr/...`, which in local_trusted mode answers as the admin. Never
  add a fetch of an agent- or user-supplied URL that skips `fetchPublic`.
- **`POST /tethr/seed` is instance-admin only** (`isInstanceAdmin` in `routes/tethr-people.ts`,
  built on core's `assertInstanceAdmin`; also used by the env and reset routes). A local curl in local_trusted mode still works; on a
  hosted (authenticated) instance an anonymous caller gets 403.
- **Approval gate, Gmail and Calendar:** `send_message` with a `draftId` is blocked (Gmail sends
  the draft as is and ignores to/subject/body, so a card would show the wrong thing); the chat
  sends with the fields written out. Sends to people the input doesn't name count as public
  (`leavesForUnnamedPeople`): a Gmail reply with no `to` (cc/bcc only add people), any reply-all,
  a forward with nobody listed, a Calendar update that changes anything guests see
  (`GUEST_VISIBLE_EVENT_FIELDS`: it lands on their copy even with `notificationLevel: NONE`;
  color and reminders stay a plain write), and an RSVP with a note. A plain accept/decline
  follows the connector's mode. A `calendarId` that is someone else's address counts as a
  recipient (`calendarOwner`; "primary" and `@group.calendar.google.com` don't).
  Recipients include Calendar's `attendeeEmails`, `addedAttendees`, `addedAttendeeEmails` and
  `removedAttendeeEmails` (`RECIPIENT_FIELDS` in policy.ts). Tests use the connectors' real field
  names; check a connector's schema before adding a rule for it.
- **The Queue lists pending items first** (`listOutputs` orders gated/changes-requested first,
  then newest, before its 100-row limit; it used to sort them last, so a busy company's pending
  items fell off). Growth's "waiting on you" is `counts.pendingDecisions`, a server-side count.
  Every place a person decides an output (Queue, chat card, bell) calls `refreshAfterDecision`
  (ui/src/api/tethr.ts), so the Queue list, Growth's count and the overview refresh together.
- **Private turns start tainted.** `runner.sendPrivate` (the watcher's idea check) marks its
  thread tainted before the turn: its prompt is other people's Slack words next to Memory.md, so
  an outside web page needs approval from the first call.
- **Command Center answers only to `127.0.0.1:<port>` / `localhost:<port>`** (Host header check in
  `scripts/tethr-command-center/server.mjs`), so a web page can't rebind its own domain to
  loopback and read 00 Tethr. A built `.app` bundles its own copy of server.mjs: rebuild it with
  `build-app.sh` to pick up changes (rebuilt 2026-11-08 with the Host check).

## Documents in and out, and the working nebula (phase 22, 2026-11-08)

Mark: "more than just .md capacity… PDF and all those skills… this system is more like an
operational harness", and "a cool animation like Claude does when it's processing… a little
nebula, an endless loop until it's done". Plan: `tasks/phase-22.md`.
- **Skills:** the chat's Claude session already loads Mark's own `~/.claude/skills` (the Skill tool
  is allowed). Anthropic's pdf/docx/pptx/xlsx skills need Python through the shell, which stays
  off, so documents come from a tethr tool instead.
- **`make_document`** (tethr tools, class `read`; `assistant/make-document.ts`): pdf, docx, pptx,
  xlsx or html into `files/`, from `markdown` or `from_file` (.md/.txt; .csv for xlsx) or `sheets`.
  Saved with `writeNewFile`; the result ends with `[Saved file: …]`, so it's a chip and opens in the
  side panel. The chat's CLAUDE.md tells it to use this for those formats.
- **Renderers** live in `server/src/tethr/documents.ts` (the Drive mirror uses them too):
  - PDF: Markdown → HTML → Chromium print, with **JavaScript off and every network request
    refused** (only `data:` images load; others are hidden).
  - Word: built from marked tokens (headings, inline bold/italic/code/links, numbered and bullet
    lists, tables with column widths, quotes, code); raw `<script>`/`<style>` dropped.
  - PowerPoint: a title slide plus one per `##` section.
  - Excel: a small writer on `zip.ts` (no dependency). Bold, frozen header; text is never a formula
    (inline strings).
- **Reading Office files** (`office-text.ts` on `zip.ts`): docx → Markdown (headings, tables as
  Markdown tables), xlsx → "## Sheet: name" + CSV, pptx → "## Slide N". Zip reads are capped per
  entry (no zip bombs).
  - **Attachments** now accept docx/xlsx/pptx: the text is read first (an unreadable file is
    refused), and a text copy `<name>.md` is written beside the original for Claude's Read tool.
  - **Drive and side panel:** `/fsdrive/read` returns `kind: "office"` with that text (xlsx shows as
    tables). PDFs and images preview as they are via `GET /fsdrive/raw`, which serves only
    pdf/png/jpg/gif/webp (never html/svg), `nosniff`, and refuses a symlink whose real path leaves
    the folder.
  - **Show in Finder** (`POST /fsdrive/reveal`, people only, macOS) runs `open -R`, which selects
    the file and never opens or runs it.
- **Nebula** (`components/tethr/Nebula.tsx`, `.tethr-nebula*` in tethr-theme.css): two blurred
  conic "arms", a pulsing core and three motes on tilted orbits, all `currentColor` (monochrome),
  still under reduced motion. The chat shows **one status pill for as long as a turn runs**
  (`.tethr-task-pill`, at the foot of the turn): nebula · what's happening (waiting / thinking /
  the running step / waiting for your approval / writing) · elapsed time · N steps · Stop.
- Shared helpers: `tethr/csv.ts` (`parseCsv`, `toCsv`), `assistant/files.ts` (`resolveInFiles`,
  `readTextInFiles`, `safeFileName`).
- **The mark is the nebula** (2026-11-08): `scripts/tethr-icon/make-icon.swift` draws it (tile for
  the desktop apps, `square` for phone home screens); `scripts/tethr-icon/favicons.sh` writes the
  PNG/ICO favicons; `ui/public/favicon.svg` is the vector version; `site.webmanifest` says tethr.
  The desktop launcher (local-only, `scripts/tethr-launcher/`) builds its icon from the same file
  and shows the nebula in its widget.
- **"Tethr stopped before it came up"** with `spawn tsx EACCES` in the log means the
  `node_modules/.bin` shims lost their execute bit (it happened once, 2026-11-08, cause unknown).
  The launcher now repairs that (`find … -perm -u+x … chmod 755`) and retries once, and its error
  message quotes the telling log line instead of "()". By hand: `find . -path '*/node_modules/.bin/*'
  -type f ! -perm -u+x -not -path './node_modules/.pnpm/*' -exec chmod 755 {} +`.
- Tests: `tethr-documents.test.ts` (16, including the PDF's network block against a live local
  server). Verified live on a throwaway instance: the nebula row on a running turn, the PDF from a
  chat chip in the side panel, and PDF, Word, Excel, PowerPoint and PNG previews in the Drive.

## tethr runs a team: the Hermes + Paperclip hybrid (phase 23, 2026-11-08)

Mark: "I need it to be clear on spinning up agents… not just another Claude chat but a new
Hermes/paperclip hybrid." tethr (the main chat) leads a team of agents it spins up itself. Plan and
decisions: `tasks/phase-23.md`, DECISIONS.md 27–30.
- **An agent on the team** is a real Paperclip agent: a core `agents` row (`tethr_llm`, reports to
  @tethr), a `tethr_agent_profiles` row (tag, mission, `overseerRole` = its owner), a hard-stop budget
  policy, and a core routine when it has a schedule (setup time zone, trigger on while active). Its
  `adapterConfig.engine = "session"` holds `instructions`, `connectors` (an allowlist of Integrations
  labels), `maxRunsPerDay`, `schedule`, `routineId` and `threadId` (`stableThreadId("agent:"+tag)`).
  No migration. Service: `server/src/tethr/team.ts` (`teamService`: list/get/byThread/create/update/
  setPaused/assign, `teamContextText`); pure spec, wording and limits: `team-spec.ts`.
- **It works in its own chat.** `adapter.ts` sends a session agent's tasks (assignments and its
  routine's runs) to `team-run.ts`: a system turn "Task WD-n: …" in the agent's thread with its
  instructions, waited ≤ 20 min; the task is commented and moved (failed or over the daily cap →
  `blocked`, never auto-retried). The runner runs an agent thread AS the agent: run row, budget
  check, cost event and activity actor are the agent's; deny rules block every connector outside its
  list, tethr's team tools and `Bash` (its own settings file, `settings-<company>-agent-<tag>.json`);
  `--tools` without Bash; a fresh session gets `agentIdentityText`. 3 turns at once overall, agents
  at most 2. The hook gate refuses the same things (`agentToolRefusal`), and an agent's approval
  cards carry its id/tag, so `dmOverseer` buzzes its owner. A paused agent runs nothing tethr starts.
- **It reports back** (`team-report.ts deliverAgentReport`) after every task turn and every
  follow-up tethr starts in its thread (e.g. after an approval): a main-chat card (route run,
  `sourceKey: "tethr-agent-report"`, `agentId`, the agent's file hops so chips open in the panel;
  body = what follows its last "Report:" line, `reportBody`), a next-turn note for tethr, the bell
  (kind `run`), and a Slack DM to the owner (roster role → Slack ID, else the admin's, else #tethr)
  with only the headline and the agent's "Slack summary:" line. Never the report itself.
- **tethr's tools** (`assistant/team-tools.ts`, on the `tethr` MCP server; refused in agent threads
  by deny rules, the gate and the tools endpoint, which also hides them from an agent's tool list):
  `team_list` (read), `create_agent`, `assign_task`, `update_agent` (draft). Integrations → **Team**
  (`integrations.ts` `team: { newAgents: "ask" | "auto", maxAgents, monthlyBudgetUsd }`): Ask = a
  gated `team_agent` / `team_change` output (sensitivity `org`), applied by `gating.approveTeamCard`
  (re-validated; one that can't apply closes `rejected` with `meta.applyError`); Automatic = created
  directly inside the limits (`announceNewAgent`: bell + Slack heads-up to the admin), else a card.
  **Raising budget or runs is always a `spend` card; pausing is always immediate.**
  `assign_task` needs no approval (cap, 3 open tasks, budget, throttle).
- **tethr knows its team:** CLAUDE.md v3 adds "## Your team" (the roster, as data) and "## Running
  the team" (when to spin one up, assign, never duplicate, propose an agent for a repeated ask).
  Company-level text, the same in every thread, so concurrent turns can't conflict.
- **Routes** (`routes/tethr-team.ts`): `GET /tethr/:c/team` (roster + running, waiting on you, runs
  today, open tasks, last report), `POST /team/:tag/pause {paused}` (people, immediate), `POST
  /team/propose` (a system turn in the main chat: `teamProposalBrief`, 2–3 `create_agent` calls).
- **UI:** drawer Team section (`pages/tethr/chat/team.tsx` `TeamSection`: dot = needs you / working /
  paused / idle via `lib/tethr-team.ts`, "Propose a starting team" when empty); in an agent's chat
  the chip is `AgentChip` (runs, owner, today, spend, tools, Pause/Resume), its own empty state and
  composer; `AgentReportCard` in the main chat (clamped, Show all, file chips, "Open @x's chat");
  approval cards label `team_agent` "New agent"; Integrations "Team" card; Company page "tethr's
  team" group.
- **Glass on phones:** the chat's conversation scroller is `relative z-0` (its fade mask made it a
  layer that painted over the floating chip panels), and `.tethr-fix-panel` / `.tethr-task-pill`
  fade in with fill `backwards` (same Chromium rule as the entrance animations).
- Tests: `tethr-team.test.ts` (14: spec, schedule words, card text, deny rules; card → approve →
  core wake → agent turn in its own chat → task done → report card, note, bell; caps; pause/resume;
  Automatic limits; spend card on a raise; endpoint and gate refusals; owner DM; follow-up report;
  CLAUDE.md roster), `ui/src/lib/tethr-team.test.ts` (3). Verified live on a throwaway: "spin up an
  agent that checks two clinics' prices every Monday" → New agent card → approve → it ran its first
  task in its own chat (web search, wrote `clinic-price-watch.md`) → report card + bell.

## tethr is the brain: sub-teams, goals, acting on its own (phase 24, 2026-11-09)

Mark: "tethr should be the main brain and it can decide to delegate and create agents… if it's
saying paid ads might be good I want it to build an agent that will handle this task and report
back… sub-agents (one just for keywords, one to look for strategies)… If it needs a permission it
can buzz me." Then: **"We're just building the framework"**: builds never propose, create or run
anything on Mark's instance (DECISIONS 31–34; plan `tasks/phase-24.md`).
- **Suggestions become agents with goals.** `create_agent` takes `goal_id` or `new_goal` (title +
  optional metric; saved on approval, or at once under Automatic, via `goalsService`); the agent's
  `adapterConfig.goalId` is shown in its turns, the roster, `team_list`, its chip. The "Running the
  team" playbook in CLAUDE.md says: recommend an ongoing effort → propose an agent in the same reply,
  with its goal (a new one if none fits; "missing setup is no reason to wait"), a lead for big
  efforts. Live check: "paid search might be worth trying" → a `@paid-search` lead card with a new
  "Paid acquisition" goal and a first task to build its sub-team.
- **Leads and sub-agents (depth 2).** `lead: true` → scoped team tools in its own chat (deny rules
  keep the team tools for leads; a lead without "Tethr tools" gets only those, `NON_TEAM_TETHR_TOOLS`
  denied one by one): `team_list` (itself + sub-team), `create_agent` (a sub-agent under it,
  `leadTag`, core `reportsTo` the lead, tools ⊆ the lead's, ≤ 4, card titled "New agent for
  @lead's team", buzzes the lead's owner), `assign_task` / `update_agent` (its sub-agents only).
  Sub-agents can't lead or use team tools (`agentToolRefusal`, tools endpoint, deny rules).
- **Sub-tasks and roll-ups** (`team-run.ts`): a lead's `assign_task` during a task turn makes a core
  child issue of that task (`taskIssueForRun(runId)`); the turn returns `delegated` (children
  created since the turn began, whatever their status) and the task waits. A task with sub-tasks is
  never worked from the top again: open sub-tasks → `blocked`; all closed → the roll-up turn
  (`agentRollupText`), whose report goes to tethr; if the sub-team finished during the lead's own
  turn it rolls up at once. Core wakes a parent even while it's checked out `in_progress`, and
  hands an open task back after a skipped run (`finish_successful_run_handoff`), so never decide
  by issue status. Pending cards don't hold a task open (`gated: false` on finish).
- **Who wakes whom:** a sub-agent's own report (first task, schedule; not a lead's sub-task) lands
  in its lead's chat as a card + note and wakes the lead (`leadNudgeText`); approving a sub-agent
  with no first task wakes the lead to hand it one. A lead's follow-up reaches tethr only when it
  writes a "Report:" (`hasReportHeading`), headlined "@lead has an update: … (from @sub)".
- **tethr acts on its own** (`team-brain.ts`, all **off** by default; Integrations → Team → "On its
  own"): `actOnReports` → one "Check-in: N reports from …" system turn in the main chat 3 quiet
  minutes after reports arrive; `dailyReview {time, weekdaysOnly}` → a "Daily review" turn once a
  day within 3 hours after its time (setup time zone, `localClock`); `maxSelfTurnsPerDay` cap; the
  usage throttle stops both. State `tethr-brain.json`; `startBrain` ticks each minute from boot.
- **Buzzing:** `resolveOverseer` falls back to the admin's Slack ID (setup step 1) and name when the
  role has nobody; `approvalDmText` links to the card when `PAPERCLIP_PUBLIC_URL` is set.
- **UI:** drawer Team section indents sub-agents under their lead ("Lead · N on its team",
  `orderTeam`); the chip panel shows Goal, "Reports to @lead" or "Its team"; Integrations "On its
  own" rows; the empty-team button is "Ask tethr to suggest agents".
- Tests: `tethr-brain.test.ts` (11: goals, lead rules, deny rules, review timing, DM text; card →
  lead with a new goal; sub-team rules; lead → sub-task → sub-agent → roll-up → report to tethr
  through core's wake loop; lead nudge; check-ins/review/cap/throttle; admin fallback). Verified
  live on a throwaway with real Claude: lead card → approve → it proposed two sub-agents → approve →
  each approval woke the lead, which handed out the research, then fed its findings to the strategy
  agent → the lead reported to tethr → tethr's own check-ins summarized and flagged what needed Mark
  (connect Google Ads).

## First-run fixes: setup ends in the chat, cards with buttons, agents that wait (phase 27, 2026-11-10)

Mark reset tethr, ran the first run on his phone and sent 15 notes. Plan and table: `tasks/phase-27.md`;
DECISIONS 57-64. No migration. One new store: `tethr-questions.json` (in the reset list).
- **Setup order:** Your company, Focus and pace, Connections, Rhythm and ideas, **On its own**
  (`setup/AutonomyStep.tsx`, `PUT /setup/autonomy`: daily review, check-ins, new agents ask/automatic,
  the learner, tool actions ask/automatic, Hermes memory), **Goals interview** last. Starting the
  interview sets `completedAt`, so the chat never shows "Finish setting up tethr" to someone who
  came from setup. `?step=<key>` opens one step. The welcome is one screen.
- **First run:** `TethrFirstRunToSetup` (mounted once in App.tsx) sends the first page of a window to
  setup while setup isn't done, from any page. The app's root opens on Chat.
- **Chat header:** `chat/avatar.tsx`: tethr's mark top centre, still (`Nebula still`), animated while a
  turn runs; an agent's chat shows its icon and opens `AgentAbout`. On phones the header is a
  three-column grid, **not** a positioned box: the chats drawer inside it is laid out against the
  whole chat (making that row `relative` collapses the drawer).
- **Queued messages:** a message sent while tethr works waits in `chat/queue.tsx` `QueuedTray`
  (`waitingBehind`), not in the transcript. `runner.editQueued` / `cancelQueued` act only while the
  run is still in its thread's queue; `PATCH|DELETE /chat-turns/:runId` (people, their own messages,
  409 once started). An edit keeps the attached files and strips typed marker lines.
- **Questions as cards:** tool `ask` (`assistant/person-tools.ts`, store `assistant/questions.ts`).
  Approve / Reject / Comment, or 2-4 choices + Comment. `POST /questions/:id/answer` sends the answer
  into that chat as the person's message; **it grants nothing** (outward actions keep their own
  approval card). A typed message closes the chat's open questions. At most 3 open per chat.
  An agent's question rings the bell and DMs its owner (the question's words go to Slack only from a
  chat that hasn't read connector data, and never with health details) and holds its scheduled runs.
- **Tools every agent has:** `AGENT_ALWAYS_TOOLS` = `ask`, `need_connection`, whatever its connectors
  (so every agent gets the tethr MCP server; `agentDenyRules` denies the other tethr tools one by
  one, and the whole server if it isn't given the list). Private turns and the sealed learner get neither.
- **Connections an agent needs:** `connections.ts` is the one list of what tethr can reach (the setup
  checks live there; CLAUDE.md gets a "## Connections" section each turn). An agent's `needs`
  (create_agent / update_agent) and anything it raises with `need_connection` are checked in
  `team-run.ts` **before any turn**: unmet and not waived → no turn (a scheduled run is skipped, a
  handed-over task waits in `heldIssues` and starts by itself later), one connection card
  (a question with `connection`), one "is waiting on a connection" report card. A lead's missing
  need holds its sub-team. "I've connected it" is refused while tethr still can't use it; a need
  raised against something tethr thought was on (`confirmFirst`) is cleared only by a person.
  "Carry on without it" is written into the agent's standing text. Saving a key or a connector mode
  runs `recheckConnections`.
- **Google Ads in the chat:** `google_ads_report` (read-only) is a tethr tool. Under tests
  `googleAdsConfigured()` is always false.
- **Needs you:** `needs-you.ts` / `GET /needs-you` = approvals + questions + connections. The chat's
  pill (`chat/needs-you.tsx`), the page (`TethrQueue.tsx`, still `/queue`, labelled "Needs you") and
  the sidebar item (`NeedsYouNavItem.tsx`) read it; `refreshAfterDecision` refreshes it. An agent's
  newest report card in the main chat carries its (and its sub-team's) pending items; the turn that
  created an agent carries its connection card until it has a report card.
- **Cards:** `chat/decision-cards.tsx` (`ApprovalCard` with Details in place, `QuestionCard`,
  `ConnectionCard`, `DecidedLine`); wording in `lib/tethr-cards.ts` (`cardHeading`). tethr says "the
  card below", never "check Slack / the Queue".
- **Slack:** while the chat engine is on, `routeInboundKickoff` never calls the old engine
  (`classicOff`); `answerUnknownSlackSender` replies and, when no admin is linked, keeps the sender as
  `setup.slackClaim`. `PUT /setup/admin-slack` links an ID. **A display name is never proof:** the
  one-tap "That's me" is only for the account Slack says has the admin's email; a claim is shown with
  its ID and a warning. Suites that test the classic engine's Slack path set engine `routing`.
- **Icons and the sidebar:** `iconFor` (team-spec.ts) picks an icon from the job; `healTeamIcons` at
  boot fixes team agents still on the robot. Core `SidebarAgents.tsx` renders
  `lib/tethr-agent-tree.ts`: a lead's sub-team nests and folds (remembered per company).
- **Bell:** `NotificationDetail` is portaled to the page (inside the blurred top bar it was laid out in
  a 48px box and couldn't blur what's behind it). Anything fixed-position opened from the top bar
  needs the same.
- **Agent run page:** a run with no task logs `idleRunSummary` and names the model. Paperclip's own
  "No project or prior session workspace" line is normal for every team agent run.
- Tests: `tethr-questions.test.ts` (16), `tethr-setup` (+4), `tethr-slack-chat` (+3),
  `tethr-assistant-runner` (+1), `tethr-team` (+4); UI `tethr-cards`, `tethr-agent-tree`,
  `chat/queue`, `NotificationDetail`, `SetupNavItem`.

## A calmer chat, and deleting with approval (phase 27 follow-up, 2026-11-10)

Mark: "I'm getting overwhelmed... if my assistant brought me all this I'd say this isn't helpful. It
needs to feel more guided and smooth, not data dumps." And: "add capacity for tethr to delete within
its folder with approval, it's just gonna end up getting clogged."
- **tethr writes like a chief of staff** (CLAUDE.md v8 "Talking with the team"): the point in one or
  two sentences, about 100 words, no headings or tables in the chat, depth in a short doc in files/
  (it opens beside the chat), one next step at a time, no housekeeping. A "what next" answer puts the
  sizing, options table and plan in `files/plans/` and gives only the pick, its size and why in the chat.
- **Agents' reports lead with one sentence** (team-spec.ts `REPORT_ENDING`): the result and what they
  need; at most four more short lines; no housekeeping.
- **Report cards are calm** (`chat/team-updates.tsx`): agent, headline (without its own tag), the
  report's first sentence (`reportLead`), what needs you, then "Read the report · N files" and "Open
  chat". Reports that land one after another are one "updates from your team" card (`groupReports`).
  A turn's files show two chips and "+N more" (`chat/file-chip.tsx`).
- **`delete_files`** (person-tools.ts, every agent has it; not private turns or the learner): up to 20
  files in `files/`, one approval card (kind `drive_change`, sensitivity `destructive`, so never
  automatic), `meta.cleanup`. Approving MOVES them (`assistant/cleanup.ts`): Drive → `00 Tethr/99
  Archive/tethr files`, no Drive → the workspace's `archive/`. Nothing is erased; each file is checked
  again on approval; the chat that asked gets a note either way.
- **Checklists for what only a person can do** (Mark: "help me get it set up like a checklist"):
  tool `checklist` (person-tools.ts, every agent has it; not private turns or the learner), store
  `assistant/checklists.ts` → instance-dir `tethr-checklists.json` (in the reset list). 2-12 steps, each
  `do` (one line) + optional `detail` + `copy` (exact text to paste); at most 3 open per chat, no two
  open with one title. Card `chat/checklist-card.tsx` (progress, a tick per step, Copy, "Ask tethr",
  "Not now" with an inline confirm). Routes (people only): `POST /checklists/:id/steps/:stepId {done}`
  (the tick that completes it sends `checklistDoneText` into that chat as the person's message) and
  `POST /checklists/:id/dismiss` (a note for the chat, no turn). Runs carry `checklists`; Needs you has
  a "For you to do" group and counts them; an agent's newest report card carries its open ones.
- **Playbooks are loaded first** (Mark: "ensure it's invoking skills… not sure it's using its paid ads
  expertise"): `growth-map/playbooks.ts` (`installedPlaybooks`, `playbooksContextText`,
  `playbooksForJob`) gives CLAUDE.md v9 a "## Playbooks" section (installed skills per area; load in that
  turn, follow it, say which) above "Deciding", which gains a budget-fit rule. A team agent's
  `playbooks` (TeamAgent, from its title/mission/instructions) go into its identity text. Verified on the
  live chat (read-only): the small-budget campaign turn made no Skill call.
- **A notification opens what it's about** (Mark: the bell's "Ask tethr to handle this" "just said a
  stupid chat"; it pasted the alert into the main chat as a vague question). The button is gone.
  Tapping a notification goes straight to its link (`TethrBell.tsx` `tapAction`); only a staged item
  that still waits opens the Approve/Reject popup, and one with no link opens a read-only popup.
  Report, idea and question notifications link to their card, `chats.chatHref(company, thread,
  runId)` → `/chat?focus=<runId>` (plus `chat=` for a side or agent chat). The chat scrolls to
  `[data-run-id]`, opens a focused report in full, marks it briefly (`.tethr-focus`) and drops the
  param. Kinds read as words ("report", not "run").

## Autonomy for every connector, and Google Ads that makes changes (2026-11-10)

Mark: "if I have to approve every single thing it defeats the purpose", "any connector needs to have
ability to be autonomous or manual with approval", budgets "approved by admin or set to auto in
settings", everything configured inside tethr. Plan: `~/.claude/plans/keen-moseying-micali.md`;
DECISIONS 67-68.
- **Per connector** (`integrations.ts` `ConnectorSetting.autonomy`, `autonomyFor`): under Automatic,
  `spend` (`ask`/`auto` + `monthlyCapUsd`), `outside`, `deletes`, each "Ask an admin" by default (what
  tethr always did). Automatic spending needs a cap (`sanitizeIntegrationsPatch` keeps it on ask
  otherwise). Medical always asks. Mercury is no longer capped at Ask; moving money is its Spending.
- **The gate** (`policy.ts` `decide(c, { mode, autonomy, withinCap, spendNote })`, `runsOnItsOwn`):
  money runs on its own only with spend auto + a cap + `withinCap`; an ad platform's deletes always
  ask (`isAdPlatform`, by name). A connector with no rules (Meta Ads, anything added later) is sorted
  by name and input (`spendsMoney`: budget/bid/enable/charge… names, amount/budget fields, a status
  set to ENABLED/ACTIVE). Ad copy is screened with `medicalClaimReason`, not the patient regex
  ("prescribed online" is the product). `kindsForConnector` = which settings the page shows.
- **Spending** (`server/src/tethr/spend/`): `guard.ts` `checkSpend` runs before deciding, in the hook
  handler and the tools endpoint. A connector with an adapter (`adapters.ts`; Google Ads today) is
  checked against the account: a cut isn't spending, a raise or turning something on is, against
  planned spend (live daily budgets × 30.4, a shared budget once), and a person's edit in the last 14
  days makes a card ("your own changes win"). Without an adapter: what tethr's own calls committed
  this month (`log.ts`, `tethr-connector-changes.json`, in the reset list) plus the call's amount
  (`amount.ts`); no readable amount = asks. Every automatic or approved action is logged there.
- **tethr's own tools on the same gate:** a tethr-server tool can be its own connector
  (`native-connectors.ts`: Google Ads' `ads_*`). The tools endpoint decides by that connector, and
  runs a call the gate let through on an approval once (`grants.ts` `claimApprovedCall`, `servedAt`).
  `delete_files` follows Tethr tools' Deleting setting (still a move to the archive).
- **Google Ads** (connector "Google Ads", Read only by default): `ads_create_campaign` (one atomic
  batch, created PAUSED, Search on Google only, US + English, Maximize clicks with an optional CPC
  ceiling), `ads_change` (pause/enable, keywords, negatives, ads, ad groups, bids, rename; never
  remove), `ads_set_budget`. Builders `tools/google-ads-ops.ts` (pure, limits, landing page on the
  company's domains); client + adapter `tools/google-ads-write.ts` (`adsBackend`, a fake in tests).
  `google_ads_report` gained `structure` (ids). **The REST API answers in camelCase**: read rows with
  `field(row, "cost_micros")`; the old reports read snake_case and showed $0 spend and value.
  **change_event can't be filtered by `change_resource_name`** (PROHIBITED_FIELD_IN_WHERE_CLAUSE):
  read by type and match in code. Every request shape passed Google's `validateOnly` on Mark's
  account (2026-11-10); nothing was created.
- **UI:** `settings/ConnectorAutonomy.tsx` under every connector on Integrations (Ask or Automatic):
  the three settings, the cap, planned or spent vs cap, the last 20 changes
  (`GET /tethr/:c/integrations/:label/activity`). Wording in `lib/tethr-autonomy.ts`.
- Tests: `tethr-autonomy.test.ts` (15, incl. the full card → approve → run-once flow against a fake
  account), `ui/src/lib/tethr-autonomy.test.ts`.
- **Every connector says what it can do** (Mark: "all these connections need to be able to do what they
  can"): `KNOWN_CONNECTORS` blurbs list each one's full abilities, and the Connections section of
  CLAUDE.md gives each connector its reach ("Automatic: changes run on their own, outside people ask…")
  plus "It can: …", so tethr uses all of it. (Per-connector autonomy lives only there, not repeated in
  Integration rules.) A saved Gmail draft sent as it is (`draftId`) runs when Gmail's outside people
  are Automatic and is refused otherwise, never a card (`Classified.opaque`). Tethr tools and PostHog
  get a Deleting setting. Mark's instance: every connector on Automatic, the three kinds on Ask.
- **The working pill's loop is the "tethered orbit"** (`components/tethr/Orbit.tsx`, `.tethr-orbit*`): a
  body circling a centre point on a hairline tether with a fading trail. The nebula stays the avatar's.

## Wiring review (2026-11-09): what's true, and two known gaps

Mark asked for a check that the systems are wired the way the design says. Verified on his live
instance, read-only: every chat turn billed to the subscription at $0; memory in Hermes
(`tethr-wd`, locked down, 0 tokens); no schedules running; @tethr the only agent.
- **Jev: "a key is saved" is not "connected".** `jev.ts` `jevHealth()` asks TypeSafe's model list
  whether the key works (cached 10 minutes; a new key is checked at once; real calls update it).
  Setup → Connections and Integrations show that, never mere presence.
- **Jev through Vercel's AI Gateway.** `TYPESAFE_API_KEY` can hold a Vercel AI Gateway key
  (`vck_…`). `jev.ts` `jevRoute` then sends requests to Vercel's TypeSafe-compatible endpoint
  (`https://ai-gateway.vercel.sh/typesafe`, model `typesafe-ai/jev`), reads Vercel's error shapes
  (including "out of credits"), and takes the cost Vercel reports (`costUsd`) instead of pricing
  it from tokens. `TYPESAFE_API_URL` / `TETHR_JEV_MODEL` override. Mark's key is a Vercel key: TypeSafe's own
  server had rejected it; through Vercel it works (2026-11-09, real requests, about $0.00002 each).
- **Fixed in phase 26.1: Slack and the terminal reach the chat brain** (section below).
- **Source files must stay plain text.** `slack.ts` and `checks/site-audit.ts` held literal NUL
  bytes (placeholders), so grep treated them as binary and code searches skipped them. They use
  the `\u0000` escape now. Don't paste control characters into source.

## One brain behind every door (phase 26.1, 2026-11-09)

Slack and the terminal client reach the same tethr as the app (memory,
recall, connectors, goals, team), not the classic engine. Plan: `tasks/phase-26.md` 26.1;
DECISIONS 42-43.
- **Who:** a Slack sender whose member ID is a company admin's (`tethr_members`, setup step 1),
  and only while the chat engine is "Claude session" (`slack-chat.ts chatBrainAsker`). Everyone
  else is told so and reaches nothing (phase 27; they used to fall through to the classic engine). The chat brain carries the admin's own connectors
  (reads need no approval), so nobody else may drive it.
- **Where:**
  - A DM is the main chat.
  - A channel-thread mention opens a side chat "Slack: …"; the link lives in `chats.ts`
    `slackLinks` (Slack source key → thread). Later mentions continue it. Replies without a
    mention are ignored, as before.
- **The answer goes back to Slack.** A turn carries `slack: SlackReplyTarget` (runner `send`).
  `answerInSlack` runs in `pump`'s `finally` (and for a turn stopped in the queue), so a failed,
  stopped or paused turn answers too.
- **Approvals:** the turn token carries the target, so an approval card made in that turn has
  `meta.slack`.
  - `gating.createOutput` skips the separate approver DM for it; the thread line asks instead.
  - "approve"/"reject" in that conversation decides the newest card of its chat
    (`pendingCardInThread`).
  - `approveExternalAction` wakes the chat with the same target, so the approved action's result
    is posted back to Slack, whichever way it was approved.
- **Never post connector data into a channel.** If the chat is tainted (read a connector, or
  used recall), a channel answer goes to the asker by DM and the thread gets a one-line note.
  Its approvals are decided in tethr (`deliverSlackTurn`). A DM answers in place.
- **Files:** `extractSlackFiles` (all types) → `saveSlackFiles`:
  - downloaded from Slack's own host only (`isSlackFileUrl`), with the bot token, 20 MB
  - images re-encoded to JPEG (`normalizeToClaudeImage`)
  - saved with the chat's `saveAttachment`; an unreadable type is named back in Slack
  - The classic engine still gets images only.
- **`POST /route`** from a person uses the chat runner. No `threadId` means a new side chat,
  listed in the app. A malformed `threadId` is a 400. Agents' keys keep the classic engine. The
  CLI treats `stopped` as finished.
- Tests: `tethr-slack-chat.test.ts` (9, embedded PG, real runner with a fake Claude and a fake
  Slack poster). The classic-engine test clears `ANTHROPIC_API_KEY`: a key in the shell made a
  real (refused) API call before.

## Jev decides, tethr files and learns (phase 26.2-26.6, 2026-11-09)

Mark: "build all the way to 26.6". Plan: `tasks/phase-26.md`; DECISIONS 49-56. Migrations **0097**
(`tethr_decisions`, `tethr_inbox_items`, `tethr_lessons`) and **0098** (`tethr_lessons.verdict`).
New instance-dir stores (all through `company-store.ts` `companyStore`, in the reset list):
`tethr-decisions.json`, `tethr-inbox.json`, `tethr-learning.json`.
- **26.2 Decisions** (`server/src/tethr/decide/`): `kinds.ts` (inbox.destination / notify / type /
  urgency, report.urgency, idea.rank, lesson.score; each with a default mode, `neverAuto`, a start
  bar), `decide.ts` (`decideWithJev`: several choice questions in ONE Jev request, a row per answer;
  `scoreWithJev`; `resolveDecision`; `calibrate`; `kindStats`; `setDecisionMode`). The record never
  stores the judged content. A kind is Off / Suggest / Automatic; **Automatic is earned** (20 answered,
  90% right) and acts only above the calibrated bar (lowest confidence where ≥95% of picks were
  right; the kind's start bar before 20 answers); **two undone automatic decisions in 7 days put it back
  to Suggest** (+ a bell); a monthly cap (default $5, summed from the record). Off / over the cap / Jev
  down / no key → items come to a person with no suggestion. Routes `routes/tethr-decisions.ts`;
  Integrations card `ui/src/pages/tethr/settings/JevDecisionsCard.tsx`.
- **26.3 Inbox** (`server/src/tethr/inbox/`): intake from `00 Tethr/00 Inbox` (made if missing;
  watched once a minute by `startInboxWatcher`, a file is taken once unchanged 30s), "File this" on a
  chat upload (a COPY goes to the Inbox), and a file sent alone in Slack (slack-chat.ts). `read.ts`:
  text, Office (`office-text.ts`), PDF via `pdftotext` (first 5 pages; `TETHR_PDFTOTEXT`), else
  name only. **The check on the Mac** (`screen.ts needsPersonReason` = a person's health detail, a card
  number (Luhn), a key) → `needs_person`, nothing sent to Jev. One Jev request: type, destination
  (the real folders, 2 deep, never `00 Inbox`/`99 Archive`/the workspace/hidden), who should know
  (Nobody, members, unpaused agents), urgency; Jev also gets active filing rules and recent filings.
  Suggest → a main-chat card (`tethr-inbox`) + the Drive's Inbox view; Automatic (earned) →
  `fsMove`, Put it back within 7 days. Never deletes; telling a person = bell + Slack DM with the
  file's NAME and folder only; handing to an agent = `team.assign`. Every tap resolves the decision;
  two corrections of the same type to the same folder propose a rule ("Invoices go to …"), mirrored to
  a Hermes skill `filing-rules` when Hermes is on. Routes `routes/tethr-inbox.ts` (people only);
  UI `drive/InboxView.tsx`, Drive page Files / Inbox switch (`?view=inbox`), chat `InboxCard`,
  File this on attachments (`chat/cards.tsx`).
- **26.4** (`decide/points.ts`): `reportUrgency` in `deliverAgentReport` (Suggest shows "needs you now
  / can wait" on the card with a way to correct it; Automatic + sure holds the Slack DM for the daily
  review; a report with health details is never sent or held), `rankConversations` in the watcher
  (idea.rank, off: it sends Slack words to TypeSafe; a conversation with health details is never
  sent), `score_list` `template: leads | partners` (`SCORE_TEMPLATES`). `POST /decisions/:id/answer`.
- **26.5 Lessons** (`learn/lessons.ts`, `assistant/learn-tools.ts`): `propose_lesson` (tethr's chats,
  any agent, the learner), `study` (queue a topic), `lessons_due`, `review_lesson` (tethr's own chats
  only). A proposal is checked (instructions, a person's health, keys, **medical claims**
  `screen.ts medicalClaimReason`), de-duplicated (word overlap ≥ 0.6), scored by Jev on fit /
  evidence / usable / novel (composite 0-100), and offered: from tethr or a person at once; from an
  agent only when ≥ 60 and the ideas pace has a slot (`pace.ts`), else it waits on the Learning page.
  **Only a person applies**: principle → a memory note on its growth-map area, procedure → a skill
  (Hermes) or a "How we do it" note, rule → a "Rule:" note, experiment → a "Trying until …" note; review
  date +28 days. "Not for us" with a reason → a "Not for us: …" note. The Friday scorecard's step 4 "What
  we tried" calls lessons_due + review_lesson; a person keeps or retires (retiring removes the note or
  skill). Sources earn a track record by domain. Learning page `/learning` (`TethrLearning.tsx`), routes
  `routes/tethr-learning.ts`, chat `LessonCard`.
- **26.6 The learner** (`learn/learner.ts`, `assistant/sandbox.ts`): `@sage`, made only when a person
  switches it on (Integrations → Learning; off pauses it): weekly Wednesday 10:00, 2 runs/day, $10/mo,
  owner growth, connectors ["Tethr tools"], `adapterConfig.sandbox = true` (`TeamAgent.sandbox`).
  **The sealed room:** its own folder `<assistantHome>/sandbox/sage/` (never the Drive) with a CLAUDE.md
  of the company line + goal titles + its rules only (no memory, team, goals detail, growth map);
  `--tools` Read/Glob/Grep/Write/Edit/MultiEdit/ToolSearch/WebSearch/WebFetch, `--setting-sources
  project` (no user CLAUDE.md, skills or settings), no `--add-dir`; deny rules for every other tethr
  tool + Skill + TodoWrite + Bash + every connector; the hook gate (`sandboxRefusal`, readable roots =
  its folder) and the tools endpoint (lists and runs only propose_lesson) agree. Each run's brief is
  built fresh in team-run.ts (`planStudy` + `studyBrief`): the study area (goals behind pace weigh
  more, turned-down areas less, least recently studied breaks ties), a queued topic first, what's
  already known, trusted and distrusted sources.
- Tests: `tethr-inbox.test.ts` (13), `tethr-learning.test.ts` (8, incl. the sealed room through a faked
  turn, the gate and the tools endpoint).
- **Independent review (2026-11-09): 10 findings, all fixed** — keep these:
  - A sandboxed agent's own "Slack summary" never goes into tethr's notes or a Slack DM (headline only);
    cards (agent reports, lessons, Inbox, ideas) are never replayed as conversation (`CARD_SOURCES` in
    runner.ts legacyContext).
  - The learner's chat with its agent deleted runs with NOBODY's rights (`sealedThreadTag`: the runner
    fails the turn, the gate denies, the tools endpoint 403s).
  - A Glob pattern's fixed folder must be readable too (policy.ts), so "/Users/**" can't list outside.
  - Decisions: `resolveDecision(..., { onlyPending })` wherever an answer may already exist (Leave it,
    re-filing after Put it back), so an undo stands; tethr's own automatic actions count toward the bar
    only after 7 days un-undone; a held report is `mode: auto, outcome: pending` until a person answers
    on the card (a "wrong" is an undo, and demotion is announced); a paid but unreadable Jev answer is
    still recorded for the cap.
  - Inbox: filing suggestions Off sends nothing to Jev; folder descriptions use only names tethr filed
    (checked again), never a folder's raw listing; a left or failed file holds its name only while the
    same file (size) is there; filing claims the item (`status: filing`) so two taps can't both move it.
  - Lessons: retiring removes exactly the note applying added (refuses if it was changed or merged into
    another note) and fails loudly; a note that already existed is marked `existed` and never removed;
    memory errors are 409s.

## The growth map: a galaxy of growth areas (phase 26.9, 2026-11-09)

Mark: "a growth map… like a galaxy solar star style system… RPG games… skills and improvement. I
want it to improve with a visual understanding." Plan: `tasks/phase-26.md` 26.9; DECISIONS 44-47.
- **Twelve areas** (`server/src/tethr/growth-map/areas.ts`, the same for every company): Positioning,
  Content & social, Search (SEO), AI search (GEO), Paid ads, Measurement on one spiral arm; Customer
  voice, Conversion, Pricing & offers, Retention, Email & lifecycle, Partnerships on the other. Each
  names its playbooks (skills in `~/.claude/skills`, `TETHR_SKILLS_DIR` in tests; only installed ones
  are listed), its data sources, what tethr can't see yet, and links only to its neighbours.
- **Six unlocks per area, from evidence only** (`map.ts` `computeGrowthMap`, pure; `evidence.ts`
  gathers): Mapped (an audit with a score), Equipped (any of its sources connected: a claude.ai
  connector counts once tethr has SEEN it on a real turn, `discovered`; Google Ads by its settings;
  "website" = a non-freemail domain in Integrations' inside addresses; "profile" = setup's "what the
  company sells"), Informed (3+ notes or skills placed there), Aimed (a linked goal metric), Staffed
  (an unpaused agent placed there, or the Friday scorecard switched on for Measurement), Proven (a
  placed metric that has moved off its baseline and was on track or at target, by the scorecard's
  rule, at EACH of its last 2 measurements; or the latest audit 10+ points above the first, with the
  two at least 7 days apart). Level = unlocks (Unexplored … Mastered); company level = sum over
  visible areas (max 72, less when areas are hidden). Nobody can set a level; it drops with the
  evidence.
- **Placement:** a note's area is in memory provenance (`Provenance.area`; a patch with no area keeps
  the old note's, note by note: Hermes reports each patch's before and after), a skill's in the map
  store (`skillAreas`). A metric or agent linked by `map_area` belongs to ONE area (`linkToArea`
  unlinks it everywhere else, so one number or agent can't lift every area); anything else goes
  through `sort.ts` keyword rules, where a tie places nothing.
  Metrics are sorted by name + goal, never their method.
- **Store** `growth-map/store.ts` → instance-dir `tethr-growth-map.json` (`TETHR_GROWTH_MAP_FILE`):
  audits per area (20 kept), linked metric ids and agent tags, the week's focus (shown 8 days),
  hidden areas, skill areas. In the reset's store list. No database change.
- **Tools** (`assistant/map-tools.ts`, on the tethr server): `growth_map` (read; one area in full with
  `area`) and `map_area` (draft, no card): score 0-100 + summary (both or neither), up to 5 next
  steps, `file` that must exist in files/, `metric_ids`/`agent_tags` (each list replaces; validated),
  `focus` (not on a hidden area). **An agent may only record audits, and only for the area it's
  placed in**; links and focus are tethr's own chats only. The score must be a JSON integer.
  Summary, steps and focus reason pass the health screen and the injection check. A private turn can read but not write (endpoint: reads only). `memory` and
  `skill_save` take an optional `area`.
- **Every turn:** CLAUDE.md v5 has "## Growth map" (`text.ts growthMapContextText`): one computed line
  per area (level, next unlock, playbooks, FOCUS), never saved text. The Monday plan playbook
  (rhythm.ts) calls growth_map and sets the focus with map_area.
- **Routes** `routes/tethr-growth-map.ts`: `GET /tethr/:c/growth-map` (audits carry `panelPath` for
  the side panel), `POST /growth-map/:area/explore` (people only: a system turn in the main chat,
  `exploreBrief`, first line "Explore <Area> on the growth map…"), `POST /growth-map/:area/hidden`.
- **UI** `/growth-map` (nav "Growth map" under Growth, palette): `TethrGrowthMap.tsx` + `map/Galaxy.tsx`
  (SVG, all currentColor; the live dot is the only color), `map/AreaPanel.tsx` (unlocks with what
  earns the next, Explore, last audit with its file in the side panel, knowledge, numbers, owners,
  playbooks, data, blind spots, hide/show), `map/AreaList.tsx`, `map/Overview.tsx`. Geometry is pure in
  `ui/src/lib/tethr-growth-map.ts` (`specFor(width)`: wide 800×512 or compact 600×660 under 640px;
  text sized to land 12.5/10px wide, 11px compact; labels placed so none overlaps another label, a
  star, the center or the frame). Desktop ≥980px: map | panel; narrower: panel below; phone: compact
  map, the list under it, the panel as a sheet. New unlocks since the last visit (localStorage
  `tethr.growthMap.seen.<company>`, nothing on a first visit) bloom once and carry a "new" tag. Styles:
  `.tethr-galaxy*` at the end of tethr-theme.css; reduced motion stops orbits, swirl, halo and bloom.
- Tests: `tethr-growth-map.test.ts` (server, 29), `ui/src/lib/tethr-growth-map.test.ts` (layout at
  320-1200px with every level, full orbits and each focus; what's new). The page is keyed by company,
  so switching company starts "what's new" over.
- **Independent review (2026-11-09)** found 5 defects in the first version, all fixed above: a flat
  number earned Proven, one metric or agent linked in every area lifted them all, two back-to-back
  audits proved an area, what's new carried over between companies, and a mixed patch dropped a
  note's area.

## Hermes is tethr's memory, on the subscription (phase 25, 2026-11-09)

Mark: "I want to use tethr as our main thing but you can use hermes as the memory layer. We need to
utilize it but stick with the subscription style not API for now." Plan: `tasks/phase-25.md`; spike:
`tasks/phase-25-0-spike.md`; DECISIONS 35-38.
- **Who does what.** Hermes stores tethr's notes, keeps every chat turn searchable and holds the
  skills tethr learns. Claude Code on the subscription does all the thinking. **tethr never runs a
  Hermes turn, so Hermes never calls a model.**
- **Never break these** (`tethr-hermes.test.ts` checks them):
  - The helper (`hermes/helper.ts`) calls only Hermes's data functions (`HELPER_OPS`): never an
    agent, chat, cron, ACP or the curator's consolidation.
  - It runs with no keys in its environment (`hermesEnv`).
  - tethr's profile stays locked down (`PROFILE_CONFIG`; `lockdownGaps` shows on the card).
  - Never point tethr at Mark's default Hermes profile.
- **The bridge** (`server/src/tethr/hermes/bridge.ts`) is the only code that talks to Hermes. It
  finds it through `hermes --print-runtime-command`, then runs the helper as `<hermes python> -I`
  with `HERMES_HOME` = the profile.
  - The profile is per company, `~/.hermes/profiles/tethr-<prefix>`. tethr writes the folder and
    config itself, never with `hermes profile create`, which can seed a model.
  - Every tethr instance on a Mac shares one Hermes. An instance other than `default` carries its
    id in the name (`profileNameFor`), and a company never adopts a profile folder it didn't make
    (`freeProfileName`: a wiped company's profile stays on disk, the new one gets `-2`).
  - Session writes go through Hermes's gateway (its only DB writer); one auto-starts and idles out.
  - A gateway already running when the profile is made "parks" it until it rescans. Switching
    memory on sends Hermes's `rescan-profiles` (helper op `gateway.rescan`, what `hermes profile
    create` does), and an import that hits `profile_parked` rescans once and retries. Found on
    Mark's Mac, whose gateway ran alone with one profile.
  - Tests use Hermes only with `TETHR_HERMES_TEST_ROOT`, a throwaway data root.
- **Entries** (`hermes/entries.ts`): Hermes's `§` format in two stores, "company" (MEMORY.md, 6,000
  chars) and "people" (USER.md, 2,000). The limits shown are the profile's own.
  - CLAUDE.md v4 renders them every turn as "## Memory" (data, not instructions), replacing the
    `@Memory.md` import. CLAUDE.md is one file for every chat of the company and turns run side by
    side, so `renderMemoryBlock` takes company-level facts only, never what one thread may use.
  - **A note is one line** (`oneLine`): line breaks could pass a note off as a heading or a rule
    in CLAUDE.md.
  - **Memory.md is now a read-only copy for the team** (`workspaceWriteRefusal` refuses it).
    `writeMemoryCopy` never writes over a file it didn't generate.
  - Without Hermes, a built-in store keeps the same entries, one folder per company
    (`hermes/memory-layer.ts`).
  - Provenance (who saved what, from which chat) is in `tethr-memory.json` (`hermes/state.ts`).
- **Every way into memory goes through `changeMemory`** (the chat's tool, the Memory page, the
  migration, a switch between stores). It refuses:
  - a particular person's health details (`tethr/screen.ts` `personalHealthReason`: a sentence
    has to tie a person to a health detail, so ordinary travel-medicine notes pass). Skills are
    screened the same way. It's a tripwire, not a guarantee.
  - text that reads like instructions to tethr (`injectionReason` for the built-in store;
    Hermes runs its own scan, reported in plain words by `plainHermesRefusal`).
- **Nothing is dropped silently.** A note that can't be saved during a switch or the migration
  goes to `notMoved` in the state and shows on the Memory page with its reason.
- **Switching stores** (`routes/tethr-memory.ts`):
  - On: Hermes has to answer (`status`) before memory points at it. Then
    `mergeBuiltinIntoHermes` adds what the built-in store has, keeping who saved each note and
    when, and removes from Hermes what a person removed or changed while it was off (the base is
    `offBase`, recorded at switch-off). The built-in files are kept under a dated name.
  - Off: `copyHermesIntoBuiltin` makes the built-in store exactly what Hermes holds.
- **The Memory.md migration is per file path** (`migrated` in the state). The workspace falls back
  to the instance folder when Drive is away, so a Memory.md that shows up later is still migrated.
  The original is backed up outside Drive before anything else.
- **Index** (`hermes/indexer.ts`): every finished chat turn is imported, one at a time, oldest
  first.
  - Only turns the runner ran (`sourceKey` null or `chat-system`): the person's message and
    tethr's answer. **Never tool results, never private turns or the idea cards that come out of
    them, never agent-report cards (the report is in the agent's own chat), never throttled turns,
    never a turn that trips the health screen** (ledger value `skipped:health`).
  - A turn always gets the same Hermes id (its time + 12 hex of the run id), and the helper checks
    whether it's already there, so a batch that was cut short can be sent again.
  - The ledger is tied to the profile folder by an id tethr writes into it (`tethr-profile.json`):
    a folder that was replaced starts the ledger over.
  - One lineage per chat (`lastByThread` keeps the newest turn's time, so a late older turn never
    becomes the tail); an agent's chats use source `tethr-agent-<tag>`.
  - Backfill runs at boot and every 10 minutes (`startMemoryIndexer`).
  - **Hermes's background service:** a session write needs it, and Hermes starts it when it's
    down; it then also runs whatever its owner set up in their default profile. The helper only
    does that when `wakeGateway` is on (the default; Integrations, Memory card). Off: turns wait.
- **Tools** (`assistant/memory-tools.ts`):
  - `memory` (draft): add, patch or remove. **An agent can add, and change or remove only notes it
    saved itself** (`agentMemoryRefusal`): agents run unattended and read the web.
  - `recall` (read): search past chats or open a turn. An agent searches only its own chats (a
    lead also its sub-agents'). **A recall taints the thread.**
  - `skill_view`, `skill_save`. Only tethr's own chats save skills; descriptions are at most 60
    characters.
  - **A private turn gets read-only tethr tools and no memory tools** (the hook token carries
    `privateTurn`; the tools endpoint refuses anything that isn't class `read`). Its prompt is
    other people's Slack words, so it must not save goals, assign work or create agents.
  - **Whose chat it is decides what's allowed, and a failed lookup refuses** (the tools endpoint,
    the hook gate and the memory tools never fall back to tethr's own rights).
  - Every 10th message from a person, a note reminds tethr to save what's durable (only in chats
    that have the memory tool).
  - **A fresh session never starts blank (2026-11-09).** Core's claude-local adapter silently starts a
    new Claude session when the prompt bundle (persona + skill) changes; the runner thought it had
    resumed, so it sent no recap, and every chat lost its history at once after a build. Each saved
    session now records `instructions` (`persona.ts instructionsFingerprint`); a mismatch is treated
    as fresh, and a session saved before the field existed also gets the recap. The recap is the last
    8 turns (600/1,500 chars). A fresh session in a chat with 3+ messages from a person while memory
    is empty also gets `MEMORY_CATCHUP`: recall the earlier conversation and save the durable facts
    before answering (Mark's Nov 9 interview and follow-ups had saved nothing).
  - **What a recap never carries (security review, 2026-11-10):** turns from before a "Start over"
    (`chats.startOver` records `restartedAt`; the reset clears the taint, so replaying older turns,
    which can quote Gmail or Stripe, would have let web pages and Slack channel answers carry them
    out), and the Ideas chat's private turns (made from other people's Slack words; the indexer
    skips them too). Cards (`CARD_SOURCES`) were already excluded.
  - **How tethr decides** is a CLAUDE.md section (`DECIDING` in workspace.ts, not the persona, so
    editing it never resets sessions): start from the goals' biggest gap and its drivers, pull the
    numbers, rank by impact for the team's time and money with the expected size, use what the team
    said (memory, recall) before recommending, one clear recommendation plus a runner-up, never "I
    can't do anything". The growth map block says a level is how much tethr knows about an area, not
    how much it matters. Before this, a fresh chat with no memory recommended Partnerships for having
    the highest level, after Mark had said partners bring about one order a month.
  - **A "what next" answer has a fixed shape (2026-11-10):** the pick in one sentence with its size,
    where we are and the gap, an **options table** (gain a month within ~90 days, cost, confidence, how
    sized; at least three rows, one of them doing more of what's already working), the plan, then act
    in the same reply (an agent card, a goal, or a switch to name; never "if you want, I can…"). With
    principles alone it still ranked partners first for being "20x behind" their own target (a
    percentage, not impact) in 3 of 4 runs; with the shape, 2 of 2 runs picked organic search/SEO
    with the math and ranked partners last. **Throwaways started with `pnpm --filter
    @paperclipai/server dev` don't reload on edits** (`tsx src/index.ts`, no watch): restart one
    after changing server code, or you're testing the old prompt.
  - **"What's switched on"** (`assistant/switches.ts`, CLAUDE.md v6): every turn lists tethr's
    built-in features (Monday plan, Friday scorecard, daily brief, Slack ideas, check-ins, daily
    review, the learner, the Inbox), whether each is on, and where a person switches it on. tethr
    can't switch them itself; it recommends one when it serves the pick, and never makes an agent for
    a job one of them does (no "metrics reporter" agent: that's the Friday scorecard). With no
    working agents, "Running the team" adds that a recommendation comes with the agent that will run
    it even if nobody asked about agents. Tests: `tethr-switches.test.ts` (4).
- **UI:**
  - The Memory page (`TethrMemory.tsx`) has entries with who saved them, edit, remove, add, usage
    bars, the "Not moved" list, a past-conversation search and skills.
  - The Integrations "Memory" card has Hermes on/off (instance admins), the lockdown checks, a
    missing-profile warning, the indexed count, the last import error and "Start Hermes when it
    isn't running".
  - Routes are in `server/src/routes/tethr-memory.ts`.
- **Tests:** `tethr-hermes.test.ts` (13: no-model guards, the queue, agent memory limits; on a real
  Hermes: memory, repeat-safe import, search, the store switch, skills, the chat end to end, 0
  tokens), `tethr-assistant-memory.test.ts` (11), `tethr-screen.test.ts` (27).
- **Verified live** on a throwaway tethr with a throwaway Hermes root and real Claude:
  - "remember …" was saved into Hermes with provenance, and a NEW side chat answered it from the
    Memory block with no tool call.
  - A fact said but not saved was found by recall from a fresh chat, which tainted that thread.
  - A skill was saved, then loaded from a new chat.
  - The Memory page (edit, search, skills, Not moved) and the Integrations card render in light,
    dark and phone.
  - `hermes insights` showed 0 tokens over 6 sessions.
  - The live run caught a bug: an empty drain left the import queue stuck. Fixed, with a
    regression test.
- **Independent review (2026-11-09)** found 14 defects in the first version; all are fixed above.
  The two serious ones were data loss on switching stores and a migration that could be skipped
  and the original then overwritten. Neither hit Mark's instance (its memory was empty).

## Onboarding from scratch: goals with numbers, setup, rhythm (phase 20, 2026-11-07)

Mark's call: start tethr over from scratch, with real goals. The plan is in `tasks/phase-20.md`.
- **Goals with numbers (20.1).**
  - The tree stays in core `goals`: one company goal = the mission, plus one team goal per area
    (New customers, Revenue, Partnerships & distribution).
  - Migration **0095** adds `tethr_goal_metrics`: a metric per goal with unit, direction, source,
    **method** (exactly how to measure it, so every scorecard measures the same way),
    baseline/target/date, current, and `history` (capped at 104). Cascades from goal and company.
  - Service `server/src/tethr/goals.ts`. A bare `YYYY-MM-DD` is stored at **noon UTC**, so it shows
    as the same date in US zones.
  - `goalsContextText()` is written into the chat's CLAUDE.md **every turn** ("Wandr's goals").
  - Chat tools on the `tethr` MCP server: `goals_list` (read) and `save_goal` / `save_metric` /
    `record_metric`. The last three are class **draft**, so no approval card: they're internal to
    Tethr. `policy.ts` also skips the outward medical check for Tethr tools, since a metric named
    "new patients" isn't medical content leaving Wandr.
  - REST: `/tethr/:companyId/goals` (+ `/goals/metrics`, `/measurements`), people only.
  - The **scorecard** sits at the top of Growth (`components/tethr/Scorecard.tsx`). Each metric is
    a stat tile: value, change since baseline, a meter from baseline to target with an
    expected-pace tick, on-track/behind as a dot **and** words, a hoverable trend line and a
    history table. Monochrome by the brand.
- **Setup page (20.2).**
  - `/setup` (`TethrSetup.tsx`) has five steps: basics, connections checklist, goals interview,
    rhythm, finish.
  - State lives in instance-dir `tethr-setup.json` (`server/src/tethr/setup.ts`).
  - The **goals interview** runs in the **main chat** (since 2026-11-08; it was a "Goals
    interview" side chat). `foldInterviewIntoMainChat` (`main-chat.ts`, run at boot and by
    `POST /setup/interview`) moves an older side-chat interview into the main chat while the main
    chat is empty: its runs, Claude session, notes, taint and pending grants. Its first turn is a system turn
    whose brief (`interviewBrief`) tells tethr to pull aggregate baselines, propose targets, save
    only what Mark agrees to, and fill Memory.md. The chat shows only that turn's first line
    (`SystemLine`).
  - Until setup is complete there's a "Set up tethr" sidebar item and a Chat nudge
    (`SetupNavItem.tsx`).
- **Rhythm on the chat engine (20.3).** `server/src/tethr/rhythm.ts`.
  - Monday plan, Friday scorecard and daily brief are **core routines assigned to @tethr**,
    created or updated by `applyRhythm` with Mark's cron and time zone. Unchosen ones aren't
    created. Nothing is on by default.
  - When one fires, `adapter.ts` routes the task, **ahead of @tethr's old digest mode**
    (`isRhythmTask`), to `runTaskInOperationsChat`: a system turn in the fixed **Operations** side
    chat (`operationsThreadId`, a stable UUID per company). It waits for the turn, then
    `tasks.finish` comments and closes the task.
  - Slack #tethr posts go through `postSlackMessage`, only when Mark ticked it.
  - "Measure now" = `runRhythmNow`, which creates the routine paused if needed.
- **Fresh-start wipe (20.0).** `server/src/tethr/reset.ts`.
  - Endpoints: `GET /tethr/admin/reset/plan`, `POST /tethr/admin/reset`. **Inert unless
    `TETHR_ALLOW_RESET=true`**, instance admins only.
  - The POST needs `confirm: "WIPE <prefixes>"` and a `backupFile` under an hour old (from core
    `POST /instance/database-backups`).
  - What it does:
    - deletes whole companies via `companyService.remove`
    - drops their keys from every instance JSON store
    - **moves** old `00 Tethr` files into `99 Archive/<YYYY-MM> before fresh start/` (never
      deletes from Drive)
    - deletes the chat workspace's Claude Code transcripts
    - re-seeds a fresh Wandr with only @tethr
    - unlinks project goals first: core's `remove()` deletes goals before projects, so a project
      pointing at a goal (core's onboarding wizard makes one) blocked it
  - **Ran it 2026-11-07:** deleted WD, WG and WAN (backup
    `data/backups/paperclip-20261107-234337.sql.gz`), moved 9 Drive items into
    `99 Archive/2026-11 before fresh start/`, deleted 5 old transcripts. The fresh Wandr has only
    @tethr, and `TETHR_ALLOW_RESET` is removed from the .env again.
- **Verified live (on the old company, before the wipe):**
  - Basics saved goals; the scorecard rendered (dark, light, phone).
  - "Measure now" ran routine → WD-2 → the Operations chat in 28s (goals_list → measured →
    `record_metric` → `files/scorecards/2026-11-07.md`), and the task closed as done.
- **Tests:** `tethr-goals.test.ts` (6) and `tethr-setup.test.ts` (9). The latter includes the full
  core wake → adapter → Operations chat → task done chain, and the wipe against temp Drive, stores
  and transcripts.

## Phase 15 fixes — previews, Inbox retirement, cogs (2026-07-19)

- **Content previews in completion messages.** `preview.ts` `contentPreview(body)` → first ~3
  prose lines ("> "-quoted, caps 3 lines/280 chars) + word count; null for bodies <20 words.
  Applied to worker.ts published + gated summaries (answers and org/drive-change diffs excluded)
  and the Slack "Filed to your shared Drive" message (snippet + "~N words" per file) — so Slack/
  Console show what actually landed without opening Drive. Locked in `tethr-slack.test.ts`.
- **The core Inbox is retired — the Queue is the ONLY approval surface.** Root cause: the Inbox's
  Approve called core `POST /approvals/:id/approve`, which flips the approvals row but never calls
  `gating.decide` — the item vanished from the Inbox while the output silently stayed gated (and
  desynced approved-row/gated-output pairs). Fix: nav entries removed (Sidebar/MobileBottomNav gets
  a Queue tab/CommandPalette — all already-forked, logged in DECISIONS.md), `/inbox*` →
  redirect `/queue` (core Inbox page file untouched — it's actively developed upstream), and a boot
  heal (`healInboxApprovedOutputs` in `tethr/index.ts`) re-decides any past desynced pair through
  the real path. **Never edit core Inbox/approvals files to "fix" Tethr approvals.**
- **Working cogs.** `CogDuo` (primitives.tsx — meshed lucide Cogs, counter-rotating via
  `.tethr-cog-spin`/`-reverse` in tethr-theme.css, reduced-motion-guarded) at the Console working
  fallback + RouteFlow pending hop ONLY (Mark's pick) — brand stays quiet elsewhere.

## Routing fix — conversational asks stop briefing (2026-07-21)

A plain chat ("what do you do?") was misrouted at the **helm** level to `@ceo` — whose only
subagent (`plan`) maps to kind `brief` (internal → auto-published), with no answer-inline escape —
so every conversational/meta question produced a Drive brief. Root cause was routing-table copy the
classifier reads: `@tethr`'s catch-all row was stale ("no specialist agents exist yet") and never
claimed conversational/meta questions, and `@ceo`'s row was too broad ("direction", "what should we
focus on") and sat FIRST (the no-signal default). Fix (all in `seed/**`, additive): rewrote
`TETHR_AGENT.routing` (tethr-core.ts) to claim conversational/meta/status/greeting asks, narrowed
`CEO_ROUTING_ROW` (ceo.ts) to specific business-strategy phrases, and made `linkTethrToCeo` **append**
`@ceo` so `@tethr` stays the first/default row. **The routing table lives in the DB and the seed is
idempotent**, so already-seeded orgs need `healTethrRoutingCopy(db)` (tethr-core.ts, wired into
`maybeAutoSeed` after the inbox heal): it rewrites the `@tethr`/`@ceo` rows to canonical copy and puts
`@tethr` first — idempotent, best-effort. Affects ALL surfaces (they share `routeRequest`). Watch the
mock keyword scorer (`llm/mock.ts`: `tokenize` keeps tokens len>2, so common words like "the"/"org"
leak score) — keep routing copy free of stopword noise or you'll perturb `@tinkr`/`@patch` routing
tests. Locked by `tethr-core.test.ts` (meta→`@tethr.chat`, strategy→`@ceo`, heal repairs a stale
table). Verified live: heal fired on boot; two different conversational asks routed `@tethr →
@tethr.chat` with kind `answer` (no brief). `CEO_ROUTING_ROW` also gained explicit
agent-creation triggers ("create an agent", "add an agent", …) so a terminal/Console request to
build an agent reaches `@ceo.plan`'s `propose_agent` (staged as a gated `agent_proposal` →
Queue); the heal propagates these to the live org too. Verified live: "create a market research
agent" → `@ceo` → `propose_agent` → gated proposal → approved → `@radar` instantiated (paused).

## Org hierarchy + claude-code timeout fixes (2026-07-21)

- **System agents sit BESIDE the org, under @tethr — not under @ceo.** `@tinkr`/`@patch`/`@filer`
  were seeded `reportsTo: @ceo`, so the org chart nested them inside the CEO's command chain. They're
  infrastructure that complements the CEO (the "System · infrastructure" group), so they now
  `reportsTo: @tethr` (the conductor/system hub); `@ceo` branches down only to the org roles
  (`@radar`/`@remedy`/`@cgo`). Fixed in `seed/tinkr.ts`/`patch.ts`/`filer.ts` (look up `@tethr`, not
  `@ceo`) + a boot heal `healSystemAgentParents(db)` (tethr-core.ts, wired into `maybeAutoSeed`) that
  re-parents already-seeded orgs — idempotent, best-effort. `reportsTo` is org-chart-only (routing is
  table-based), so this is purely structural. Locked by `tethr-core.test.ts` (+ the tinkr/patch/filer
  seed tests updated to assert `@tethr`). Verified live: org chart shows two roots (`@tethr` →
  tinkr/patch/filer, `@ceo` → radar/remedy/cgo).
- **claude-code per-call timeout 120s → 300s.** The CEO's planning heartbeat (read Drive → plan →
  draft brief) runs >2 min on the subscription backend and was hitting the 120s `CALL_TIMEOUT_MS`
  ceiling in `llm/claude-code.ts` → `adapter_failed`. Bumped the default to 300s (still overridable
  via `TETHR_CLAUDE_CODE_TIMEOUT_MS`). The error clears on the next successful heartbeat/retry.

## Marketing agents — Rank (SEO) + Tank (GEO) (2026-07-21)

Two ORG ROLES under `@ceo` (org specialists, not system agents), both seeded on-request (no
heartbeat — Mark enables schedules), $15/mo hard-stop, read-only research tools, output → 02
Documents. Personas grounded in Wandr's actual marketing docs (`05 Marketing /Claude Marketing/`)
+ current 2025-26 GEO best practices, extracted by subagents.
- **`@rank`** (`seed/rank.ts`) — SEO / search-demand strategist. Subagent `@rank.keywords` (key
  `keywords` → document kind), tools `keyword_ideas` + `web_fetch`. Encodes Wandr's method: a hard
  **catalog-fit gate** (only topics that route to a real Wandr Rx — Malarone/Azithromycin/Cipro/
  Acetazolamide/Scopolamine…; Doxycycline/Mefloquine are comparison-only), intent/funnel scoring,
  pillar-cluster mapping, first-person clinical-provider voice, primary-source citations. **Google
  Ads keyword_ideas token is live/working** (verified: 361 real ideas returned).
- **`@tank`** (`seed/tank.ts`) — GEO / LLM-visibility analyst (getting cited by ChatGPT/Perplexity/
  AI Overviews/Claude, where Wandr is barely seen). Subagent `@tank.geo` (key `geo` → document
  kind), tools `web_fetch` + `keyword_ideas`. Read-only **audits → scored readiness rubric + P1-P4
  fix backlog**; it INFERS citation-likelihood from auditable signals (crawlability, answer capsules,
  fact density, E-E-A-T/schema, freshness, third-party corroboration) and recommends a human/live-
  engine spot-check — it has no tool to query the engines. Never touches medical-content correctness.
- Both wired into `maybeAutoSeed` + `POST /tethr/seed` + `ALLOWLIST` + a `@tethr` routing row (SEO→
  `@rank`, GEO→`@tank`, disambiguated). Locked by `tethr-rank.test.ts` + `tethr-tank.test.ts`.
- **PostHog is NOT configured** (`POSTHOG_API_KEY` unset) — Tank recommends AI-referral traffic
  tracking (chatgpt.com/perplexity.ai referrers) as the proxy metric; wiring the key later lets
  Tank/Pulse read analytics directly.

## Live mode (Claude) & budgets

- **Flip live:** set `ANTHROPIC_API_KEY` (+ optional `TETHR_CLAUDE_MODEL`, default
  `claude-sonnet-4-6`) and restart — `getTethrLLMProvider()` (`llm/index.ts`) swaps mock →
  `ClaudeProvider` at boot. `TETHR_LIVE_FETCH=true` turns the three web tools from fixtures to
  real read-only GETs. **Flip back:** unset `ANTHROPIC_API_KEY`.
- **Budgets are real now (Phase 3 fix).** Two seams were broken: the adapter reported no cost
  and only Tailwind's cap hard-stopped. Fixed additively — `llm/pricing.ts` prices token usage
  (`claude-sonnet-4-6` = $3/$15 per MTok, override with `TETHR_PRICE_INPUT_PER_MTOK` /
  `TETHR_PRICE_OUTPUT_PER_MTOK`), `adapter.ts` emits `costUsd` for **live runs only** (mock stays
  $0) — top-level, which is what core bills, plus a copy in `resultJson` (phase 18 fix), and `seed.ts` sets `hardStopEnabled: true` for every agent policy. Cost flows
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

**Where it lives in the UI (2026-11-07):** Company → Settings → Memory (`/company/settings/memory`), moved off the main sidebar "for now" (Mark will rework it later); `/memory` redirects there. **Since phase 18.5 that page edits the chat's Memory.md**; the `tethr_memories` rows below are the classic engine's log, folded under "Older agent log".

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
  **A budget change is now stamped `sensitivity: "spend"` at both org_change createOutput sites
  (`worker.ts` staging + the `/org-changes/:id/revert` route)**, so it rides the financial gate
  (exec-overseer DM, spend label) AND is structurally excluded from auto-approve — defense in depth
  over the `update_budget` carve-out. The apply is keyed on `kind === "org_change"`, not
  sensitivity, so this doesn't change how an approved budget change is applied.
  Auto-created/modified agents still **start paused** — enabling a heartbeat stays a human action.
  Locked by `tethr-autoapprove.test.ts` + `tethr-tinkr.test.ts` ("update_budget … sensitivity=spend").
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
- **00 Tethr full-screen viewer**: "Open viewer" now takes the Drive's Finder window full screen
  (see the Finder note under the Drive page redesign); the old `DriveViewer.tsx` is gone.

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
  + **`Finder.tsx` — the Drive is a Finder window (2026-11-07, Mark's note: "look like an actual
  finder window")**: sidebar of locations (Shared: 00 Tethr · Tethr: Working drive · Google
  Drive: added folders + "Add folder…", hover-X removes from sidebar only), toolbar (back/forward,
  list/icon view, new folder, rename, archive, preview pane, search, full screen), sortable
  columns (Name/Date Modified/Size/Kind, folders on top; columns collapse by the list's own
  width via container queries), preview pane, Quick Look (Space / double-click), right-click
  menu, path bar (crumbs are drop targets) + status bar. **`@dnd-kit` drag-to-move** — drag a
  row onto a folder or path crumb; within a single source only. Keys: arrows, Return/Cmd+Down
  open, Cmd+Up/Backspace up, Space Quick Look, Cmd+[ ], Esc steps back a layer. Touch: a tap
  opens. "Open viewer" = the same window full screen (preview pane becomes the reader).
  `filePreview.tsx` renders Markdown (YAML front matter → small metadata block), HTML in a
  `sandbox=""` iframe (no scripts), other text as mono. `FolderDialog.tsx` = the name dialog.
  `TethrDrive.tsx` = header + Finder. Every Finder surface is **opaque** (`tethr-window`).
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

## Brand lock — "Smoked Glass" (any UI work; reskinned 2026-11-07)

Frosted panels floating over warm ink: the Aina glass card + Oura's calm and big light numbers
+ Vercel's type and hairline precision. Still monochrome at heart.

- **Type:** Geist + Geist Mono, weights 200–500 (no bold/extrabold). Page titles `tethr-display`
  (thin, tight); figures `tethr-figure` (Geist 200, tabular); micro labels `tethr-eyebrow` /
  `<MonoTag>` (mono, spaced caps).
- **Color:** warm neutrals only — Night ground `#0B0A09`, Day ground `#E9E7E3`; the primary is
  the brightest neutral (bone on Night, ink on Day). No brand hue. Color appears **only as 6px
  status dots, one meaning each**: ok (published/approved/done) · warn (awaiting review / near
  cap) · changes (amber ring) · bad (rejected/failed) · live (running, pulses) · idle (queued/
  draft/on request) · paused (hollow ring). Use `StatusDot` / `statusTone()` in `primitives.tsx`
  — never raw amber/emerald/cyan classes.
- **Surfaces (4 layers):** L0 ground (soft overhead light + grain, `body::before/after`) · L1
  `tethr-panel` frost (page panels/cards/rows — translucent, hairline, **no blur**) · L2
  `tethr-glass` (blur 24 — ONLY things that float or ask for attention: menus, popovers,
  approval cards, composer) · L3 `tethr-glass-heavy` (dialogs). Reading/working windows (the
  Drive Finder, Quick Look) use **`tethr-window`** — opaque, never see-through. **Floating
  shell (desktop, matches the reference artifact):** a 12px gutter around and between a
  rounded (16px) glass sidebar panel — workspace switcher as an org card, account row at its
  foot — and a rounded (14px) glass top bar with a sentence-case title; page content lines up
  with the bar. The page ground is `--tethr-ground` (Day `#d9d6d1`, the reference's app stage),
  a shade under `--background`, so panels read as surfaces. Phones keep the edge-to-edge
  drawer layout. **Radius scale:** upstream `index.css` pins `--radius-lg/-xl` to 0 inside
  `@theme inline` (baked into the utilities), so the theme restates `.rounded-lg` (12px) and
  `.rounded-xl` (14px) in its `utilities` layer — don't remove that block or ~240 core cards
  go square again. **Never put `backdrop-filter` on a scrim
  whose child is glass** — a blurred parent cuts off the child's blur and the sheet turns
  see-through (the old viewer bug); scrims use `tethr-scrim` (dim only). 1px rims with
  a lit top edge; radius 14px panels, 10px fields, pill buttons (`tethr-btn` + `-primary/-glass/
  -ghost/-danger`). Wells: `tethr-inset`. Empty states: `tethr-empty`. Budgets: `BudgetRing`
  (Oura ring) / `BudgetBar`.
- **Entrance animations that touch `filter` fill `backwards`, never `both`/`forwards`:** in
  Chromium a held animation on `filter` keeps the element a backdrop root, so every glass surface
  inside `<main>` stopped blurring (the chat drawer read as clear glass over text). Keyframes end
  on `filter: none`.
- **Gradients:** only the ambient ground light and the reeded `tethr-reeds` texture (Console hero
  + empty states). No emoji. Product name lowercase **"tethr"** (logo lockup still TBD).
- **Phones and touch (UI pass, 2026-11-08):**
  - upstream `index.css` gives every button/input a 44px min-height on touch screens, **unlayered**, so no
    Tailwind utility can undo it. Switches opt out with `data-slot="toggle"`; compact controls that size
    themselves for touch (`pointer-coarse:h-9 …`) add **`tethr-touch-sized`** (tethr-theme.css).
  - The phone bottom bar (`MobileBottomNav.tsx`, core, logged in DECISIONS.md) is Chat · Growth · Queue ·
    Drive · Issues.
  - Rendered documents (Queue preview, Memory, Drive reader) use **`tethr-doc-md`**; chat answers use
    `tethr-chat-md`. Both exist because upstream's unlayered `.paperclip-markdown` (15px, 600-700 headings)
    beats Tailwind sizes. No new 9px text: 10px is the floor.
  - The Drive's `Finder` fills its parent (a flex column with a height), so a note above it can't push it
    off screen. Growth's "waiting on you" counts the Queue's pending items, not only tasks in review.
  - **Phone pass (2026-11-09, Mark on his iPhone):**
    - **Text fields are 16px on touch screens** (tethr-theme.css, unlayered). Under 16px, iPhone Safari zooms
      into the field when it's tapped and stays zoomed, which pushed the top bar and tabs off screen. Never
      undo this with a smaller field size on phones.
    - **No bottom tabs on phones** (Mark: "the hamburger menu does just fine"): `Layout.tsx` no longer renders
      `MobileBottomNav` and the phone bottom padding is 1.5rem + the safe area (DECISIONS.md core row).
    - **The chat is a fixed frame on phones** (`chat/phone-frame.ts` `usePhoneFrame`). It runs from under the
      top bar to the bottom of the screen (home-bar inset as padding), or fills the visible area above the
      keyboard (`visualViewport`). Only the messages scroll. Core's phone layout scrolls the whole page, so
      the keyboard left the composer mid-screen. The frame measures an empty anchor where the chat would
      start (state, because the loading view renders without it) and is **portaled to `document.body`**: the
      shell's entrance animation puts a transform on `<main>`, which would carry a fixed frame with it.
    - On phones the chat's controls (chats, where you are, start over, the setup pill) are a row above the
      messages; on wider screens that row is `contents` and they float as before.
    - Round icon buttons opt out of the 44px touch height (`tethr-touch-sized` + `pointer-coarse:h-8/10`) so
      they stay circles; pill buttons keep 44px.
    - The theme control is one button (Auto → Day → Night) on phones.
    - Notifications fit the phone (`min(24rem, 100vw - 1rem)`); long links wrap, nothing scrolls sideways.
  - **The bell asks only while a card is open:** the notifications list carries each Queue item's
    `outputStatus` now (`notify.ts withOutputStatus`), and "needs you" shows only for gated / changes
    requested. Before, a withdrawn or decided card kept saying "needs you".
  - **A chat turn calls tethr on its own address** (`self-url.ts selfApiUrl`: the loopback listener;
    `TETHR_HOOK_URL` overrides), never `PAPERCLIP_API_URL`. The server sets that from
    `PAPERCLIP_ALLOWED_HOSTNAMES`, so starting tethr with an ngrok host allowed sent every hook call to the
    tunnel host, and the chat said its tools weren't reachable.
- **Theme:** Auto (follows the computer/phone — the default) · Day · Night, via
  `TethrThemeSwitch` (top bar) and the account menu. `paperclip.theme` stores
  `system|light|dark`; `ThemeContext` exposes `preference/setPreference` + the old API.
- **Where:** edit the brand only in `ui/src/styles/tethr-theme.css` (tokens + slot overrides
  unlayered; the `tethr-*` vocabulary inside `@layer components` so Tailwind utilities still
  win), `ui/src/components/tethr/primitives.tsx`, `ui/src/lib/brand.ts`. Core pages get the brand
  through tokens + `[data-slot]` selectors only. Light + dark + mobile on every change.
- Proposal page (reference visuals): https://claude.ai/artifact/VK1s3mFrGkdsRsJB9muHiu

## Hard boundaries (never cross)

- **Never touch PHI / clinical systems / the website's medical-content correctness.** Tethr is marketing/distribution only. Medical *content* decisions are a licensed-human domain — structural/technical findings only.
- **Outward actions follow the Integrations modes** (Mark's decision, 2026-11-07 — replaces "internal-only output"; widened 2026-11-10). An outward connector action runs according to that connector's mode on the Integrations page: **Auto** or **Approval required**. Under Auto, **money, outside people and deletes ask by default; each can be made automatic per connector** (its autonomy settings), spending only under a monthly cap tethr checks before every call. **Anything medical always asks. Never PHI.** Ad accounts never delete (pause instead), and ads only point at the company's own domains. Nothing auto-merges; no medical content decisions ever. The compliance gate (`server/src/tethr/gating.ts`) still hard-blocks `medical`/`public`/`spend`/`pr` outputs behind a core `approvals` row — there is no advisory bypass. Keep it hard in every phase.
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
