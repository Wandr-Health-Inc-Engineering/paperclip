# tasks/phase-4.md — V1 recommendation loop (Sentry → #scout → @Cursor → PR)

**Branch:** `tethr-buildout` · **Status: code + tests built 2026-07-09; live run + heartbeat gated.**

Objective (the V1 definition-of-done): an agent notices a non-medical, technical issue on
travelwithwandr.com's public surface, posts a structured recommendation to #scout, a human
tags `@Cursor` in-thread, Cursor opens a PR, humans merge. Nothing auto-merges.

## What was built

1. **Checks engine** — `server/src/tethr/checks/site-audit.ts`, pure HTML-in/findings-out so it
   unit-tests with no network. v1 checks: (a) meta title/description missing/too-long,
   (b) JSON-LD missing/malformed/wrong-@type, (c) broken internal links (4xx/5xx),
   (d) GA4 (`G-WP11MQFLQ5`) + GTM (`GTM-N7K829F8`) presence, plus cross-page duplicate titles.
   Each finding carries a stable `fingerprint` (`checkType:url:discriminator`) for dedupe.
   Severity-ranked; `selectFindingsToPost` caps a batch at 3, highest-severity first.
2. **Sentry policy + runner** — `server/src/tethr/checks/sentry.ts`: the fixed page list
   (home / destinations / travel-medicine / blog; `/blog latest 10` crawl noted as a later
   enhancement), the finding→recommendation bridge (reuses the Phase 2 `buildRecommendation`),
   and `runSentryAudit()` which fetches (read-only, 12s timeout, polite UA), runs the checks,
   **dedupes against `tethr_memories` within a 14-day window** (fingerprint stored in memory
   content), posts ≤3/day to #scout via the Notifier, and records each posted finding.
3. **Agent activation (seed)** — `seed/seed.ts` adds **Sentry** to the **Reliability division**
   (now flipped to `active`, head = Sentry): agent + profile (`@sentry`, approvalGate `internal`),
   a **$20/mo** budget policy with `hardStopEnabled: true`, and a daily-9AM heartbeat routine.
   **Seeded PAUSED** (routine trigger disabled) — the heartbeat only runs after Mark enables it.
4. **Heartbeat mode** — `adapter.ts` gets a `site_audit` branch (sibling of Helm's `digest`):
   when Sentry's heartbeat fires, it runs `runSentryAudit`. `TETHR_SENTRY_DRY_RUN=true` computes
   findings and returns them in the run's `resultJson` **without posting or recording** — the
   pre-enable preview.
5. **The fix loop is Cursor's native Slack integration — nothing built for it.** The
   recommendation format keeps file paths as plain text so `@Cursor` copy is clean.

## Scope / boundary

Public pages, read-only, **structural/technical only**. Medication/medical *content*
correctness is explicitly out (licensed-human domain). Findings are internal #scout
recommendations, never customer-facing output — SaMD boundary intact.

## Tests

`server/src/__tests__/tethr-site-audit.test.ts` (16): each check against fixture HTML, link
extraction, dedupe/selection ranking + cap, and an end-to-end `runSiteAudit` with injected
fetch. The seed test (`tethr.test.ts`) updated to the new org shape (11 profiles; Reliability
active). `pnpm test` → 55 green; server typechecks.

## Manual run + enable (gate B3 + a "go")

Prereq: **Cursor's Slack integration** installed in the workspace, default repo = the website
repo (Mark, ~10 min — Cursor's native feature). Then:

1. **Preview (dry run):** with the server deployed, set `TETHR_SENTRY_DRY_RUN=true` and trigger
   Sentry once — `POST <url>/api/tethr/<companyId>/agents/<sentryAgentId>/run-now` (or "Run now"
   on the Company page). The run's `resultJson.sentry.postedFindings` shows exactly what it
   *would* post. Review the batch.
2. **Go live:** unset `TETHR_SENTRY_DRY_RUN`; ensure `SLACK_BOT_TOKEN` is set (Phase 2) so posts
   reach #scout. Trigger once to post the reviewed batch, then **enable Sentry's heartbeat**
   (unpause the agent / enable its routine trigger) for the daily $20-capped run.
3. In #scout, reply in-thread `@Cursor fix this — <one sentence>`. Cursor opens the PR; a human
   reviews and merges. **That merged PR is V1 done.**

## No core touches

All additive Tethr files (`checks/*`, `adapter.ts`, `seed.ts`, tests). `DECISIONS.md` unchanged.

## Rollback

Pause Sentry's heartbeat (or set its cap to 0 — hard-stop now works). Cursor PRs are just PRs.
