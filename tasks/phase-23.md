# Phase 23: tethr runs a team (the Hermes + Paperclip hybrid)

## Context
Mark (2026-11-08): "I want the system to be a bit more autonomous… clear on spinning up agents and all that. This needs to not just be another Claude chat but really a new Hermes/paperclip hybrid."

Today the chat is one Claude session with connectors. The agent machinery (core agents, routines, tasks, budgets) only drives the old routing engine, and the specialists are archived.

The hybrid takes from each side:
- **From Hermes:** one persistent chat per named agent; routines set up in plain chat that report to whoever asked; delegation depth 1; Hermes's weak spot is proposing automations, so tethr should propose them.
- **From Paperclip:** agents are real employees: a core agent row, an owner, a budget, a schedule (routine), and tasks (issues) with an audit trail.

**Mark's answers (2026-11-08)**
- **New agents:** a setting, "Ask me" (an approval card) or "Automatic".
- **Delegating to existing agents:** no approval, within limits.
- **Reports:** go to the main chat, and also by Slack DM to the right person. Each agent reports to a Slack ID chosen from setup and relevance.
- **First team:** when it's built, tethr proposes a starting team of 2–3 agents.

## What exists to reuse
- **Agents and tasks:**
  - `factory.ts instantiateAgentFromSpec`: the pattern for the core agent row, profile, hard-stop budget policy and routine. The new team service follows it but doesn't call it, because it's tied to classic-engine tools and @ceo.
  - `tasks.ts`: `taskService.load/start/finish/setStatus`, `queueIssueAssignmentWakeup`.
  - `adapter.ts executeTask`.
- **Scheduled turns:** `rhythm.ts` `applyRhythm` (routine and trigger per cron and time zone) and `runTaskInOperationsChat`, with `waitForTurn` / `chatTaskResult` / `turnOutputs` (moved to `assistant/turns.ts` so agents share them).
- **Runner:** `assistant/runner.ts` `send()` (one turn per thread, throttle, budget, cost), the per-turn `--settings` deny rules (`integrations.ts denyRulesFor`), and the hook gate (`policy.ts decide`, `grants.ts createPendingAction`).
- **Tethr tools:** `assistant/tethr-tools.ts` `TETHR_TOOL_DEFS` / `runTethrTool`, with classes in `policy.ts` ("Tethr tools").
- **Cards and notes:**
  - `watch.ts deliverIdea`: the route-run card pattern (`sourceKey: "tethr-idea"`), next-turn notes (`chats.addNote`), bell notifications (`notify.ts`).
  - The Slack DM helpers `slack.ts dmOverseer` / `postSlackMessage`.
- **Owners:** `overseers.ts` (`inferOverseerRole`, roster tech/exec/growth with Slack IDs), `company.ts` members (the admin's Slack ID).
- **Ids and helpers:** `ids.ts stableThreadId`, `chats.addSideChat`, `best-effort.ts logFailure`, `time.ts`.

## 23.1 Team engine (server)
**The team agent (no migration).** Each team agent is:
- A core `agents` row: adapter `tethr_llm`, reports to @tethr.
- A `tethr_agent_profiles` row: tag, codename, title, mission, `overseerRole`, and an empty routing table.
- A hard-stop budget policy.
- `adapterConfig` holding `{ agentTag, engine: "session", instructions, connectors[], maxRunsPerDay, owner: { role | memberId } }`.

**The spec** (`team.ts validateTeamSpec`):

| Field | Rule |
|---|---|
| name, tag | tag `@lowercase`, unique, archived tags included |
| title, mission | — |
| instructions | ≤ 4,000 chars: the job, how to do it, what to deliver, where to file |
| connectors | a subset of the Integrations connectors |
| schedule | `{cron, brief}` or none |
| budget | default $15/mo, cap $50 |
| maxRunsPerDay | default 4, cap 12 |
| owner | role inferred by `inferOverseerRole` if not given |
| firstTask | optional |

**`teamService(db)`** in new `server/src/tethr/team.ts`:
- `list`, `get`, `create`, `update`, `pause`, `resume`, `assign`.
- Schedules are core routines assigned to the agent, in the setup time zone, with the trigger enabled while the agent is active. This is `applyRhythm`'s logic, generalized.

**One chat per agent.**
- Each agent's thread id is `stableThreadId("agent:"+tag, companyId)`, registered in `chats.ts` with `agentTag`.
- Mark can open it and talk to the agent directly.

**Running work** (`adapter.ts executeTask`):
- Agents with `engine: "session"` go to a new `team-run.ts runTaskInAgentChat`.
- It sends a system turn in the agent's thread. The turn carries the task, the agent's instructions, and the closing rule "end with `Slack summary:` one line, no customer names or health details".
- It waits up to 20 minutes, then finishes the task (done / failed / blocked at the daily cap), then reports back.

**Runner changes:**
- **Attribution:** `SendInput.agent` puts the agent on the run row, the budget check, the cost event and the activity actor.
- **Deny rules:** the per-turn deny rules block connectors outside the agent's list, the team tools, and the shell.
- **Gate:** the hook gate enforces the same rules (thread → agent), as defense in depth.
- **Approval cards** made in an agent's thread are attributed to that agent and DM its owner.
- **Concurrency:** 3 turns at once, with agent turns using at most 2, so the main chat stays responsive.

**Reporting back** (`team-report.ts deliverAgentReport`), after every task turn and approval follow-up in an agent's thread:
1. A main-chat card: a route run with `sourceKey: "tethr-agent-report"`, carrying the agent, task, summary and files.
2. A next-turn note: "[From Tethr, not the user] @x finished …".
3. A bell notification.
4. A Slack DM to the agent's owner: roster role → Slack ID, else the admin's Slack ID, else #tethr. It carries only the title and the agent's one-line Slack summary, plus a link. Never the write-up.

## 23.2 tethr's team tools and team settings
All are on the `tethr` MCP server. They're allowed in the main chat and side chats only; agent threads get 403 and a deny rule.

**`team_list`** (read): the roster with status, schedule (in words), owner, runs today against the cap, budget used, open tasks, last report.

**`create_agent`** (draft) follows the team setting **New agents: Ask me | Automatic**, stored in `integrations.ts` as `team: { newAgents, maxAgents 6, monthlyBudgetUsd 100 }`:
- **Ask (default):** a gated output of kind `team_agent` (sensitivity `org`). The card shows the full spec as plain text: the schedule in words, the budget, the run cap, the owner and the first task.
  - Approve → `gating.approveTeamAgent`: the agent is created **active** with its schedule on, the first task is assigned, and a note goes to the main chat.
- **Automatic:** creates the agent directly if it fits under the max agents and the team budget; anything over the limits falls back to a card. It's logged in the activity log, and a "tethr created @x" card plus a Slack DM go to the admin.

**`assign_task`** (draft, no approval):
- Creates a core issue assigned to the agent and wakes it.
- Limits: the agent is active, it has at most 3 open tasks, and it's under its daily run cap.
- Returns the task id.

**`update_agent`:**
- Pause takes effect immediately.
- Changes to instructions, schedule, connectors or owner follow the New agents setting.
- Budget increases always ask (Mark's standing rule).

**Policy classes:** `team_list` is read; `create_agent`, `assign_task` and `update_agent` are draft (internal to tethr). Unknown tools stay blocked.

**What tethr knows about its team**, written into the per-turn `CLAUDE.md` (company-level, same for every thread, so concurrent turns don't conflict):
- `## Your team`: the roster.
- `## Running the team`, a short playbook:
  - Spin up an agent for recurring or ongoing work, or a job that needs its own focus.
  - Assign one-off or parallel work to an agent that exists.
  - Never create a duplicate.
  - Say what you delegated and why.
  - Propose an agent when an ask repeats.

**Starting team:**
- `POST /tethr/:companyId/team/propose` sends a system turn in the main chat: "look at the goals, Memory.md and recent work; propose 2–3 agents with create_agent; explain each".
- Under Ask, it produces cards only.

## 23.3 UI
- **Chat drawer:**
  - Order: the pinned main chat, then **Team**, then side chats.
  - Each Team row shows name, title and a status dot: live running · ok idle · hollow paused · warn needs you.
  - A row opens the agent's chat.
  - Empty state: "No agents yet" and **Propose a starting team**.
- **An agent's chat:**
  - The chip shows "@x · title" and opens a small panel: schedule in words, owner, runs today, budget, Pause/Resume.
  - Composer placeholder: "Message @x…".
  - Task turns show as a system line "Task WD-12: …".
- **Main chat:**
  - `AgentReportCard` (like `IdeaCard`): the agent, the task, the summary (clamped, with "Show all"), file chips, and "Open @x's chat".
  - The approval card for kind `team_agent` uses the label "New agent".
- **Integrations page:** a "Team" card with New agents Ask/Automatic, max agents and the team monthly budget.
- **Company page:** a "Team" section listing the session agents.
- Brand: Smoked Glass; check light, dark and phone.

## Safety
- Agents can't create agents or assign tasks (depth 1).
- Each agent's connector allowlist is enforced twice: by the per-turn deny rules and by the hook.
- Agents never get the shell.
- Every outward action follows the Integrations modes. Money, public, medical and destructive actions always ask, and the card goes to the agent's owner.
- Limits: the daily run cap, the budget hard stop and the usage throttle apply to agents too.
- Slack carries only a heads-up and the agent's one-line summary.
- Never PHI.
- **DECISIONS.md:** Mark's "Automatic" setting is his explicit go for tethr to start agents' schedules. It replaces "enabling any heartbeat needs a go" for team agents only while the setting is on.

## Tests
**`tethr-team.test.ts`** (embedded PG, fake execute and Slack poster) covers:
- spec validation, and duplicate or archived tags
- Ask: card → approve → agent active, routine enabled, first task assigned, note in the main chat
- Automatic: within limits, and fallback to a card
- `assign_task` → core wake → adapter → `runTaskInAgentChat` → task done → report card, note, bell, and Slack DM to the owner's ID
- the daily cap
- pause and resume
- an agent thread blocked from team tools (endpoint and deny rule)
- a connector outside the allowlist denied
- a budget increase always asks

**Also:**
- Policy tests for the new classes.
- UI tests for the report and team helpers.
- The full Tethr suite and UI suite stay green.

## Verification
1. **On a throwaway instance with real Claude** (`PAPERCLIP_INSTANCE_ID=tethr-verify`, the runner-less start command, port 3210):
   - "Spin up an agent that checks competitor travel-health pricing every Monday" → card → approve → the agent shows in the drawer with its routine on.
   - "Have it do a quick check now" → its chat works the task → a report card in the main chat, plus the bell (Slack logged, no token).
   - Automatic mode creates directly.
   - Pause stops the schedule.
   - Check light, dark and phone.
2. **On Mark's instance:**
   - The server restart picks up the code.
   - I start the starting-team proposal in his main chat (approval cards only; nothing runs until he approves).
3. Update `CLAUDE.md`, `DECISIONS.md`, `tasks/phase-23.md` and `MANUAL-STEPS` (owners' Slack IDs in Settings → overseers).
4. Commit locally per sub-phase. Never push.
