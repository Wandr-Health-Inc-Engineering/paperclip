# Phase 3 — Go live with Claude (supervised shakedown)

**Objective:** Flip the deployed Tethr from mock LLM to the real Claude provider for one agent (Sonar), under a hard budget cap, and prove the run/cost/audit trail end to end.

**Definition of done:** One real Sonar run (news-scan style task, read-only web) completed on the live provider from Railway; the run appears in TethrRuns with hop-by-hop detail; the spend appears in TethrBudgets against Sonar's cap; a cap set to a deliberately tiny value hard-stops a run (tested).

**Prerequisites:** Phase 1 (deployed). Phase 2 helpful but not required. An Anthropic API key with a low spend limit set at console.anthropic.com (Mark does this — recommend a $25/mo org-level limit for the shakedown).

**Estimate:** 2 sessions.

**Budget guardrail (required by this phase's definition):** Sonar `budgetMonthlyCents` stays at its seeded 10000 ($100/mo) ceiling but set the live test cap to $5 via the Budgets UI first; org-level API limit $25/mo during shakedown.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, server/src/tethr/llm/index.ts, llm/claude.ts, server/src/tethr/tools/index.ts (the allowlist registry), server/src/tethr/gating.ts, and the Sonar spec in server/src/tethr/seed/wandr-growth.ts.
>
> I want a supervised live-LLM shakedown, smallest possible surface:
>
> 1. Confirm exactly what changes when `ANTHROPIC_API_KEY` is set (provider swap in `getTethrLLMProvider()`) and what `TETHR_LIVE_FETCH` gates. List the env vars I'll set on Railway and in what order.
> 2. Define one test task for Sonar: a travel-health news scan (read-only web via the allowlisted fetch tool), output to Tethr Drive + in-app notification (+ #scout if Phase 2 is done). Confirm Sonar's tool allowlist permits nothing but fetch/read — no file writes outside Tethr Drive, no posting anywhere.
> 3. Cost-control verification plan: (a) before the real run, set Sonar's cap to $5 in the Budgets UI and confirm where the hard-stop fires in code (core budget_policies machinery — cite file); (b) a deliberate cap-exceeded test with a $0.01 cap proving the run halts and logs; (c) the real run; (d) where I read the actual cost (TethrBudgets page + cost_events).
> 4. Anything that would make a live run touch PHI, clinical systems, or publish externally: it must be impossible, not just avoided — show me why (allowlists + gating), or stop and flag.
>
> Write the plan to `tasks/phase-3.md` with exact verification commands/URLs per step and stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-3.md. Pause when it's time for me to set ANTHROPIC_API_KEY and TETHR_LIVE_FETCH on Railway. Run the $0.01 cap-stop test first and show me the halt evidence, then the real $5-capped Sonar run. After the run, give me: the TethrRuns URL for the run, the cost in cents, and the output location in Tethr Drive.
>
> Update CLAUDE.md (live-mode env vars, how to flip back to mock, where costs are read). Commit on `tethr-buildout`. Do NOT enable any heartbeat/cron — every live run in this phase is manually triggered. Stop for my review.

## Checkpoint for Mark (phone)
Open `<railway-url>` on your phone: Runs page shows the completed Sonar run; Budgets page shows a nonzero spend under Sonar, under $5. If Phase 2 is done, the news digest is also sitting in #scout. Two minutes.

## Rollback
Unset `ANTHROPIC_API_KEY` on Railway → instant revert to mock provider. Keep the org-level Anthropic spend limit in place permanently regardless.
