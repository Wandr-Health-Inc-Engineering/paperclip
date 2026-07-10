# Tethr RUNBOOK

Operational guide for the deployed Tethr server (Railway). Companion to `CLAUDE.md`
(architecture) and `docs/tethr-buildout/MANUAL-STEPS.md` (remaining setup). Everything here is
reversible; nothing touches the live Drive engine or clinical systems.

## Restart / redeploy

- **Restart:** Railway dashboard → the Tethr service → **Restart**. Data is in managed Postgres,
  so a restart is safe (uploaded Drive file *bytes* on the ephemeral FS are the only loss — see
  the S3/R2 note in `CLAUDE.md`).
- **Redeploy:** push to the branch Railway tracks, or `railway up`. Migrations auto-apply
  (`PAPERCLIP_MIGRATION_AUTO_APPLY=true`). The provider (mock vs Claude) is chosen at boot.

## Kill switches (fastest → nuclear)

| Situation | Action | Effect |
|---|---|---|
| An agent is misbehaving | Pause that agent (Company page) or set its budget cap to 0 (Budgets page) | Hard-stop cancels its in-flight + queued runs (Phase 3 fix makes caps enforce) |
| Runaway LLM spend | Unset `ANTHROPIC_API_KEY` on Railway + restart | Instant revert to the deterministic **mock** provider — zero external spend |
| Slack noise / wrong posts | Unset `SLACK_BOT_TOKEN` | All senders revert to log-only; nothing posts to #scout |
| PostHog issue | Unset `POSTHOG_API_KEY` | Pulse goes inert (no data source) |
| Pause everything scheduled | Pause each agent's heartbeat routine (Runs/Company page); or set all agent caps to 0 | No heartbeats fire; manual "run now" still works |
| Full stop | Railway → service → **Remove** (or scale to 0) | Server down; laptop engine is untouched and remains production |

The org-level **Anthropic spend limit** (console.anthropic.com, $25/mo) is the backstop that
survives everything above — keep it on permanently.

## Rollback per phase

All phases are additive and env-gated; rolling one back is unsetting its env and/or a git revert
of its commit on `tethr-buildout` (nothing is pushed/merged, so reverts are local and clean):

- **P1 deploy** — delete the Railway service; repo reverts via git.
- **P2 Slack** — unset `SLACK_BOT_TOKEN` (outbound) + remove the Slack app's event subscription (inbound).
- **P3 live LLM** — unset `ANTHROPIC_API_KEY`.
- **P4 Sentry / P8 Pulse** — pause the agent or zero its cap; Cursor PRs are just PRs (close unmerged).
- **P6 dedupe** — advisory only; revert the routing recall hook (one commit) to disable.
- **P9 alerts/digest** — toggle off via config; auth rollback = the pre-phase commit.

## Health & uptime monitoring

- Core liveness: `GET <url>/api/health`.
- **Deep check (Phase 9):** `GET <url>/api/tethr/health/deep` → `{ ok, db, lastHeartbeatAgeSec }`,
  HTTP 503 if the DB is unreachable. Point a free pinger at it: **UptimeRobot** → HTTP(s)
  monitor → that URL, 5-min interval, alert on non-200. (Railway also has native health checks;
  the Dockerfile already health-checks `/api/health`.)
- **Error alerts:** Tethr heartbeat failures post to #scout within minutes (throttled to one per
  error class per hour) via the Notifier — so a broken agent surfaces without watching logs.
- **Budget visibility:** the Helm **daily digest** already lists queue items, agents ≥80% of cap,
  and failed runs. The **weekly summary** (`digestService.generateWeeklySummary`) posts total +
  per-agent spend vs cap to #scout — schedule it Monday alongside the digest routine.

## Access control (Phase 9)

Paperclip core ships **better-auth** and the deploy runs in `authenticated`/`private` mode
(`server/src/auth/better-auth.ts`), so this is **not** a build — it's creating accounts in the
existing system, which is the smallest honest implementation:

1. First visit to the Railway URL creates the initial **admin** (Mark).
2. Add **Frank** (admin) and **Alec** (viewer) through the app's account flow / invite once live.
   Roles beyond the core defaults may need confirmation of what core exposes — verify at deploy;
   if core has no viewer role yet, make all three admins and note it, rather than building a
   custom role system now.
3. Never print passwords; use env-seeded initial credentials with a forced reset if the flow
   supports it. Keep the `local_trusted` fallback (Phase 1) only for the shakedown, never long-term.

Command Center (Phase 7, when built) uses a single shared `CC_PASSWORD` until this same auth is
reused there.

## Who to call / escalation

- **Mark** — owns Railway, Anthropic, Slack, PostHog, the laptop engine, and every "go".
- **Frank** — graph/memory + any Scout history; the memory ADR (`docs/adr/0002-…`) is addressed to him.
- **Alec** — read-only visibility (Runs/Budgets).

Nothing in Tethr is customer-facing or PHI-touching; a Tethr outage degrades marketing
automation only — the laptop engine remains the production system until Phase 5 retires each
workflow at parity.
