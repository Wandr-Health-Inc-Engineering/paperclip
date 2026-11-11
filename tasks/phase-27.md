# Phase 27: fixes from Mark's first-run test on his phone (2026-11-10)

Mark reset tethr, ran the first run on his phone and sent 15 notes. Each is traced to its cause and fixed here.

| # | Note | What changed |
|---|---|---|
| 1 | "Finish setting up tethr" in the chat after onboarding | The goals interview is the last setup step and starting it finishes setup, so the pill is gone when you arrive from setup. |
| 2 | First load skipped onboarding | The first page of a window, on a company whose setup isn't done, goes to setup from any page. The app opens on Chat. |
| 3 | "tethr ONGOING" label | A round avatar, top centre: tethr's mark, still; it animates while a turn runs. An agent's chat shows that agent's icon. |
| 4 | Welcome too busy | One screen: the mark, "Hello.", one line, Begin setup. |
| 5 | Settings in onboarding; chat last | Steps: Your company, Focus and pace, Connections, Rhythm and ideas, On its own (new), Goals interview. |
| 6 | Buttons instead of text questions | The `ask` tool: a card with Approve / Reject / Comment, or 2-4 choices + Comment. |
| 7 | A second message showed a second progress bar | It waits in a "queued" tray above the composer, editable and removable. One pill. |
| 8 | Connections and approvals; agents wasting budget | An agent with a missing connection doesn't run until it's connected or you say to carry on without it; the card has the fix in place. Google Ads reports are readable from the chat. |
| 9 | Notifications bug on the phone | The detail card was drawn inside the top bar; it's drawn on the page now. |
| 10 | "No workspace" on an agent's run | Normal (a run with no task; nothing spent). tethr adds a line saying so and names the model. |
| 11 | Sidebar agents | Sub-agents nest under their lead and fold; icons follow the job. |
| 12 | Slack "just made a document, with old info" | The old engine had answered (the admin's Slack ID wasn't linked). While the chat engine is on, Slack never reaches the old engine. |
| 13 | Couldn't open an agent's details | The card opens in place to its whole spec. |
| 14 | Not clear what's required | "Needs you": one list, a pill in the chat, plain headings on every card. |
| 15 | What is the Queue tab | It's the Needs you page: questions, connections and approvals. |

## Where things live
- Setup: `server/src/tethr/setup.ts` (`SETUP_STEPS`), `routes/tethr-setup.ts` (`PUT /setup/autonomy`, `PUT /setup/admin-slack`, `POST /setup/slack-lookup`), `ui/src/pages/tethr/setup/` (`AutonomyStep.tsx`, `InterviewStep.tsx`, `FixPanel.tsx`, `Welcome.tsx`), `components/tethr/SetupNavItem.tsx` (`TethrFirstRunToSetup`).
- Chat: `chat/avatar.tsx`, `chat/queue.tsx`, `chat/decision-cards.tsx`, `chat/needs-you.tsx`; runner `editQueued` / `cancelQueued`; `PATCH|DELETE /chat-turns/:runId`.
- Questions: `assistant/questions.ts` (store `tethr-questions.json`), `assistant/person-tools.ts` (`ask`, `need_connection`), `POST /questions/:id/answer`.
- Connections: `connections.ts`, `team-needs.ts`, `team.ts` (`unmetNeeds`, `raiseNeed`, `settleNeed`, `releaseHeld`), `needs-you.ts` (`GET /needs-you`), `POST /team/recheck`.
- Icons and tree: `team-spec.ts iconFor`, `team.ts healTeamIcons`, `ui/src/lib/tethr-agent-tree.ts`, core `SidebarAgents.tsx`.
- Slack: `slack.ts routeInboundKickoff` (`classicOff`), `slack-chat.ts answerUnknownSlackSender`.

## Verified
On a throwaway instance with real Claude (deleted after), phone and desktop, dark and light: first load → setup; the welcome; the On its own step; the interview step → chat with no setup pill; two messages in a row (one pill, the tray, the queued one ran after); tethr used `ask` when told to and said "card's below"; choosing an option sent the answer; a proposed agent that needs Google Ads said so, showed it on its card's Details, and after approval waited with a connection card and 0 runs; the Needs you page with the fix open; the sidebar count; sub-agents nested with job icons; the chat's team list.

Not checked live: Slack (the unknown-sender reply, the link and "no old engine" are covered by tests with a fake Slack poster); a real Google Ads report (the keys aren't on the throwaway).
