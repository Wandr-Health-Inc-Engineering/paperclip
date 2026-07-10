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
| 2 | Slack: real senders + inbound surface | pending; `../scout` absent → build inbound fresh |
| 3 | Go live with Claude (supervised) | pending; blocked on `ANTHROPIC_API_KEY` |
| 4 | V1 recommendation loop (Sentry → #scout → @Cursor → PR) | pending |
| 5 | Migrate laptop workflows | pending; parity/cron gates are Mark's |
| 6 | Memory upgrade (dedupe) | pending |
| 7 | Command Center → cloud | pending; source in Drive, not repo |
| 8 | Error-patching agent (Pulse / PostHog) | pending; blocked on `POSTHOG_API_KEY` |
| 9 | Observability, budgets, access control | pending |
| 10 | Scale review vs $1M-no-hiring | excluded (needs steady-state data) |

Full run instructions: `docs/tethr-buildout/RUN-ALL-PROMPT.md`. Remaining human actions
(the deliverable Mark cares about most): `docs/tethr-buildout/MANUAL-STEPS.md`.
