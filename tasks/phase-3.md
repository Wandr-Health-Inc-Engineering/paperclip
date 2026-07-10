# tasks/phase-3.md — Go live with Claude (supervised shakedown)

**Branch:** `tethr-buildout` · **Status: code + safety built 2026-07-09; live spend gated (B1/B2).**

Objective: flip the deployed Tethr from the mock LLM to the real Claude provider for one
agent (Sonar), under a hard budget cap, and prove the run/cost/audit trail end to end.
The provider path already exists; this phase made the **budget cap actually enforce** and
locked the **safety envelope** as tests. The live spend itself is a hard gate.

## Ground truth (verified by subagent audit, cited)

- **Provider swap** (`llm/index.ts:19-24`): `ANTHROPIC_API_KEY` set → `ClaudeProvider`
  (plain fetch to `api.anthropic.com`), unset → `MockProvider`. Model default
  `claude-sonnet-4-6` (`llm/claude.ts:19`), override `TETHR_CLAUDE_MODEL`. Provider is
  chosen once per process, so set the key before boot.
- **`TETHR_LIVE_FETCH`** (`tools/types.ts:31`) only gates the three web tools
  (`web_fetch`/`reddit_scan`/`cdc_scan`) between real read-only GETs and fixtures. It never
  enables a write or POST.
- **Allowlist enforcement is hard** (`worker.ts:138-144`): only allowlisted tools are
  advertised to Claude, and a non-allowlisted call returns a `blocked:` stub — it never
  reaches `.execute()`.
- **Gating blocks publish** (`gating.ts` `assertPublishable`): a `medical`/`public`/`spend`/`pr`
  output cannot publish without an `approved` core approvals row. `@sonar.reply` is `public`
  (gated); `@sonar.leads`/`@sonar.news` are `safe` (auto-publish to the DB-backed Drive only).

## Safety envelope for the live shakedown

- **(a) No writes outside the Drive — TRUE, unconditionally.** No runtime `fs`/`exec` in the
  Tethr layer; `drive_write` is DB-backed and path-confined; **no Sonar subagent even has
  `drive_write`**. Locked by `tethr-live-safety.test.ts`.
- **(b) No external publish — TRUE iff `SLACK_BOT_TOKEN` unset.** The only external vector is
  the `notify` tool → Slack, granted to `@sonar.leads` only and gated by `SLACK_BOT_TOKEN`.
  For the smallest-surface shakedown, leave `SLACK_BOT_TOKEN` unset (or accept #scout posts if
  Phase 2 is live). Locked by the test (notify on `@sonar.leads` only).
- **(c) Budget cap — NOW enforced (was not).** Two bugs found and fixed (both Tethr files):

  **Fix A — `seed.ts`:** per-agent budget policies were `hardStopEnabled: spec.key === "tailwind"`
  → only Tailwind's cap enforced; every other cap merely warned. Changed to
  `hardStopEnabled: true` for all agents (the non-negotiable requires every autonomous agent
  to keep its cap). Cost only accrues on live runs, so mock/dev never trips it.

  **Fix B — new `llm/pricing.ts` + `adapter.ts`:** the adapter reported no `costUsd`, so every
  `cost_events` row was 0 cents and no cap could ever trip. Added token→USD pricing
  (`claude-sonnet-4-6` = $3/$15 per MTok, env-overridable via `TETHR_PRICE_*`), wired into
  `resultJson.costUsd` for live (Claude) runs only. Core converts it to cents
  (`heartbeat.normalizeBilledCostCents`) and the hard-stop (`services/budgets.ts:691`) now fires.

  **Note:** these take effect on a **fresh seed** (idempotent seed skips an existing company).
  Mark's fresh Railway Postgres gets them; an existing dev DB needs a re-seed or a UI toggle.

## Env flip (gate B1/B2 — Mark, in order, on Railway)

1. Set an org spend limit at console.anthropic.com (**$25/mo**, keep permanently).
2. `railway variables --set ANTHROPIC_API_KEY=sk-ant-…` (secret) and
   `--set TETHR_LIVE_FETCH=true`. Leave `SLACK_BOT_TOKEN` unset for the tightest surface, or
   keep it for a #scout digest.
3. Restart the service (provider is chosen at boot).

## Verification plan (per the phase DoD)

- [x] `pnpm test` green incl. `tethr-live-safety.test.ts` (safety invariant + pricing); server typechecks.
- [ ] **(B2) $0.01 cap-stop test:** set Sonar's cap to $0.01 in the Budgets UI (or seed a tiny cap),
      trigger one live Sonar run; expect the cost_event to push observed ≥ cap → core pauses Sonar
      and blocks the next run (`getInvocationBlock` → `budget_blocked`). Show the halt evidence.
- [ ] **The real run:** restore Sonar's cap to $5, run a news-scan (read-only web) once; read the
      cost in cents on the TethrBudgets page and the output location in the Tethr Drive; the run
      appears in TethrRuns with hop detail.

## Rollback

Unset `ANTHROPIC_API_KEY` → instant revert to mock. Keep the org-level Anthropic spend limit
permanently. Pricing/hard-stop changes are inert under the mock provider (cost stays $0).

## No core touches

All changes are Tethr files (`seed.ts`, `adapter.ts`, new `llm/pricing.ts`, new test). Core's
existing `resultJson.costUsd` → cents path is used as-is. `DECISIONS.md` unchanged.
