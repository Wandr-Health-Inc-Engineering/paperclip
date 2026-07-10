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
Layer 3  Content   Wandr Growth company (seeded): CEO → Helm (CGO) → 8 agents → 22 subagents
Layer 2  Tethr     server/src/tethr/** — routing, gating, drive, memory, notify, llm, seed, tools
Layer 1  Shell     ui/src/pages/tethr/** — Console, Company, Queue, Drive, Runs, Budgets, Audit, Memory, Settings, AgentPage
Layer 0  Paperclip untouched engine (heartbeats, routines, approvals, budgets, costs, storage)
```

The 8 agents: **Helm** (Chief Growth Officer, router) → **Atlas** (content/SEO),
**Compass** (briefs), **Voyager** (itineraries), **Sonar** (scout/leads), **Tailwind**
(ads, spend-gated), **Ledger** (analytics), **Herald** (PR), **Beacon** (strategy/brand).
4 divisions: Growth (active) + Engineering, Reliability, Customer Feedback (shells — the
designed landing zones for future agents, e.g. the Phase 4 site auditor "Sentry" and
Phase 8 "Pulse" go in Reliability).

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

First boot auto-seeds **Wandr Growth** (company prefix `WG`) — CEO → Helm → 8 agents → 22
subagents, Growth division populated, 3 shell divisions, heartbeat routines, budgets,
Drive content. No Docker / external DB / API key needed: embedded Postgres + deterministic
**mock LLM** out of the box. Docker path: `make compose-up` (Postgres 17 + server + bundled
UI on :3100). Re-seed (idempotent): `curl -X POST http://localhost:3100/api/tethr/seed -d '{}' -H 'content-type: application/json'`.

**Dev env is loaded from the Paperclip instance dir, not repo `.env`:**
`~/.paperclip/instances/default/.env` (holds `TETHR_BUNDLE_PATH`, `TETHR_LIVE_FETCH`, etc.).

### Env knobs (`.env.example` lists all)

| Var | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | swaps every agent from mock → live Claude (`llm/claude.ts`, plain fetch) |
| `TETHR_CLAUDE_MODEL` | live model override (default `claude-sonnet-4-6`) |
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
- **Inbound:** `POST /api/tethr/slack/events` (`routes/tethr.ts` + `slack.ts`). Signature-
  verified (`SLACK_SIGNING_SECRET`), answers the url_verification challenge, acks in <3s, and
  turns a tagged link/photo into a routed Helm task (`invocationSource:"api"`). Not behind
  `assertCompanyAccess` by design (signature is the auth). `../scout` was absent → built fresh.
- **Env:** `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, optional `SLACK_SCOUT_CHANNEL`,
  `TETHR_SLACK_COMPANY_ID`. Slack app scopes + event URL: gate **A2** in `MANUAL-STEPS.md`.
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

Full run instructions: `docs/tethr-buildout/RUN-ALL-PROMPT.md`. Remaining human actions
(the deliverable Mark cares about most): `docs/tethr-buildout/MANUAL-STEPS.md`.
