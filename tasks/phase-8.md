# tasks/phase-8.md — Pulse: PostHog error/regression agent

**Branch:** `tethr-buildout` · **Status: code + tests built 2026-07-09; key + config + enable gated.**

Objective: extend the Phase 4 loop from public-site auditing to **application-level** error
detection — PostHog-driven — so tracking regressions, error spikes, and funnel breaks get
flagged to #scout and fixed through the same `@Cursor` → PR pattern. Non-clinical only.

## What was built (all additive Tethr files)

1. **Constrained PostHog access** — `tools/posthog.ts`: read-only, **exactly three** HogQL
   queries against project 361561 (error counts by type today-vs-7-day-baseline; per-event
   volume today-vs-baseline; two-step funnel conversion today-vs-yesterday). A **PHI denylist**
   rejects any event name that could carry patient/clinical context *before* a query runs — no
   person-level queries, no PII, ever. Key from `POSTHOG_API_KEY`.
2. **Detection rules** — `checks/pulse.ts`, pure + unit-tested: error type > 3× its 7-day
   baseline (above a noise floor); a critical event at 0 for 24h with a real baseline; funnel
   conversion down > 30% day-over-day (above a volume floor). Each finding carries the numbers.
3. **Config** — `tools/pulse-events.json` placeholder (`FILL_ME` critical events + funnel
   steps); the loader stays **not-ready** until placeholders are gone and drops any denylisted
   name. Override path via `TETHR_PULSE_CONFIG`.
4. **Loop reuse** — `runPulseAudit` reuses the exact Phase 4 path: recommendation builder,
   14-day memory dedupe (`pulse:fp:` marker), ≤3/day, #scout via the Notifier. No new plumbing.
5. **Agent activation (seed)** — **Pulse** added to the Reliability division (second agent
   alongside Sentry): profile (`@pulse`, `internal`), **$20/mo** cap `hardStopEnabled`, daily-10AM
   heartbeat — **seeded PAUSED and inert** until `POSTHOG_API_KEY` is set and the config filled.
6. **Heartbeat mode** — `adapter.ts` `pulse_audit` branch (sibling of `site_audit`).
   `TETHR_PULSE_DRY_RUN=true` previews findings without posting.

## Boundary check (required)

None of the three queries can return PHI: they aggregate event counts only (no person/property
selection beyond `$exception_type` and configured marketing event names), and the denylist
rejects clinical event names at config load. Verified by `tethr-pulse.test.ts`.

## Tests

`tethr-pulse.test.ts` (10): each detection rule (fires / correctly ignores), the PHI denylist,
config readiness + rejection, and dedupe/selection. Seed-count test updated (12 profiles). Full
Tethr e2e green; server typechecks.

## Gates (Mark)

1. **C2 — PostHog key:** create a **read-only** personal API key scoped to project 361561;
   `railway variables --set POSTHOG_API_KEY=phx_…`.
2. **Fill `server/src/tethr/tools/pulse-events.json`** with real critical event names + a funnel
   pair (marketing events only — clinical names are auto-rejected). Commit it (it's config, not a
   secret).
3. **Preview** with `TETHR_PULSE_DRY_RUN=true` (Run-now on Pulse → `resultJson.pulse.postedFindings`),
   review, then unset it and **enable Pulse's heartbeat** for the daily $20-capped run.

## Rollback

Pause Pulse's heartbeat or zero its cap. Unset `POSTHOG_API_KEY` to sever the data source
entirely (the runner returns inert). No core files touched; nothing depends on it.
