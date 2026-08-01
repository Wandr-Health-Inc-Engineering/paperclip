# Tethr build — decisions log

Branch: `mark-sandbox` (local only). Date started: 2026-06-11.

## Baseline

- Upstream merge-base (paperclipai/paperclip): `68f4eb6b967fb1583396006187434920df6ca037`
- Fork HEAD at build start: `436dc2b7` (tethr reskin phase 12)
- Toolchain: Node v24, pnpm 9.15.4, Vite 6 / React 19 / Tailwind v4, Express 5, Drizzle ORM,
  Postgres (embedded for dev, external via `DATABASE_URL`, docker-compose provides Postgres 17)

## Stack and shape decisions

1. **Build inside the fork's existing seams, not a parallel app.** The BUILD-PROMPT sketches
   `tethr-server` / `tethr-shell` / `tethr-addons` directories; this fork already *is* the
   Tethr shell (12 reskin phases) and Paperclip core already provides companies, agents with
   `reportsTo`, heartbeat runs, cron routines, approvals, budget policies, cost events,
   activity log, and a `StorageService` with local-disk + S3 providers. Rebuilding those
   in a side app would duplicate the engine and break the "thin shell, rich edges" rule.
   Tethr code lives in clearly separated modules instead:
   - `packages/db/src/schema/tethr_*.ts` — additive tables
   - `server/src/tethr/**` — all Tethr services (routing, drive, gating, llm, seed)
   - `server/src/routes/tethr.ts` — one route module
   - `ui/src/pages/tethr/**` + `ui/src/components/tethr/**` — all new screens
2. **DB = Postgres via Drizzle with generated migrations** (matches core exactly; SQLite
   rejected). Local dev uses the embedded Postgres core already ships; `docker compose up`
   provides Postgres 17 for the containerized path. Cloud swap = `DATABASE_URL` change.
3. **Storage**: file bytes go through core's `StorageService` interface
   (`local_disk` default → `s3` by env, already implemented in core). Tethr adds the
   *Drive* metadata layer (folders, versions, tags, permissions) in `tethr_drive_*` tables,
   keyed by provider object keys. Future GCS/S3 = implement provider + env switch; callers
   untouched. Local bytes live under `.tethr-data/storage/` (env-configured, gitignored).
4. **LLM**: `LLMProvider` interface in `server/src/tethr/llm/`. `ClaudeProvider` used when
   `ANTHROPIC_API_KEY` is present; otherwise `MockProvider` returns deterministic,
   realistically-shaped output (routing decisions, leads, replies, briefs) so the entire
   product is demoable offline. No keys hardcoded.
5. **Agent execution**: a real server adapter `tethr-llm` registered through the adapter
   registry (the documented seam). Heartbeats/routines/run-now/cost events therefore flow
   through core machinery unmodified. The adapter runs the classify → route → do loop and
   returns resultJson + usage.
6. **Approval gating**: gated outputs are `tethr_outputs` rows with status `gated`; each
   gets a core `approvals` row (type `tethr_output`). Publish transitions are *only*
   performed by the gating service after the linked approval is `approved` — a hard block,
   not advisory. Reject / request-changes flow back to the output status. Every decision is
   written to the core activity log (audit).
7. **Subagents are Tethr rows, not core employees** (matches the bundle manifest: "config
   inside agent, not separate employees in v1"). `tethr_subagents` carries the full
   fine-tuned spec (route-when, reads, steps, output, guardrails, done, escalation).
8. **Divisions are first-class** (`tethr_divisions`), CEO → division head → agents.
   Growth seeded fully; Engineering/Tech, Reliability/Errors, Customer Feedback/Support
   seeded as ready-to-fill shells (head slot + empty agent slots), so adding a division is
   data, not architecture.
9. **Seed source**: the importer reads the bundle at `TETHR_BUNDLE_PATH`
   (default: Mark's Drive path) for agent ROLE/ROUTING/subagent markdown and copies them
   into Drive storage. A vendored compact org spec (`server/src/tethr/seed/wandr-growth.ts`,
   derived from `import/wandr-growth.company.json` + FINE-TUNING-SUMMARY) makes the seed
   fully self-contained when the Drive bundle is absent. The live bundle is never written to.
10. **Naming (brand kit surfaces)**: Console (Helm), Queue (approvals), Drive (files),
    Runs, Budgets, Audit, Company. "Ledger"/"Beacon" surface names from the brand kit were
    skipped — they collide with agent codenames.
11. **Sonar's Slack delivery** is a `Notifier` interface: in-app notification center is the
    working local implementation; `SlackNotifier`/`SmsNotifier`/`EmailNotifier` are stubs
    behind the same interface (mock locally, listed in MIGRATION-NOTES.md).
12. **No live integrations touched**: no Google Drive, no Slack, no Google Ads, no GA4.
    Tailwind (ads) + spend paths are execution-gated and mock-only.

## V2 decisions (operating-grade build, 2026-06-12)

13. **Tool registry with per-subagent allowlists** (`server/src/tethr/tools/`): every
    subagent gets `drive_list`/`drive_read`/`recall_memory`; web reach (web_fetch,
    reddit_scan, cdc_scan) and tracker writes only where the spec's `reads` call for
    them. `drive_write` is restricted to `/state/` + `/scratch/` — publishing still
    only happens through the gating service, so tools cannot bypass the hard gates.
14. **Live fetch is flag-gated** (`TETHR_LIVE_FETCH=true`, on for Mark's instance) with
    deterministic fixtures otherwise. Live CDC RSS works; **Reddit returns 403 to
    unauthenticated clients** — reddit_scan degrades to fixtures gracefully; cloud team
    can add read-only OAuth creds later. Rate limit ~1 req/s, honest User-Agent, GET only.
15. **Agentic loop on both providers**: ClaudeProvider runs the real tools API loop
    (8-turn cap, forced final answer at cap); MockProvider runs a deterministic scripted
    loop so tests/offline demos behave identically run-to-run. Every tool call is a
    `tool` hop on the route run.
16. **Trackers are versioned JSON in `/state/`**, not markdown tables: a single
    atomic `putFile` per advance = the locked-tracker problem from the bundle resolved
    by version history instead of lock files. Approve-publish appends the dedup log and
    flips the claimed row to published (topic/slug heuristic match, noted).
17. **Revisions**: `request_changes` auto-triggers a revision (`TETHR_AUTO_REVISE=false`
    disables; manual button exists). v(n+1) links to v(n) via `revision_of_id`
    (migration 0088) and re-enters the same gate.
18. **Plans**: Helm asks the provider for a multi-agent sequence before single-agent
    classification; the three worked examples from ROUTING-MODEL.md are the mock's
    canned plans. Steps share results forward; spend/clinical steps still gate.
19. **Live console = async route + poll** (650ms) rather than new websocket event types
    in shared — keeps the core LiveEventType union untouched. Console paces hops at
    350ms so the chain is watchable; heartbeat/run-now paths stay synchronous.
20. **Digest** is a heartbeatMode on Helm's adapter config (5 PM routine), not a fake
    subagent — Helm is a router and a reporter, never a producer.
21. **Export carries state, not history**: org + specs + memories + outputs + drive
    files (≤256KB each, base64). Import restores drive + company-wide memories into an
    existing company; full org remapping stays a cloud-importer task (documented).
22. **Core company remove() fixed** (the V1-documented bug): cost_events before
    heartbeat_runs, routines/budget-policies added, tethr tables cleared first (their
    CASCADE + SET NULL mix trips Postgres RI checks when agents delete mid-transaction).
    Regression-tested in tethr.test.ts. This is the one substantive core change; it is
    upstreamable as written.
23. **Upstream merge drill** (2026-06-12, vs upstream/master `d9ea1bf9`): 24 conflicted
    files, zero in `tethr` files. Conflicts are reskin-era styling + the logged
    registration points (.gitignore, shared/index.ts, Sidebar, companies.ts,
    migrations journal) — all one-liner shape, as designed. Drill aborted cleanly.

## Core changes (keep merge-safe)

Every core file touched, with reason. Everything else Tethr lives in new files.

| File | Change | Why |
|------|--------|-----|
| `packages/db/src/schema/index.ts` | + exports for `tethr_*` schema files | barrel is the only registration point |
| `packages/shared/src/constants.ts` (or new `tethr.ts` + index export) | + Tethr status constants | match core enum convention |
| `server/src/app.ts` | + mount line for `tethrRoutes` + `initTethr(db)` (adapter registration) | route registration point |
| `server/src/index.ts` | + 1 line `maybeAutoSeed(db)` at startup | seeding is a boot concern, not an app-construction concern (keeps API tests clean) |
| `server/src/adapters/index.ts` | + 1 registry entry for `tethr-llm` | documented adapter seam |
| `ui/src/App.tsx` | + route entries for Tethr pages; Phase 15: `/inbox*` → redirect to `/queue` (Inbox retired — its Approve flipped the approvals row without calling `gating.decide`, so Tethr outputs never published/applied; Queue is the single approval surface) | route table |
| `ui/src/components/Sidebar.tsx` | + "Operate" nav section; Phase 12 de-dup: dropped overlapping core nav items (Runs→Routines, Costs→Budgets, Org→Company, Activity→the Tethr trail) per Mark — routes untouched, only nav links; Phase 15: Inbox nav item removed (see App.tsx row) | nav registration point |
| `ui/src/components/CommandPalette.tsx` | + page entries; Phase 15: Inbox entry removed | palette registration point |
| `ui/src/components/MobileBottomNav.tsx` | Phase 15: Inbox tab → Queue tab (same reason as the App.tsx inbox row) | mobile nav registration point |
| `ui/src/lib/company-routes.ts` | + Tethr route roots in `BOARD_ROUTE_ROOTS` | prefix resolver allowlist |
| `packages/db/src/migrations/meta/_journal.json` | + entries 0086–0089 | inherent to adding migrations |
| `server/src/services/companies.ts` | remove(): FK-order fix + routine/budget/tethr tables | pre-existing core bug (V1 log), now fixed + tested |
| `ui/src/components/BreadcrumbBar.tsx` | + `<TethrBell />` next to the theme toggle | global toolbar is the only bell mount point |
| `ui/src/styles/tethr-theme.css` | + routing-flow / stagger animation section | the brand layer is designed to be extended here |
| `.gitignore` | + `.tethr-data/` | local data dir |
| `.env.example` | + Tethr vars (commented, blank) | 12-factor |
| `README.md` | + a 5-line fork banner above the upstream header pointing at `TETHR-ENGINEERING.md` + `CLAUDE.md` | an engineer landing on the repo has to be told this is a fork and where the map is; upstream's README body is untouched below it |

Verified with `git diff --diff-filter=M --stat 436dc2b7..HEAD`: 12 modified files,
230 insertions / 1 deletion — everything else is new files.

(Reskin-era copy edits across pages predate this build and are documented in BRANDING.md.)

## Assumptions

- "Task board" DoD item is satisfied by core Issues (hierarchical, statuses, assignees) —
  surfaced from Tethr nav; no parallel task system built.
- Core `Approvals`/`Activity`/`Costs` pages remain; Tethr's Queue/Audit/Budgets pages are
  the product surfaces over the same data + Tethr gating data.
- The bundle's `wandr-destination-brief` skill is missing upstream (flagged in bundle);
  Compass runs against a mock brief generator in the LLM provider — noted, not a blocker.
- Google Ads MCP / Chrome action layer are laptop-bound per handoff.md → Tailwind stays
  recommendation-only with hard spend gates in this build.
- Heartbeat cadences map 1:1 from manifest cron strings into core routines. They seed
  `active` (matching production-enabled workflows) except Sonar, which seeds `paused`
  exactly as in production since 2026-03-25. Active routines run the mock provider on
  their schedule — a live company, with gated work stopping in the Queue.
- Upstream bug observed (not fixed, to stay merge-safe): core company `remove()` deletes
  `heartbeat_runs` before `cost_events` and predates routines/budget-policy tables, so
  deleting a company with cost-linked runs fails on FK order. Tethr tables all cascade
  on company delete (migration 0087) so they never add to the problem.
- Pre-existing test failure (verified on baseline 436dc2b7 in a clean worktree):
  `server/src/__tests__/heartbeat-comment-wake-batching.test.ts` — two 90s-timeout
  cases fail before and after this build identically. Final state: server suite
  1814 passed / 2 pre-existing failures; Tethr suite 10/10; UI 987/987; shared+db green.
