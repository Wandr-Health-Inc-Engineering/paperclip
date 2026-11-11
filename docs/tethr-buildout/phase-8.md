# Phase 8 — Error/bug-patching agent (expand the Reliability division)

**Objective:** Extend the Phase 4 loop from public-site auditing to application-level error detection — PostHog-driven — so tracking regressions, JS errors, and funnel breaks get flagged and fixed through the same #scout → @Cursor → PR pattern.

**Definition of done:** A second Reliability agent consumes PostHog data on a heartbeat, has flagged at least one real regression class (error spike, dead tracking event, funnel step drop) to #scout in the standard format, deduped via memory, under its own budget cap. Scope stays strictly non-clinical.

**Prerequisites:** Phase 4 (Sentry + loop working, Cursor integration proven), Phase 6 (dedupe memory). A PostHog personal API key scoped read-only to project 361561 (Mark creates it; the GA4/GTM checks stay in Sentry — this agent owns PostHog).

**Estimate:** 3 sessions.

**Budget guardrail:** new agent cap $20/mo, daily heartbeat, max 3 findings/day, hard-stop on cap.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, the Sentry agent from Phase 4 (its seed/definition files and tasks/phase-4.md), server/src/tethr/tools/index.ts, and server/src/tethr/memory.ts.
>
> Add a second Reliability agent, codename **Pulse**:
>
> 1. **Data source:** PostHog API, read-only key from env `POSTHOG_API_KEY`, project 361561 (us.posthog.com). Add a PostHog tool to the allowlisted tool registry (additive file under server/src/tethr/tools/) exposing exactly three queries: (a) error/exception event counts by type, last 24h vs prior 7-day baseline; (b) presence/volume of a configured list of critical tracking events (I'll give you the event names — put a placeholder config file at server/src/tethr/tools/pulse-events.json and ask me to fill it before first run); (c) conversion between two configured funnel steps, day-over-day. Nothing else — no person-level queries, no PII fields, ever.
> 2. **Detection rules, v1 (dumb and explainable, no ML):** error type count > 3× its 7-day baseline; critical event volume = 0 for 24h when baseline > 0; funnel step conversion drop > 30% day-over-day. Each rule fires a finding with the numbers in the message.
> 3. **Loop reuse:** findings go through the exact Phase 4 path — recommendation builder, memory dedupe (14-day fingerprint window), ≤3/day, #scout, @Cursor footer. No new plumbing.
> 4. **Boundary check:** confirm none of the three queries can return PHI or clinical data (marketing-site analytics only). If any configured event name could carry patient context, the config loader must reject it against a denylist — plan that in.
>
> Write the plan to `tasks/phase-8.md` with per-step verification (fixture-based unit tests for each detection rule; one manual run with heartbeat off) and stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-8.md. Pause for me to: fill pulse-events.json, set POSTHOG_API_KEY on Railway. Run the manual audit and show me what it *would* post; on my approval, post and enable the daily heartbeat with the $20 cap. Update CLAUDE.md (Pulse scope, config file, pause instructions). Commit on `tethr-buildout` and stop.

## Checkpoint for Mark (phone)
A Pulse finding in #scout with real numbers ("checkout_started: 0 events in 24h, baseline 41/day"), and the Budgets page shows Pulse under its cap. Optionally run one through @Cursor like Phase 4. Two minutes.

## Rollback
Pause Pulse's heartbeat or zero its cap. Unset POSTHOG_API_KEY to sever the data source entirely. Nothing depends on it.
