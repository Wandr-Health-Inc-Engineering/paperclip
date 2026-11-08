# Tethr onboarding: start from scratch, with real goals

## Context
tethr works (chat on a real Claude session, approvals, Jev scoring, attachments, Environment
page), but it has **no goals**. Today the company's aim lives as one vague line in five places:
- `companies.description`
- one bullet in Memory.md
- the persona's job line
- the paused growth playbooks
- some July briefs

None of these has a number, a baseline, a target or a date. Core's `goals` table is empty for
Wandr, and the Growth board only counts tasks. Mark wants it set up **properly from scratch** so
everything tethr does pushes toward Wandr's goals.

**Mark's decisions (2026-11-07)**
- **Wipe completely.** Delete the old tethr history: chats, the 76 outputs, the memory log, the 8
  paused routines, the 9 archived specialists, and the two archived companies (Wandr Growth, Wandr
  Health). The specialists' seed code stays in the repo.
- **Drive.** The old files in the shared `00 Tethr` folder move to `99 Archive` (the team keeps
  access); nothing is deleted from Drive.
- **Format.** A setup page in the app for settings, plus tethr **interviewing** Mark in chat for
  goals, pulling real baselines from Stripe, PostHog and Google Ads.
- **First goals:** New customers, Revenue, Partnerships & distribution.
- **Team:** just Mark for now.
- **Working rhythm** (Monday plan, Friday scorecard, daily brief, Slack posts): **chosen by Mark
  during onboarding**. Nothing is on by default.

**What exists to reuse**
- Core goals: `packages/db/src/schema/goals.ts`, with levels company/team/agent/task, a status, a
  parent tree and an owner agent. Service `server/src/services/goals.ts` (`getDefaultCompanyGoal`);
  routes `routes/goals.ts`; UI `/goals`. **There are no metric or target columns.**
- Core routines: schedule triggers → `dispatchRoutineRun` creates an issue → wakes the assignee.
- Tethr's task path: `server/src/tethr/adapter.ts` `executeTask` → `tasks.ts`.
- Chat runner: `assistant/runner.ts` `send`.
- Tethr tools MCP bridge: `assistant/tethr-tools.ts`, `tools-bridge.ts`, plus the gate in
  `policy.ts`.
- Workspace CLAUDE.md, rewritten each turn: `assistant/workspace.ts` `ensureWorkspace`,
  `integrations.ts` `integrationRulesText`.
- Company wipe: `companyService(db).remove()` already deletes Tethr tables in the right order.
- Backup: `runDatabaseBackup` (`packages/db/src/backup-lib.ts`), as used in `server/src/index.ts`.

## Phase 20.1: Goals with numbers (the measurable layer)
- **Migration 0095, `tethr_goal_metrics`.** Columns:
  - Links: `companyId` and `goalId`, both FK with cascade.
  - Definition: `name`, `unit` (count/usd/percent/number), `direction` (up/down), `source`
    (stripe/posthog/google_ads/manual/other), and `method` (plain-language "how to measure",
    recorded during the interview so every scorecard measures the same way).
  - Numbers: `baseline` + `baselineAt`, `target` + `targetDate`, `current` + `currentAt`.
  - `history` jsonb of `{at, value, note}`, capped at 104 entries.
  - Goals themselves stay in core `goals`: one company goal (the mission) and one team goal per
    area, parented to it.
- **`server/src/tethr/goals.ts`.** `listGoals` (tree + metrics), `upsertGoal`, `upsertMetric`,
  `recordMeasurement`, and `goalsContextText()`, which gives a short "Wandr's goals" block (each
  goal with metric baseline → current → target by date).
- **Every chat turn knows the goals.** `ensureWorkspace` writes the goals block into the generated
  CLAUDE.md next to the integration rules (same per-turn mechanism). The rules gain: "Tie work to a
  goal; say which goal a suggestion moves."
- **New tethr tools** on the existing `tethr` MCP server:
  - `goals_list` (class read)
  - `save_goal`, `save_metric`, `record_metric` (class **draft**: internal to Tethr, so allowed
    unless Tethr tools is Off or Read; never outward)
  - Rules: aggregates only, never a customer's name, email or health detail. Policy rows go in
    `CONNECTOR_RULES["Tethr tools"]`.
- **REST (people only):**
  - `GET /tethr/:companyId/goals`
  - `PATCH /goals/metrics/:id` (edit target, date or method)
  - `POST /goals/metrics/:id/measurements` (manual value)
- **Scorecard on the Growth board** (`TethrGrowth.tsx`, top section). Load the `dataviz` skill when
  building it. One card per goal; each metric shows current vs target, progress, a small trend
  line from `history`, and "measured {when} from {source}". Buttons: "Measure now" (see 20.3) and
  "Edit" (inline). The existing lanes stay below.

## Phase 20.2: Setup page + goals interview
- **State.** `server/src/tethr/setup.ts`: an instance-dir `tethr-setup.json` per company (the
  same pattern as integrations), holding step status, chosen goal areas, rhythm choices and
  `completedAt`. `GET|PUT /tethr/:companyId/setup` (instance admin / person).
- **Page.** `ui/src/pages/tethr/TethrSetup.tsx` at `/setup`, in the Smoked Glass style. Until setup
  is done, a "Set up tethr" item sits at the top of the sidebar and the Chat shows a one-line
  banner linking to it. Steps:
  1. **Basics.** Mission (one line), goal areas (preselected: New customers, Revenue,
     Partnerships & distribution), inside-Wandr domains, time zone. Save creates the company goal
     plus one team goal per area.
  2. **Connect.** A live checklist that reuses existing status:
     - Stripe, PostHog, Google Ads, Gmail, Slack, Drive and Calendar connector modes (data
       sources set to at least Read).
     - Jev key, Slack bot token present (links to the Environment page).
     - Mark's Slack member ID for approvals (overseer roster).
     - The 00 Tethr Drive folder found.
  3. **Goals interview.** "Start the interview" opens a side chat, **Onboarding**, seeded with an
     interview brief (a system turn). For each chosen area tethr:
     - asks where things stand;
     - pulls a baseline from the connectors (aggregate counts and revenue for the last 90 days);
     - proposes 1–3 metrics with a target and date, and confirms with Mark;
     - saves them with `save_goal`/`save_metric`, recording the exact measuring method;
     - writes the business facts (products and prices, who buys, channels, voice, constraints)
       into Memory.md.

     The setup page shows goals filling in live, polling `GET /goals`. The step is done when every
     area has a metric with a baseline and a target.
  4. **Rhythm.** Mark picks Monday plan, Friday scorecard, daily morning brief, and whether each
     one also posts to Slack #tethr, with day and time for each. Saving creates or updates core
     routines assigned to @tethr (playbook text = the routine description, timezone-aware trigger).
     Unchosen ones aren't created.
  5. **Finish.** A summary (goals, connections, rhythm), "Run the first scorecard now", then
     setup is marked complete.
- **Registration.** App route, sidebar item, palette entry and `BOARD_ROUTE_ROOTS`: one line each,
  logged in DECISIONS.md.

## Phase 20.3: The rhythm runs on the chat engine (not the archived agents)
- In `adapter.ts` `executeTask`, when the task came from a routine, the agent is @tethr and the
  chat engine is `session`, hand the task to the runner instead of the old routing engine.
- **Where it runs.** A fixed **Operations** side chat per company (a stable UUID derived from the
  company id, listed via `chats.addSideChat`), as a system turn carrying the routine's playbook.
- **Waiting.** New `runner.sendAndWait` polls the turn row until it's terminal, with a 15-minute
  cap. The result is commented on the issue, and the issue moves to done or failed via `tasks.ts`
  (adapting the turn result to `tasks.finish`).
- **Playbooks** (in `server/src/tethr/seed/rhythm.ts`, all goal-driven):
  - **Monday plan:** read the goals and last week's numbers, propose 3–5 moves, each tied to a
    goal, write `files/plans/<date> plan.md`.
  - **Friday scorecard:** measure every metric by its saved method, `record_metric`, write
    `files/scorecards/<date>.md`, call out what's off-track.
  - **Daily brief:** what changed, what's waiting in the Queue, today's focus.
  - Slack posting uses the existing notifier, only when Mark chose it.
- "Measure now" on the scorecard runs the scorecard routine once (core `runRoutine`).
- Throttle and budget checks still apply (the runner already checks both).

## Phase 20.0: The wipe (runs last, after 20.1–20.3 are built and verified)
`server/src/tethr/reset.ts` plus the CLI `server/src/tethr/reset-cli.ts`, run with
`npx tsx … --confirm WIPE`. In order:
1. **Print exactly what will go.** Companies WD, WG and WAN with their agents, issues, routines,
   outputs, runs and memory-log counts.
2. **Back up the database** with `runDatabaseBackup` (prefix `pre-tethr-reset`, in the normal
   backup folder, kept 7 days) and print the path.
3. **Delete the companies.** `companyService.remove()` for all three companies.
4. **Clear the instance JSON files** for those company ids: `tethr-integrations.json`,
   `tethr-chats.json`, `tethr-overseers.json`, `tethr-paused.json`, `tethr-archive.json`,
   `tethr-drive-mounts.json`. The `.env` keys are kept.
5. **Archive the Drive files.** Move `01 Briefs`, `02 Documents`, `05 Ads & Analytics`,
   `07 Debug`, the old `00 …` guide files and `tethr/files` + `tethr/Memory.md` into
   `00 Tethr/99 Archive/2026-11 before fresh start/`, keeping their structure. The Command Center
   launcher stays.
6. **Delete the old chat sessions' Claude transcripts** for the workspace folder
   (`~/.claude/projects/<workspace path>/`). They hold old chat content.
7. **Restart.** `maybeAutoSeed` creates a fresh "Wandr" with only @tethr. Memory.md and CLAUDE.md
   are regenerated clean.

After the wipe, Mark opens `/setup` and onboards.

## Not in scope
- Re-adding specialists (later, one at a time, as rows tied to a goal).
- Multi-user onboarding.
- Texting.
- Slack DMs into the chat (phase 6).
- Pushing to GitHub.

## Tests
- **`tethr-goals.test.ts`** (embedded PG):
  - metric CRUD, the history cap, cascade on goal/company delete
  - `goalsContextText`
  - the new tools via `runTethrTool`
  - policy (read/draft, Off denies)
  - routes are people-only
- **`tethr-setup.test.ts`:**
  - setup state
  - rhythm choices create, update and disable core routines + triggers with the timezone
  - a routine task for @tethr goes to the Operations thread with a fake runner and closes the
    issue
- **`tethr-reset.test.ts`:** seed data plus goals and metrics in temp dirs, run reset with a fake
  backup, then check:
  - the companies are gone
  - the JSON entries are cleared
  - the Drive files moved, not deleted
  - a fresh seed works
- The full Tethr suite and UI tests stay green.

## Verification (end to end)
1. Build 20.1–20.3 on the current data:
   - Setup page steps 1, 2 and 4 in the browser (dark, light, phone).
   - The scorecard renders.
   - "Measure now" runs a session turn in Operations.
   - A test metric records.
2. **Wipe.** Show Mark the printed list. Run it (his approval of this plan is the go-ahead, since
   it lists everything). Restart, then confirm only Wandr + @tethr exist and that the Drive moves
   landed in `99 Archive`.
3. **Smoke-test the fresh company.** `/setup` loads; step 1 creates the goals; starting the
   interview gets tethr's first question and a baseline read from Stripe. **Mark answers the
   interview himself**: the goals must be his, so I won't fill them in.
4. Update CLAUDE.md, MANUAL-STEPS and `tasks/phase-20.md`. Commit locally per phase; never push.
