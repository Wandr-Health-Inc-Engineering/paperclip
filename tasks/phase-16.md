# Phase 16 — Tethr as the growth operations control plane

## Why

Mark (COO), 2026-11-07: Tethr is unclear on what it wants to be. It needs a memory layer and
it needs to delegate properly. For now, its operational focus is **acquiring customers**:
go-to-market strategy and growth.

What we found (codebase map, 2026-11-07):

- **Three identities at once:** a chatbot (`@tethr.chat`), a marketing agency (Rank, Tank,
  Radar), and a simulated org (CEO, factory, divisions).
- **A parallel engine:** every request runs through Tethr's own one-shot route runs:
  @tethr → one agent → one subagent → one output. Multi-step "plans" are 2–4 sequential
  steps that only see earlier summaries. No agent can hand work to another or create
  sub-tasks.
- **Core delegation goes unused:** Paperclip core already has all of it, and Tethr bypasses
  it (the `tethr_llm` adapter ignores the woken task):
  - tasks (issues) with `parentId` and an assignee
  - `createChild` with `blockParentUntilDone`, a depth counter and a 25-child cap
  - assignment wakeups, and waking the parent's owner when its blockers finish
  - comments, goals and routines
- **Memory is thin:**
  - one keyword-matched table, and agents can't write to it
  - every run gets the 6 *newest* rows (recency, not relevance)
  - the Memory page is read-only

## Identity (the one-liner every surface should reflect)

**Tethr is Wandr's growth operations control plane.** Its job right now is acquiring
customers.

- Every recurring piece of growth work is a **workflow** with an owner, a cadence, a
  deliverable and a gate.
- **@tethr** is the front door. **@ceo** sets the weekly growth plan and delegates.
- Growth specialists do the work as **tasks**, and humans approve in the **Queue**.

Boundary unchanged: marketing and aggregate numbers only. **The patient-data wall stays.**

## The growth org (small on purpose)

| Agent | Job | Status |
|---|---|---|
| @tethr | front door: answers quick asks, turns real work into tasks | exists |
| @ceo | head of growth: weekly growth plan, delegates, writes roll-ups | exists, reframed |
| @rank | SEO / search demand: keyword briefs | exists |
| @tank | AI-search (GEO) visibility audits | exists |
| @radar | market, competitor and partner research | seed if missing |
| later, one at a time | @scout partnerships outreach · @ads paid acquisition (Google Ads read-only) · @pulse analytics (needs `POSTHOG_API_KEY`) | not now |

System agents (@tinkr, @patch, @filer) are unchanged.

## Growth workflows (seeded **paused** — Mark switches each on)

1. **Weekly growth plan** (Mon): @ceo reads last week's outputs and memory, picks the top 3
   priorities, and delegates them as tasks.
2. **SEO + AI-search content engine**: @rank keyword brief → @tank GEO audit of the target page
   → a writer-ready brief (publishing stays `public`-gated).
3. **Seasonal demand**: travel notices and the season calendar → @radar campaign briefs
   (spring break malaria, summer altitude…).
4. **Partnerships pipeline**: @radar researches partner targets (travel agencies, study abroad,
   corporate travel, clinics), then outreach drafts (`pr`-gated).
5. **Weekly growth review** (Fri): what shipped, what's waiting on Mark, spend vs caps.

## Delegation backbone (16a — this build)

Ride Paperclip's tasks instead of the parallel engine.

1. **Tethr agents work tasks.** When the `tethr_llm` adapter is woken with `context.issueId`:
   - Load the task: title, description, recent comments, finished child tasks.
   - Run that agent on it (`routeRequest`, `startAtAgentTag`, invocation `task`).
   - Post the result as a task comment that links the output.
   - Set the status: answer/published → `done`; gated → `in_review` (closes when the Queue
     decision lands); a failed run is left to core's recovery.
2. **Agents delegate.** A new `delegate_task` tool, granted to `@ceo.plan` and `@tethr.plan`:
   - It creates a child task assigned to an agent by tag, blocking the parent until done.
   - Core wakes the assignee. When all children finish, core wakes the parent's owner, who
     writes the roll-up.
   - **Limits:** depth ≤ 2 below the root, ≤ 6 children per task, only to known agent tags,
     never to the delegating agent itself. Budget caps and hard stops are unchanged.
3. **The Queue closes the loop.** Deciding an output that belongs to a task updates the task:
   - approve → `done`
   - reject → `cancelled`, with the reason as a comment
   - request changes → `todo` with the note, so the agent re-runs it
4. **Growth board.** A new Tethr page showing tasks by owner and status, what's blocked, what's
   waiting on Mark, and what was done this week.

**16b (after 16a is proven):** Console/Slack "projects" (multi-step asks) become a parent task
under @ceo, replacing the in-memory sequential plan. Quick asks still answer inline.

## Memory layer (Phase 17 — next)

- **Kinds:** fact · decision (what/why/who) · playbook (step-by-step how-to) · people &
  partners · lesson (from failures, via @patch) · work history.
- **Writing:**
  - agents get a `remember` tool; facts and decisions ask Mark first in the Queue
  - Mark can add, edit, pin and forget on the Memory page, or say "remember that…" in Slack
- **Recall by relevance:**
  - Postgres full-text search (no new infra)
  - pinned rules are always injected
  - scoped by company / agent / workflow
  - pgvector later, per ADR-0002's trigger
- **Fix:** revision runs and factory-born agents currently drop standing rules.

## Hermes (when Mark installs it)

- The fork already ships Paperclip's `hermes_local` adapter.
- Create `@hermes` as the "computer runner" for work that needs Mark's machine (browser
  research, files, spreadsheets). It works delegated tasks like any agent.
- It only runs while Mark's laptop and Tethr are up.
- Keep its toolsets tight. No patient data. An agent key can't approve its own gated items.
- **Later:** Hermes on Telegram/WhatsApp as Mark's personal front door to Tethr via the repo's
  MCP server. Tethr's memory stays the system of record.

## Gates

- No schedule turns on without Mark: every workflow ships paused.
- Delegation only spends on work a person started (a request, or a schedule Mark enabled).
  Depth and fan-out limits apply, and per-agent caps and hard stops are unchanged.
- The live-LLM spend gate is unchanged.

## Tests (16a)

- The adapter works a task: comment posted; done for published, `in_review` for gated.
- `delegate_task`: child created, parent blocked, limits enforced (depth, fan-out, unknown
  tag, self).
- Queue decision → task status: approve / reject / changes requested.
- The full Tethr suite stays green (run as a non-root user so the DB suites don't skip).

## Done when

- A request like "plan our spring-break malaria push" results in an @ceo task, delegated
  children for @rank and @tank, their outputs in the Queue or Drive, and an @ceo roll-up.
  All of it is visible on the growth board.
- Docs updated: CLAUDE.md (identity + delegation), DECISIONS.md (any core touch).
