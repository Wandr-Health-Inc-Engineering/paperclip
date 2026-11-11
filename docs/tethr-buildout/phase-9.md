# Phase 9 — Observability, budgets, access control

**Objective:** Make the running system trustworthy for a three-person team: error tracking on Tethr itself, budget alerting before caps hit, and real logins so Frank and Alec can see (not just Mark).

**Definition of done:** Tethr server errors reach #scout (or email) within minutes; each agent's spend posts a weekly digest and warns at 80% of cap; Tethr and Command Center each have working logins for Mark, Frank, and Alec with sensible roles; a `RUNBOOK.md` covers restart/rollback/who-to-call.

**Prerequisites:** Phases 3 and 5 (real spend flowing), Phase 7 (Command Center live) for its auth upgrade. 

**Estimate:** 3 sessions.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, server/src/tethr/digest.ts (the Helm daily digest exists — extend, don't duplicate), server/src/tethr/notify.ts, the budget/cost machinery (core budget_policies + cost_events usage from the tethr_llm adapter), and whatever auth exists in upstream Paperclip core (search server/ and AGENTS.md — V2 explicitly skipped auth work, so find what the core already ships before building anything).
>
> Three workstreams:
>
> 1. **Self-observability:** unhandled-error and heartbeat-failure reporting from the Tethr server to #scout via the existing Notifier (throttled — max 1 message per error class per hour). Add a `/healthz` deep-check variant (DB reachable, worker loop alive, last heartbeat age) and give me the copy-paste setup for a free external uptime pinger against it (UptimeRobot or Railway's own — check what Railway offers natively first).
> 2. **Budget visibility:** extend the Helm daily digest with per-agent spend vs cap; add an 80%-of-cap warning notification per agent; weekly Monday summary to #scout (total spend, per-agent, top 3 costly runs with links).
> 3. **Access control:** whatever the smallest honest implementation is given what core provides — target: three named users, Mark=admin, Frank=admin, Alec=viewer, for the Tethr UI; upgrade Command Center's shared password to the same pattern if trivially reusable, otherwise leave it and note why. If core has nothing and real auth means >2 days of work, STOP at the plan stage and present me options (build minimal vs Railway private networking + Tailscale vs defer) instead of sinking time silently.
>
> Write the plan to `tasks/phase-9.md` with per-step verification and stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-9.md. Verify: kill the worker process on Railway and show the error notification arriving; set a test agent's cap to just above current spend and show the 80% warning fire; all three logins work (I'll test Frank's and Alec's credentials handling myself — never print passwords, use env-var seeded initial credentials with forced reset if the mechanism allows). Write RUNBOOK.md (restart, rollback per phase, pause-all-heartbeats switch, budget kill-switch). Update CLAUDE.md. Commit on `tethr-buildout` and stop.

## Checkpoint for Mark (phone)
Three things on the phone: the deliberate-failure alert in #scout, the Monday spend digest (or a manually triggered one), and Frank confirming he can log in and see the Runs page. Two minutes plus one text to Frank.

## Rollback
All additive: alerts and digests toggle off via env/config. Auth rollback = the pre-phase git commit (keep the shared-password fallback path in the commit history).
