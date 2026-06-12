# BUILD PROMPT V2 — Tethr: from working demo to operating company

> **How to use this file.** Paste it whole into a fresh Claude Code session opened in
> this repo (`~/git/paperclip`, branch `mark-sandbox`). It assumes V1 is complete and
> committed (it is — see `git log` from `b76a428d` through `9706138e`). Read §1's
> file list before writing a line of code. Same rules as V1: local only, never push,
> never touch live Wandr systems. This is a long, deliberate build — run to completion
> against §7, do not stop at phase boundaries to check in.

---

## 0. WHERE V1 LEFT THE PRODUCT (read this honestly)

V1 delivered the **control plane**: the seeded company (CEO → Helm → 8 agents → 22
subagents + shell divisions), the classify→route→do engine, hard approval gates,
the versioned Drive, budgets/runs/audit, nine premium screens, tests, docs,
screenshots. Everything demos end-to-end and everything is real code behind real
interfaces.

What it is **not yet**: an operating company. The honest gaps, in priority order —

| # | Gap | Today | Operating-grade |
|---|-----|-------|-----------------|
| 1 | **Agents have no tools** | the "do" step is one LLM call shaped by the subagent spec | an agentic loop where the subagent can search the web, read/write Drive files, recall memory, and check trackers before producing output |
| 2 | **No revision loop** | "Request changes" sets a status and stops | the agent picks the note up, produces v2 linked to the same thread, the Queue shows the lineage |
| 3 | **No working state** | Atlas has no content calendar, Compass no tracker queue — each run invents from nothing | calendars/trackers live in the Drive as structured files agents read and atomically advance, with dedup against published work |
| 4 | **Single-agent routing only** | one request → one agent → one subagent | Helm orchestrates multi-agent sequences ("Launch Peru campaign" → Beacon → Ledger → Tailwind → Atlas), per ROUTING-MODEL.md |
| 5 | **Console is one-shot** | request → replayed hops → result | threaded conversations; hops stream live while the run executes |
| 6 | **Operator surface holes** | notifications exist only as DB rows; no add-agent/division flow; memory has no UI | a bell + inbox digest; "add division/agent" wizard proving shells are fillable; a Memory surface |
| 7 | **Trust hardening** | unit/integration tests only | a Playwright e2e of the Sonar loop in the browser; company export that includes `tethr_*` tables; an upstream-rebase drill |

## 1. READ FIRST (30 minutes, in this order)

1. `DECISIONS.md` — every architectural call + the core-touch audit. **Extend this file
   as you work; same discipline.**
2. `ARCHITECTURE-LOCAL.md` — the layer map and how an agent actually runs.
3. `server/src/tethr/` — the whole add-on layer (~10 files; read all of it):
   `routing.ts`, `worker.ts`, `gating.ts`, `drive.ts`, `adapter.ts`, `llm/*`,
   `seed/wandr-growth.ts`, `seed/seed.ts`.
4. `server/src/routes/tethr.ts` and `ui/src/api/tethr.ts` — the API contract.
5. `ui/src/pages/tethr/` — all nine screens; `ui/src/components/tethr/` primitives.
6. `server/src/__tests__/tethr.test.ts` — the invariants you must not break.
7. The bundle (read-only): `ROUTING-MODEL.md` §"Multi-Agent Sequences",
   `agents/helm/atlas/_content-calendar.md`, `skills/wandr/lead-scout/SKILL.md` —
   these define what Phases 2–4 must faithfully implement.

## 2. NON-NEGOTIABLES (unchanged from V1, two amendments)

1. **Never push. Local `mark-sandbox` only.** Commit small and often.
2. **Merge-safe core.** New code in `server/src/tethr/`, `ui/src/pages/tethr/`,
   `ui/src/components/tethr/`, `packages/db/src/schema/tethr_*`. Any core file touch
   is a one-liner logged in DECISIONS.md "Core changes".
3. **Never touch live Wandr systems** — no Slack posting, no Google Drive writes, no
   Google Ads, no GA4, no posting to Reddit/X ever.
   **Amendment A:** *read-only public web* is now allowed behind the tool registry
   (Reddit public JSON, CDC/WHO RSS, plain HTTP GET) — feature-flagged
   `TETHR_LIVE_FETCH=true`, off by default, with a deterministic fixture fallback so
   tests and offline demos still work. Never authenticate, never write, rate-limit
   politely (1 req/sec, proper User-Agent).
4. **Hard gates stay hard.** Nothing medical/public/spend/PR ships except through
   `gating.decide`. Every new path you add must keep
   `tethr.test.ts > hard-gates the Sonar reply` green.
5. **Secrets in env only.** Extend `.env.example` for every new knob.
6. **No dead ends, no regressions.** Every new button works; `cd server && npx vitest
   run src/__tests__/tethr.test.ts` and `cd ui && npx vitest run` stay green after
   every phase. (Known pre-existing failure: `heartbeat-comment-wake-batching` ×2 —
   fails on the pristine baseline, not yours to fix unless Phase 6 makes it cheap.)
   **Amendment B:** the deterministic mock provider remains the default and must keep
   the FULL product demoable offline — every new capability needs a mock path.

## 3. DECISIONS NEEDED FROM MARK (ask once at session start, then proceed)

Put his answers at the top of DECISIONS.md. If unanswered, use the defaults in bold.

1. Run this build with a live `ANTHROPIC_API_KEY`? (**default: no** — mock; the seam
   is proven, key can be added any time)
2. Enable `TETHR_LIVE_FETCH` for read-only Reddit/CDC scanning? (**default: yes** —
   it is what makes Sonar genuinely useful, and it is read-only public data)
3. Reactivate Sonar's 08:00 cadence or keep manual? (**default: manual** until he has
   watched a week of Queue output)
4. Real budget numbers per agent? (**default: keep V1 placeholder caps**)

## 4. THE BUILD — six phases, in order

### Phase 1 — Give agents hands: the tool loop
The single highest-value change. Build `server/src/tethr/tools/`:

- `types.ts` — `TethrTool { name, description, inputSchema, execute(ctx, input) }`
  with a per-subagent allowlist derived from its `reads` spec.
- Tools: `web_fetch` (public GET, flag-gated, fixture fallback in
  `tools/fixtures/`), `reddit_scan` (public `/r/<sub>/new.json`, same gating),
  `drive_read` / `drive_write` / `drive_list` (through `driveService` — writes only
  to the agent's own working folders, never `/published`), `recall_memory`,
  `read_tracker` / `advance_tracker` (Phase 3), `notify`.
- Extend `LLMProvider` with a `runAgentic(system, prompt, tools, maxTurns)` method:
  ClaudeProvider implements the real tool-use loop (the `/v1/messages` `tools` API,
  loop until `end_turn`, cap ~8 turns, cap tokens); MockProvider implements a
  deterministic 2-turn scripted loop (calls the obvious tool, then produces the
  template output) so offline behavior still demos and tests stay deterministic.
- `worker.ts` switches from `generate` to `runAgentic`, passing the subagent's
  allowed tools. Record every tool call on the route run (`hops` gains
  `layer: "tool"` entries) so the Console visualizes tool use in the chain — this is
  the V2 signature moment: *watching Sonar actually scan Reddit, hop by hop*.
- Tests: tool allowlisting (Sonar cannot `drive_write` to `/content`), fixture
  determinism, agentic loop turn cap, gating unchanged.

### Phase 2 — Close the loop: revisions
- `request_changes` currently dead-ends. Add `tethr_outputs.parentOutputId` +
  `revisionOfId` (new migration, additive) and a worker entry point
  `reviseOutput(outputId)`: loads the original + the reviewer note, re-runs the
  subagent with both in context, produces v2 linked to v1, new approval, notifies.
- Trigger it two ways: a "Send back to agent" button on the Queue decision record,
  and automatically on `request_changes` (flag `TETHR_AUTO_REVISE`, default on).
- Queue detail shows the revision chain (v1 rejected-with-note → v2 pending) — make
  the lineage visible and satisfying; this is the governance story in one screen.

### Phase 3 — Working state: calendars and trackers in the Drive
- Define a small structured format (front-mattered markdown or JSON) for:
  `/state/content-calendar.md` (Atlas), `/state/destination-tracker.md` (Compass),
  `/state/itinerary-calendar.md` (Voyager), `/state/published-log.md` (dedup feed).
  Seed them from the bundle's real calendars (`_content-calendar.md` files) when
  `TETHR_BUNDLE_PATH` is set; vendored compact versions otherwise.
- `read_tracker`/`advance_tracker` tools operate on these atomically (single
  putFile = new version = free audit trail; the locked-tracker fallback from the
  bundle becomes: last-writer-wins + version history, note it in DECISIONS).
- Heartbeats now do what production did: Atlas picks the next calendar row and marks
  it Review; Compass advances the queue and appends one idea; publish-on-approve
  appends to the published log so dedup is real.

### Phase 4 — Helm orchestration: sequences, threads, live hops
- `routing.ts` gains plans: Helm's classify step may return an ordered sequence
  (`[{agent, request}, …]`) for cross-domain requests — implement the three worked
  examples from ROUTING-MODEL.md (Peru campaign; profitable-enough-to-scale;
  partnership-closed). Mock provider: keyword-triggered canned plans; Claude:
  prompt for a JSON plan. Each step is its own agent/subagent run on the same route
  run, outputs feeding the next step's context. Spend/clinical steps still gate.
- Console becomes threaded: `tethr_console_threads` (or reuse route runs grouped by
  a `threadId`) so a follow-up message carries prior context.
- Live streaming: the engine already writes hops incrementally — publish a
  `activity.logged`-driven invalidation (the LiveUpdatesProvider pattern) or poll the
  route run while status ∈ {routing, working} so hops animate *as they happen*
  instead of replaying after the fact.

### Phase 5 — Operator surface completions
- **Bell**: header notification center (unread count, mark-read, links) over the
  existing `tethr_notifications` API. Mobile: surface in the bottom nav badge.
- **Add division / add agent**: the shells' "ready to fill" promise made real — a
  wizard that creates division → head agent → profile → optional subagents from a
  template, proving "adding a division is data, not architecture" *in the UI*.
- **Memory page** (`/memory`): browse/search company + per-agent memories; show
  recall in agent detail.
- **Daily digest**: a routine (assigned to Helm, 17:00) that produces an *internal*
  output summarizing queue items, budget warnings, failed runs → notification.
- Refresh `~/Desktop/tethr-screenshots/` (rerun `node scripts/tethr-screenshots.mjs`,
  add captures for the new surfaces and the tool-use chain).

### Phase 6 — Trust hardening
- **Playwright e2e** (`tests/e2e/tethr.spec.ts` or alongside the screenshot script):
  drive the browser through Sonar run-now → Queue review → approve → file in Drive →
  audit entry. This is the regression net for everything above.
- **Export/import**: extend company export to include `tethr_*` tables (check
  `server/src/routes/companies.ts` export path; if too invasive, a Tethr-side
  `GET /tethr/:companyId/export` JSON bundle + import counterpart is acceptable and
  merge-safer). This is how Wandr Growth's accumulated state moves to the cloud.
- **Core bug**: fix company `remove()` FK ordering (cost_events before
  heartbeat_runs; add routines/budget_policies/tethr cascade awareness) as a small,
  clearly-commented core patch — log it as the one substantive core change and write
  a test. It is upstreamable.
- **Upstream drill**: `git fetch upstream && git merge-base` → trial
  `git merge --no-commit upstream/master` in a worktree, document conflicts (should
  be ~none in tethr files) in DECISIONS.md, abort the merge. Proves the fork story.
- Accessibility pass (focus order on Queue decisions, aria labels on the route flow),
  perf pass (Console history pagination, Drive listing for large folders).

## 5. WHAT *NOT* TO BUILD (so effort goes where it matters)

- No real Slack/SMS/email senders — cloud team, per MIGRATION-NOTES.md.
- No Google Ads / GA4 integration, even read-only — laptop-bound auth, port last.
- No auth/roles work — core better-auth covers it; reviewer identity strings are fine
  locally.
- No new visual language — extend `tethr-theme.css` in its own idiom only.
- No queue/worker infra (Redis etc.) — the synchronous runner + core heartbeat
  machinery are sufficient locally; don't add moving parts the cloud team will replace.

## 6. WORKING METHOD

Same as V1: keep `PLAN.md` as a living checklist (start a "V2" section), update
DECISIONS.md as you decide, commit after every coherent step with `tethr:` prefixed
messages, re-read §2 before any git command. Verify in the browser with the Vite dev
server as you go — every phase ends with the Tethr tests green plus at least one new
test for the phase's invariant. If blocked, route around and document; never stub a
button.

## 7. DEFINITION OF DONE (V2)

- Sonar's heartbeat **actually scans Reddit** (flag on) or fixtures (flag off), and
  the Console shows the tool calls in the hop chain.
- A rejected-with-changes output **comes back revised** and the Queue shows lineage.
- Atlas/Compass heartbeats **advance real calendar/tracker state** in the Drive, with
  dedup against the published log.
- "Launch a Peru campaign" produces a **multi-agent sequence** with gated spend steps.
- Hops **stream live** in the Console; conversations thread.
- Bell, add-division wizard, Memory page, and daily digest exist and are wired.
- Playwright e2e of the full Sonar loop passes; export includes Tethr data; the
  upstream-merge drill is documented; company delete works.
- All V1 invariants still hold (hard gates, offline demo, merge-safe core,
  screenshots refreshed, no push).
