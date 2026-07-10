# tasks/phase-9.md — Observability, budgets, access control

**Branch:** `tethr-buildout` · **Status: built + tested 2026-07-09. Access control is config (core ships auth).**

Objective: make the running system trustworthy for a three-person team — error tracking on
Tethr itself, budget alerting before caps hit, and real logins so Frank/Alec can see (not just
Mark).

## What was found already done

The Helm **daily digest** (`digest.ts`) already lists queue items, **agents ≥80% of cap**, and
**failed runs (24h)**; `agent.spentMonthlyCents`/`budgetMonthlyCents` are live columns (now
accruing for real thanks to the Phase 3 pricing fix). Core **budget_policies** already fire a
soft warn at `warnPercent` (80%). So most "budget visibility" already exists — this phase adds
the *real-time* and *weekly* layers and the observability that was missing.

## What was built (all additive Tethr files)

1. **Self-observability** — `observability.ts`: `reportServerError` posts to #scout via the
   Notifier, **throttled to one alert per error class per hour** (in-memory), never throws;
   `deepHealthCheck` returns `{ ok, db, lastHeartbeatAgeSec }`. `adapter.ts` now reports every
   **heartbeat failure** through it (throttled per agent) — failures surface within minutes, not
   just in the next daily digest.
2. **Deep health route** — `GET /api/tethr/health/deep` (public, like `/api/health`): 200/503 on
   DB reachability + heartbeat age, for an external uptime pinger (UptimeRobot setup in RUNBOOK).
3. **Weekly spend summary** — `digest.ts` `generateWeeklySummary`: total + per-agent spend vs
   cap to #scout (no emoji, brand-safe). Schedule Monday alongside the digest routine.
4. **RUNBOOK.md** — restart/redeploy, kill switches (agent pause → unset key → full stop),
   rollback per phase, health/uptime setup, access control, who-to-call.

## Access control — the smallest honest implementation (not a build)

Per the phase's own guidance: if core already provides auth, use it. It does — Paperclip core
ships **better-auth** and the deploy runs `authenticated`/`private` (`server/src/auth/better-auth.ts`,
found in Phase 1). So this is **creating 3 accounts**, not building an auth system:

- First visit → initial admin (Mark). Add Frank (admin) + Alec (viewer) via the app.
- **Open item to verify at deploy:** whether core exposes a *viewer* role. If not, make all
  three admins for now and note it — do **not** build a custom role system (that would be the
  >2-day path the phase says to avoid). Documented in `RUNBOOK.md` → Access control.

No STOP-and-present was needed because core auth exists; the only judgment call (viewer role) is
flagged for deploy-time confirmation rather than pre-built.

## Tests

`tethr-observability.test.ts` (2): the alert throttle (first fires, repeats within the hour are
suppressed, resets after the window, per-class independence). Full Tethr e2e green (the adapter
+ digest changes run in it); server typechecks. `pnpm test` → 19 green here.

## Verification (at deploy)

- Kill the worker / force a heartbeat failure → the throttled #scout alert arrives.
- Set an agent's cap just above current spend → the 80% warning appears (digest + core soft
  incident).
- `GET /api/tethr/health/deep` → 200 with a recent `lastHeartbeatAgeSec`; point UptimeRobot at it.
- Frank/Alec log in (Mark tests their credentials; passwords never printed).

## Rollback

All additive and toggle-off: alerts/digest via config; deep-health route is read-only; auth
rollback is the pre-phase commit (the `local_trusted` fallback stays in history). No core touched.
