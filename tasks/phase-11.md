# Phase 11 — Clean slate: one orchestrator agent, "Tethr"

## Why

Mark: the 12-agent org is overwhelming to manage. Gut it. Start over with ONE agent —
**Tethr** (`@tethr`) — the orchestrator / AI chat / coordinator. Tag `@tethr` on Slack,
DM it, or use the Console chat: every request lands on Tethr, which answers directly
today and will route to specialist agents as they are re-added one at a time.

## Design

- **New default seed** `seed/tethr-core.ts` → company **"Wandr"** (prefix `WD`):
  - 1 division: **Operations** (head: Tethr).
  - 1 agent: **Tethr** — tag `@tethr`, role Coordinator, routing table points to itself
    (no specialists yet). Budget $25/mo, hard-stop on. No heartbeat routines.
  - 2 subagents (the worker needs somewhere to land):
    - `@tethr.chat` — answer directly (Q&A, status, summaries, analysis). Sensitivity `safe`.
    - `@tethr.plan` — draft a plan/brief as an internal Drive doc. Sensitivity `internal`.
  - **Guts the old org non-destructively:** if "Wandr Growth" exists, set its status to
    `archived` (reversible; nothing is deleted). `seedWandrGrowth` stays in the repo —
    it's the parts bin for re-adding specialists later (`POST /api/tethr/seed {"org":"growth"}`).
- **Router resolution generalized:** `org.getRouterProfile()` — `@tethr` first, `@helm`
  fallback so the old org (and its tests) still route. `routing.ts` stops hard-coding `@helm`.
- **Plan-step guard:** mock plans can reference agents that don't exist in a minimal org —
  a plan is only accepted when every step's agent is in the router's routing table.
- **Slack:** company resolution finds the `@tethr` profile's company (name fallback kept).
  Inbound ack reworded; **the final answer is now posted back to the thread** when the run
  finishes (it previously only acked). Renaming the Slack app/bot to "Tethr" is a manual
  dashboard step (MANUAL-STEPS).
- **Tools:** `tethr.chat` → baseline + `web_fetch`, `google_ads_report`;
  `tethr.plan` → baseline + `web_fetch`, `drive_write`, `keyword_ideas`.
- **UI:** Console copy Helm→Tethr; Budgets page finds the router by tag (`@tethr` or `@helm`).
- **Tests:** new `tethr-core.test.ts` (seed shape, router resolution, end-to-end mock route,
  WG archived). Existing suites keep seeding Wandr Growth directly and stay green.

## Also swept up

- `digest.ts` hard-coded `@helm` — now attributes the daily digest / weekly spend summary to
  whatever router the org has.
- Two pre-existing typecheck errors fixed: `TETHR_MEMORY_KINDS` was missing Phase 6's
  `"published-content"` kind, and the Socket Mode `globalThis` cast needed `as unknown`.

## Known caveats

- `scripts/tethr-e2e.mjs` and `scripts/tethr-screenshots.mjs` exercise the old Sonar/growth
  loop — against a clean-slate DB they need the legacy org seeded first
  (`POST /api/tethr/seed {"org":"growth"}`).

## Out of scope

Deleting the old company's data (archived only); Slack app rename (Mark's dashboard);
re-adding any specialist agent.
