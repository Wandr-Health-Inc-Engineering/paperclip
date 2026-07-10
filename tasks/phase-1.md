# tasks/phase-1.md — Deploy Tethr to Railway

**Branch:** `tethr-buildout` · **Status: code-side built 2026-07-09; deploy blocked on Railway account (gate A1).**

Objective: Tethr server + UI running persistently on Railway with managed Postgres and
proper secrets — **mock LLM only**, nothing autonomous. Definition of done needs the
actual deploy (Mark's account); everything buildable-without-account is done here.

## What was built (no account needed)

1. **`railway.toml`** (config-as-code, repo root): builds the root `Dockerfile`,
   healthcheck `/api/health`, restart on-failure, single replica. Comments enumerate the
   service variables Mark sets (kept out of git).
2. **Build de-risk:** `pnpm --filter @paperclipai/server build` run locally → **exit 0**.
   This is the exact server-compile step the Dockerfile's `build` stage runs, so the
   Railway build's heaviest failure point is pre-verified. (Full `docker build` couldn't run
   — Docker isn't installed on this machine — so the image *boot* is proven at Railway build
   time; see verification checklist below.)
3. **DB/SSL seam confirmed:** the DB layer uses **postgres.js** (`packages/db/src/client.ts`,
   `postgres(url)`), which honors `sslmode` in the URL. Railway's **internal** `DATABASE_URL`
   (`postgres.railway.internal`) needs **no** sslmode; only a public proxy URL needs
   `?sslmode=require`. Guidance: reference `${{Postgres.DATABASE_URL}}` (internal).
4. **Seed-once confirmed:** `TETHR_AUTOSEED` gates auto-seed (`seed/seed.ts:823`); the seed
   is idempotent (`RUN.md`: returns the existing "Wandr Growth" if present). First boot
   against empty Postgres seeds exactly once; redeploys against the same Postgres are no-ops.
5. **Health endpoint:** already exists (`/health` + `/api/health`, `routes/health.ts`) — the
   Dockerfile HEALTHCHECK and `railway.toml` both use `/api/health`. No new route added.
6. **Docs updated:** `CLAUDE.md` deploy section; `MANUAL-STEPS.md` step A1 (exact CLI +
   first-run auth note).

## Cloud seams (from MIGRATION-NOTES.md) — this phase's settings

| Seam | This phase | Later |
|---|---|---|
| DB | `DATABASE_URL` = Railway Postgres (internal); `PAPERCLIP_MIGRATION_AUTO_APPLY=true` | — |
| Storage | `local_disk` (ephemeral on Railway) | S3/R2: `PAPERCLIP_STORAGE_PROVIDER=s3` + `S3_*` |
| LLM | mock (do **not** set `ANTHROPIC_API_KEY`) | Phase 3 flips live |
| Secrets | Railway service vars | aws_secrets_manager if moved to Azure/AWS |

## Deploy runbook (Mark runs the account-linked steps — gate A1)

```
brew install railway            # or: npm i -g @railway/cli
railway login                   # browser auth
railway init                    # new project "tethr"
railway add                     # choose PostgreSQL (provisions DATABASE_URL)
railway variables --set PAPERCLIP_MIGRATION_AUTO_APPLY=true \
                  --set SERVE_UI=true \
                  --set BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
                  --set DATABASE_URL='${{Postgres.DATABASE_URL}}'
railway up                      # builds Dockerfile, deploys
# after it returns a URL:
railway variables --set PAPERCLIP_PUBLIC_URL='https://<railway-domain>'
```

Then paste the URL back so Claude Code verifies `/api/health` and the seeded org
(`GET /api/tethr/companies` / the endpoint `TethrCompany.tsx` calls).

## First-run auth note (verify at deploy, has a fallback)

The Dockerfile sets `PAPERCLIP_DEPLOYMENT_MODE=authenticated` + `EXPOSURE=private` (secure
default — the org is not world-readable). Core uses **better-auth**
(`server/src/auth/better-auth.ts`); auth data lives in Postgres, so accounts persist. Expected
first-visit behavior: create the initial admin login, then the Tethr UI renders. **Fallback**
if the headless first-user flow misbehaves during the shakedown: set
`PAPERCLIP_DEPLOYMENT_MODE=local_trusted` temporarily to reach the UI, then restore
`authenticated` and do real logins properly in **Phase 9**. Do not leave a cloud URL in an
unauthenticated mode long-term.

## Verification checklist (at deploy time)

- [ ] Railway build succeeds (server stage pre-verified locally).
- [ ] Boot log shows migrations applied (`PAPERCLIP_MIGRATION_AUTO_APPLY`) and "Using external PostgreSQL via DATABASE_URL".
- [ ] `GET <url>/api/health` → ok.
- [ ] UI root renders; Company page shows Helm + Atlas/Compass/Voyager/Sonar/Tailwind/Ledger/Herald/Beacon.
- [ ] Railway restart → reload → org still there (proves data is in managed Postgres, not ephemeral FS).
- [ ] `git grep` shows no secret committed.

## Rollback

Delete the Railway service/project; repo changes revert via git. The laptop engine is
untouched and remains the production system.
