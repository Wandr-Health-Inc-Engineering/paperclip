# Phase 24: tethr is the brain (autonomous delegation, sub-teams, goals)

## Context
Mark (2026-11-08, after phase 23):
> "tethr should be the main brain and it can decide to delegate and create agents. I can approve them when it comes up as a suggestion and a goal just like other artifacts. For example if it's saying paid ads might be good I want it to build an agent that will handle this task and report back. It can even create schedules, sub-agents (like one just for keywords, one to look for strategies, etc). This way it is a truly autonomous assistant and helper. I don't need another chat. If it needs a permission it can buzz me."

**What phase 23 gave us:**
- tethr can create agents (as cards, or Automatic), assign them tasks, and get reports back.

**What's missing:**
1. tethr only acts when Mark writes or a rhythm item fires. It doesn't react to reports or think on its own.
2. A suggestion ("paid ads might be good") stays advice. It should become an agent proposal tied to a goal.
3. Agents can't build sub-teams (depth 1). Mark wants leads with sub-agents (keywords, strategy).
4. Approval cards don't buzz him on Slack. His overseer list is empty and the gate's Slack DM has no fallback. Only agent reports fall back to his Slack ID from setup.

**Reading "I don't need another chat":** tethr's own thinking (check-ins, a daily review) happens in the main chat, the one place he looks. Agents keep their own chats, but he never has to open them.

**Mark's correction on the first draft (2026-11-09):**
> "The previous work added agents I didn't want. I want everything to be done inside tethr. We're just building the framework for this system."

The three proposal cards in his chat (Ads Health Watch, Metrics Reporter, Partner Scout) came from me running "Propose a starting team" on his instance. No agents were created; the cards are still waiting. So:
- **This phase builds the framework only.** tethr decides, inside tethr, when it's used. I don't create, propose or run anything on Mark's instance.
- **The new autonomy ships switched off** (check-ins and daily review). Mark turns it on from Integrations → Team when he wants it.
- **Verification happens only on a throwaway copy.**

## 24.0 Undo what I added
- **Withdraw the three pending `team_agent` cards** on Mark's instance (ids `22f9fa98…`, `cdc5d689…`, `ddc7d70b…`):
  - Status becomes `rejected`, with `meta.withdrawn = "proposed during the build, not asked for"`, logged as a system action (not as Mark's decision).
  - They leave the Queue and the chat cards stop offering Approve.
  - A note goes to tethr's main chat ("Those three agent proposals were withdrawn; the person didn't ask for them. Don't propose agents unless asked or unless your autonomy settings allow it."), so its session doesn't think they're pending.
- **The chat history stays as it is.** Mark can say if he wants that turn removed too.
- **The "Propose a starting team" button in the drawer** only runs when he clicks it. It stays, and its label makes clear it asks tethr for proposals.

## 24.1 Suggestions become agents, tied to goals
- **`create_agent` gains a goal:**
  - `goal_id`: an existing goal it moves, or
  - `new_goal`: `{ title, description?, metric?: { name, unit, source, method, target, target_date, baseline? } }`.
- **The card** shows "Moves: Revenue", or "New goal: Paid acquisition (CPA under $40 by Mar 31), saved when you approve". The goal is created on approval (or right away under Automatic) through `goalsService.saveGoal` / `saveMetric`. The agent stores `goalId`.
- **The goal shows up** in the agent's identity, the roster, its chip and its reports, so it's measured like any goal. With Tethr tools granted, the agent can `record_metric` on it.
- **"Running the team" in CLAUDE.md is rewritten as the brain's playbook.** When tethr recommends an ongoing effort (a channel like paid ads, a campaign, a recurring check), it doesn't stop at advice:
  - It proposes an agent to own it, with a goal and a schedule when the work repeats.
  - For a bigger effort it proposes a lead (`lead: true`) whose first task is to build a small sub-team.
  - The `create_agent` description carries the paid-ads example.

## 24.2 Leads and sub-agents (depth 2)
- **Spec gains `lead: boolean`** (default false).
  - A lead gets scoped team tools in its own chat: `team_list` (itself and its sub-team), `create_agent` (a sub-agent under it), `assign_task` (its sub-agents only), and `update_agent` (its sub-agents only).
  - Sub-agents can't be leads and get no team tools.
  - At most 4 sub-agents per lead.
  - A sub-agent's connectors must be a subset of its lead's.
  - Sub-agents count toward the team limits.
- **Approval:** sub-agents follow the same New agents setting (a card that buzzes Mark, or Automatic). Raising budget or runs always asks.
- **Storage:** a sub-agent's `adapterConfig.leadTag` names its lead, and its core `reportsTo` is the lead.
- **Sub-tasks are core child issues** (Paperclip-native, the phase 16a backbone):
  - When a lead calls `assign_task` during its task turn, the task becomes a child of the lead's current task. team-run keeps the turn's issue id: a runId → issueId map read by the tools endpoint.
  - The lead's task then waits in `blocked` with no report yet.
  - When the last child closes, `tasks.setStatus` wakes the lead (`issue_children_completed`). team-run runs a roll-up turn in the lead's chat with each child's title, owner and result, then the lead writes the report.
  - The task closes and the report goes to tethr.
- **Sub-agents report to their lead:** a card and a note in the lead's chat. No main-chat card and no Slack.

## 24.3 tethr acts on its own (`team-brain.ts`)
- **Settings:** Integrations → Team gains Autonomy, `team.autonomy = { actOnReports, dailyReview: { enabled, time, weekdaysOnly }, maxSelfTurnsPerDay }`.
  - Defaults: everything **off** (framework only, per Mark's correction).
  - When turned on: 8:30 on weekdays and 8 turns a day are the suggested values.
  - Switching any of them on is Mark's go.
- **Acting on reports:**
  - When a report reaches the main chat, the brain marks the company "reports pending".
  - Three quiet minutes later it runs one check-in: a system turn in the main chat, "Check-in: reports from @a, @b". The reports are already notes for that turn.
  - tethr decides the next steps: assign follow-ups, adjust or pause an agent, propose an agent or sub-team, or flag what needs Mark. It tells him in a few lines.
- **Daily review:** at the set time in the setup time zone, once a day.
  - tethr checks goals against pace (`goals_list`), the team (`team_list`) and recent reports.
  - It decides the day's moves: assign tasks, adjust agents, propose new ones for any effort without an owner.
  - It posts a short list in the main chat: what it did, and what needs Mark.
- **Bounded:**
  - At most `maxSelfTurnsPerDay` self-started turns.
  - Never while agents are paused (the usage throttle).
  - A state file, `tethr-brain.json` (atomic), keeps pending reports, the last review day and today's count.
  - A one-minute tick, `startBrain` in `boot.ts`, never under tests. The logic is `brain.tick(now)`, so it can be tested.

## 24.4 Buzz Mark for permissions
- **Fallback:** `resolveOverseer` / `dmOverseer` (`slack.ts`) fall back to the company admin's Slack ID (`companyProfileService.adminSlackIds`, set in setup) when the roster has none. Today his approval cards don't reach Slack at all.
- **The approval DM** says who's asking, what for, and links to the card (`PAPERCLIP_PUBLIC_URL`).
  - That covers new agents, sub-agents, changes, and outward actions from tethr or any agent.
  - Agent cards go to the agent's owner (fallback: the admin).
- The bell is unchanged; every card already rings it.

## 24.5 UI
- **Drawer Team section:** sub-agents indented under their lead; the lead's row says "lead · 2 on its team".
- **Agent chip panel:** its goal, its lead or its sub-team.
- **Main chat:** check-ins and the daily review show as system lines ("Check-in: 2 reports", "Daily review") with tethr's answer.
- **Lead's chat:** sub-agent report cards use the same `AgentReportCard`.
- **Integrations Team card:**
  - Autonomy rows, all Off by default: Act on reports (Off/On), Daily review (Off / 7:30 / 8:30 / 9:30, weekdays), Self-started turns a day (4 / 8 / 12).
  - Max agents default goes to 9 (sub-agents count).
- **API:** `GET /team` adds `lead`, `leadTag`, `goal`, `subTeam`.

## Files
- **Server:**
  - `server/src/tethr/team.ts` (lead/sub, goal, scoped lists, child tasks)
  - `team-spec.ts` (`lead`, goal, subset rule, deny rules for leads)
  - `team-run.ts` (issue map, blocked-on-children, roll-up turn)
  - `team-report.ts` (route to the lead or the main chat, then the brain)
  - new `team-brain.ts`
  - `assistant/team-tools.ts` (caller scoping, goal args)
  - `assistant/hook-handler.ts`, `assistant/runner.ts`, `routes/tethr.ts` tools endpoint (leads may use team tools)
  - `slack.ts` (admin fallback, link)
  - `integrations.ts` (autonomy settings)
  - `routes/tethr-team.ts`
  - `boot.ts`
- **UI:**
  - `ui/src/pages/tethr/chat/team.tsx`
  - `TethrChat.tsx`
  - `TethrSettings.tsx`
  - `ui/src/api/tethr.ts`
  - `ui/src/lib/tethr-team.ts`
- **Docs:** CLAUDE.md, DECISIONS.md (autonomy defaults = Mark's go; depth 2), `tasks/phase-24.md`.
- **Process:** build in a git worktree and merge once (one restart of Mark's tethr), like phase 23.

## Safety
- **Limits:**
  - Depth 2.
  - ≤ 4 sub-agents per lead.
  - Sub-agents' tools are a subset of their lead's.
  - Team limits (count and budget).
  - Per-agent run caps.
  - The self-turn cap.
  - The usage throttle stops everything.
- **Gates:**
  - Every new agent or change follows the New agents setting.
  - Budget or run raises always ask.
  - Outward actions follow the Integrations modes and buzz the owner.
- **Slack** only ever gets headlines, one-line summaries and links.
- **Never PHI.**

## Tests (embedded PG, fake execute and Slack poster)
- **24.1 goals:**
  - a new goal is saved on approval and linked
  - `goal_id` is validated
  - the card text shows the goal
- **24.2 sub-teams:**
  - a lead creates a sub-agent (card → approve → `leadTag`, `reportsTo` the lead)
  - a member gets refused
  - the subset rule
  - a lead's `assign_task` in its task turn makes a child issue, and the lead's task goes `blocked`
  - when the child is done, the lead is woken and its roll-up turn closes the parent and reports to the main chat
  - a sub-agent's report lands in the lead's chat, not the main chat, with no Slack
- **24.3 brain:**
  - a report → debounce → one check-in turn in the main chat
  - Act on reports off → nothing
  - the daily cap
  - the daily review fires once after its time in the time zone
  - nothing runs while paused
- **24.4 buzz:** `dmOverseer` falls back to the admin's Slack ID; the DM has the link.
- **Overall:** the full tethr server suite and the UI suite stay green.

## Verification
1. **Throwaway instance, built from the worktree, with real Claude:**
   - Tell tethr "paid ads might be worth trying for us".
   - Expect a lead proposal with a new goal as a card → approve.
   - Its first task builds a sub-team (keywords, strategy): cards → approve.
   - It assigns them work; the sub-agents report to the lead.
   - The lead rolls up and reports to the main chat.
   - A check-in turn follows in the main chat.
   - Check the drawer hierarchy, the chip panel and the settings; light, dark and phone.
2. **On Mark's instance:** only the 24.0 cleanup and the merge (one restart). Nothing is proposed, created or run there.
   - Read-only check after the merge: the team is still empty and the three cards are withdrawn.
   - His approval DMs will go to his Slack ID (setup step 1) from the next real card on.
3. **Commits:** local per sub-phase. Never push.
