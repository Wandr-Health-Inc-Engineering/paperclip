# Phase 1 — Deploy Tethr to Railway

**Objective:** Get the Tethr server (with UI) running persistently on Railway with managed Postgres and proper secrets — mock LLM only, nothing autonomous yet.

**Definition of done:** The Tethr UI loads at a Railway-provided HTTPS URL, shows the seeded Wandr Growth org (Helm + 8 agents), survives a service restart (data in managed Postgres, not embedded), and no secrets are committed to git.

**Prerequisites:** Phase 0 committed. A Railway account (exists, unallocated). Mark has ~15 min to create the Railway project/token when prompted — Claude Code cannot click through Railway's dashboard.

**Estimate:** 3–4 sessions.

---

## Prompt 1 — deployment plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, MIGRATION-NOTES.md, DECISIONS.md, RUN.md, the root `Dockerfile`, and `docker/docker-compose.yml` (the compose file already runs Postgres 17 + server on :3100 with `SERVE_UI=true` and auto-migrate — that's the shape we're reproducing on Railway).
>
> I want Tethr deployed to Railway: one service built from the root Dockerfile, plus a Railway Postgres database, mock LLM (do NOT set ANTHROPIC_API_KEY in this phase). Requirements:
>
> - Use the documented cloud seams from MIGRATION-NOTES.md: `DATABASE_URL` from Railway Postgres (append `sslmode=require` if Railway needs it — verify), `SERVE_UI=true`, auto-migrate on boot, storage stays `local_disk` for now (note in the plan that Railway's filesystem is ephemeral, so file bytes uploaded to Tethr Drive won't survive redeploys — acceptable this phase, S3/R2 swap goes in the plan's "later" list).
> - Create `railway.toml` (or configure via dashboard — prefer config-as-code in the repo) with health check on the server's existing health endpoint (find it in `server/src`; if none exists, add a trivial `/healthz` as an additive Tethr route).
> - Do NOT touch `terraform/` — that's the preserved Azure path.
> - Seed behavior: confirm what the server does on first boot against an empty Postgres (auto-seed of Wandr Growth per RUN.md?) and make sure the deploy gets the seeded org exactly once.
> - List every env var the service needs with its value or "Mark provides", and the exact Railway CLI commands (`railway login`, `railway init`, `railway up`, variable-set commands) in the order I'll run them — I'll execute the account-linked ones myself.
>
> Before writing anything, produce a plan with the exact files you'll create or modify, the order of operations, and how you'll verify each step (local Docker build first: `docker build .` then run against a local Postgres to prove the image boots before we ever touch Railway). Write the plan to `tasks/phase-1.md` and stop for my approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-1.md. Order: (1) local `docker build` + boot verification against local Postgres — show me the startup log lines proving migrations ran and the UI serves; (2) create railway.toml + any healthz route; (3) hand me the exact `railway` CLI commands to run and pause while I run them; (4) after I paste the deploy output/URL back, verify by fetching `<railway-url>/healthz` and the UI root, and confirm the org renders by checking the API endpoint the TethrCompany page uses (find it in `ui/src/pages/tethr/TethrCompany.tsx`).
>
> Update CLAUDE.md with: the Railway URL, how to deploy (one command), where env vars live, and the ephemeral-filesystem caveat. Update DECISIONS.md if any core file was touched. Commit on `tethr-buildout`. Do not enable any heartbeat or live LLM — stop after verification for my review.

## Checkpoint for Mark (phone)
Open the Railway URL on your phone: the Tethr console loads, Company page shows Helm + Atlas/Compass/Voyager/Sonar/Tailwind/Ledger/Herald/Beacon. Then in the Railway app/dashboard: restart the service, reload the page, org still there. Two minutes.

## Rollback
Nothing pre-existing is live. Rollback = delete the Railway service/project; repo changes revert via git. The laptop engine is untouched and still the production system.
