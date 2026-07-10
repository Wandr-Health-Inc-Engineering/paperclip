# Phase 10 — Scale review vs the $1M-no-hiring goal

**Objective:** Step back and measure: what is Tethr saving or unlocking against the $1M-in-sales-without-headcount goal, and what's the next bottleneck — including whether the deferred pieces (ads pair, market-research agents, Azure migration, Graph API publishing) are now worth it.

**Definition of done:** A written review (`docs/tethr-buildout/scale-review-2026.md`) with real numbers: hours/week of manual work eliminated (workflow by workflow), total agent spend vs those hours, findings→merged-PR conversion for the Reliability loop, content output volume laptop-era vs Tethr-era, and a ranked next-bottleneck list with a recommendation. Reviewed with Frank and Alec.

**Prerequisites:** Phases 0–9 done, with ≥4 weeks of steady-state operation after Phase 5 completes (the numbers need a real month).

**Estimate:** 1 session + a founder conversation.

---

## Prompt 1 — the only prompt (paste into Claude Code)

> Enter plan mode briefly, then execute — this is read-only analysis, no code. Read CLAUDE.md, RUNBOOK.md, docs/adr/, and delegate to subagents: (a) pull the last 4+ weeks of cost_events / route_runs / budget data via the server's own DB or API and summarize spend per agent, runs per week, failure rate; (b) count Sentry+Pulse findings posted vs @Cursor PRs opened vs merged (I'll paste the #scout channel export or grant search access if needed); (c) count content outputs per week from Tethr Drive vs the pre-migration cadence recorded in `My Drive/tethr/engine-inventory.md`.
>
> Then write `docs/tethr-buildout/scale-review-2026.md`:
> 1. **The ledger:** estimated founder-hours/week eliminated per migrated workflow (state your assumptions per workflow; I'll correct them), total monthly agent spend, and the resulting $/hour-saved figure — honest, including the workflows where Tethr is *worse*.
> 2. **The loop:** recommendation→PR→merge conversion and median time-to-merge. If findings are being ignored, say so and diagnose why.
> 3. **Deferred-work re-evaluation:** ads pair (Tailwind/Ledger headless problem), market-research/future-product agents (revisit the SaMD boundary explicitly before recommending anything customer-facing), Azure migration (Railway bill vs Azure estate), Instagram Graph API. Rank by expected impact on the $1M goal.
> 4. **Next bottleneck:** the single constraint most limiting revenue-relevant output now, and a one-paragraph proposal for the next buildout cycle.
>
> Write the plan for the subagent pulls to `tasks/phase-10.md` first, get my approval on data access, then execute. No code changes, no config changes, nothing enabled or disabled.

## Checkpoint for Mark (phone)
Read scale-review-2026.md on GitHub mobile on a night shift. If the $/hour-saved number and the next-bottleneck call both feel right, forward it to Frank and Alec and book the conversation. That's the checkpoint.

## Rollback
Not applicable — read-only.
