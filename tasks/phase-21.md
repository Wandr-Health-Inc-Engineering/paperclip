# Phase 21: tethr as a product, a team, and a partner that watches

## Context
Mark's notes after the onboarding walkthrough:
- **Product:** tethr is internal today but will be sold as its own product, so onboarding starts with the company: its name, your position, the main admin account, and "invite members (coming soon)".
- **Mission is built in, not typed.** tethr exists to tether a small team together and give every member a real AI partner to go to market: real work, not fluff. Each person's position shapes how tethr helps them (a CTO fixes tech so clients get a better experience).
- **Goals:** realistic, and tethr adjusts them in the background, faster or slower, within a pace chosen at onboarding.
- **Pace:** tethr adapts to how people respond, so it never overwhelms them into abandoning the work.
- **The main thing:** tethr watches. If Mark and Alec are talking about something, tethr suggests an idea, in Slack and as a notification in tethr's main chat.
- **Fresh launch:** Mark launches tethr fresh from the desktop icon to test.

**Decisions from Mark (2026-11-08)**
- Admin: a profile now (name, email, position); real logins come when tethr is hosted.
- Ideas go to Slack and show as a notification in tethr's main chat (and the bell).
- Goal targets adjust autonomously; the pace for that is set during onboarding.
- Ideas adapt to how he responds (Recommended option).

**What exists to reuse**
- Setup page: `ui/src/pages/tethr/TethrSetup.tsx` and `server/src/tethr/setup.ts`.
- Goals: `goals.ts`, `tethr_goal_metrics`, the scorecard.
- Rhythm: `rhythm.ts`, which already runs turns in an Operations chat.
- Chat runner: `assistant/runner.ts` `send()`. Throttle, budget and the approval gate all apply automatically.
- Next-turn notes: `chats.addNote` / `takeNotes`, already shown as "Notes from Tethr".
- Bell notifications: `notify.ts` `notificationService`.
- Slack: Socket Mode in `slack.ts`. `message.channels` is already subscribed; `interpretSlackEvent` currently drops channel chatter that has no mention. `postSlackMessage` can reply in a thread; `dmOverseer` handles DMs.
- Atomic stores: `atomic.ts`.
- Separate instances via `PAPERCLIP_INSTANCE_ID`.

## 21.1 Company onboarding, the team, and the built-in mission
- **Migration 0096, `tethr_members`.** Columns: company, name, email, position, role (admin/member), status (active/invited), `user_id` (null until logins exist), `slack_user_id`. One admin is created in onboarding (Mark). Invites show as "coming soon".
- **Positions (`positions.ts`).** A preset list, each with a one-line focus tethr works through:
  - Founder/CEO: priorities, revenue, big bets
  - COO/Operations: running the business and follow-through
  - CTO/Engineering: tech fixes that give clients a better experience
  - Growth/Marketing: getting and keeping customers
  - Sales/Partnerships: pipeline and partners
  - Product: what to build next from customer feedback
  - Other (free text)
- **Built-in mission (`mission.ts`).** Fixed text: tethr keeps a small team tethered and gives every member a real AI partner to take the business to market, with real work toward real numbers so the team can stay small and still grow.
  - The setup page shows it read-only, under "What tethr is for".
  - The root company goal is created and kept in sync automatically ("<Company>: grow with a small team"). Nobody types a mission.
- **No more hard-coded "Wandr" or "Mark" in the chat engine** (needed to sell it):
  - The persona becomes company-neutral and stays static (a changed persona forces fresh sessions).
  - Company specifics go into the per-turn CLAUDE.md: `## The company` (name, what it sells, the mission), `## Your team` (members with positions and focus, "help each person through their position"), then `## <Company>'s goals`.
  - The rhythm playbooks, the interview brief, the tool descriptions and the approval-gate wording use the company and admin names from the profile. Tests are updated.
  - Wandr's own facts stay in Memory.md and the profile.
- **Slack approver:** the admin's Slack member ID (entered in onboarding) also counts as an approver in `resolveSlackApprover`.

## 21.2 Realistic goals that adjust themselves
- **Growth pace, chosen in onboarding:** Steady / Balanced (default) / Ambitious, plus "Let tethr adjust targets" (on by default).
- **Interview brief:** targets come from the starting point and its recent trend, projected to the date, plus the pace's uplift (Steady about +5%, Balanced +15%, Ambitious +30%). tethr shows the math.
  - The first targets are still agreed in the conversation (Mark liked that step).
- **Background adjustment (`goal-pace.ts`, pure, with tests).** After each recorded measurement:
  - With 3 or more points, fit the trend (the last up to 8 points), project it to the target date, and apply the pace uplift to get a "realistic" target.
  - If the target is more than 15% off realistic, and the last 2 measurements are on the same side of the expected-pace line, move it halfway toward realistic.
  - Limits: at most ±25% per change, at most once every 14 days per metric, never below the starting point (above it for lower-is-better metrics). The date stays put.
  - Each change is recorded in a new `adjustments` jsonb column (when, from, to, why), the activity log and a bell notification ("tethr eased New customers to 160: the trend points to about 150 by Mar 31"). The scorecard tile shows "adjusted from 200".

## 21.3 tethr watches and suggests (`watch.ts`)
**Sources**
1. **Slack conversations.**
   - Every human message in a channel, thread or group DM the bot is in (not DMs to the bot, which stay requests) goes to `hear()`. It keeps the last 30 messages per conversation for at most 2 hours, **in memory only, never stored**.
   - A conversation counts as settled after 4 quiet minutes, with at least 3 messages and enough substance (it skips greetings and short back-and-forth).
2. **Goals.** A metric behind pace for 2 measurements in a row, or a target hit.
3. **Quiet.** No word from the admin for N days (shorter at a busier pace).

**When a trigger fires**
- **Checks before running:** pace allowance, quiet hours, cooldowns (6 hours per conversation, 2 hours per channel), listening on, agents not paused.
- **The Ideas turn:** a system turn in a dedicated **Ideas** side chat via the runner, so it has the goals, team, memory and connectors, and the gate still stops any action.
- **The prompt:** the conversation excerpt with speaker names (from the members and roster, else "a teammate"), plus "one concrete idea that moves a goal, 2 to 4 sentences, name the goal; otherwise reply exactly NO_IDEA; don't do or send anything."

**Delivering an idea**
- **Slack:**
  - A conversation idea is a threaded reply in that conversation ("Idea from tethr: …"), so the same people see it.
  - Goal and quiet ideas go to the admin as a DM, or to #tethr if there's no member ID.
- **Main chat:** a note card ("Idea from tethr · from #channel"), with **Useful** and **Not now** buttons. The idea also goes to the main chat's next turn as a "Note from Tethr", so the chat knows what it suggested.
- **Bell:** a notification for each idea.
- **Stored:** migration 0096 `tethr_ideas` keeps the idea text and its outcome (not the conversation).
- **The watch loop:** checks once a minute (timer unref'd), started in `boot.ts` next to Slack Socket Mode. It never runs under tests.

## 21.4 Pace that adapts (`pace.ts`, pure, with tests)
- **Starting level, set in onboarding:** Light (about 3 a week), Normal (about 1 a day, the default), Busy (about 3 a day); adaptive on.
- **Outcomes per idea:**
  - Useful (button) or answered (a human reply in that Slack thread, or the admin chatting within 2 hours) → the allowance goes up ×1.25.
  - Not now → ×0.7.
  - No signal in 24 hours → ignored, ×0.8. Two ignored in a row also double that conversation's cooldown.
  - The allowance stays inside the level's range, never off entirely.
- **Quiet hours:** 8am to 7pm in the setup time zone, weekdays; Busy also runs weekends. Ideas outside those hours are dropped, not queued.
- **Store:** `tethr-pace.json` (atomic, serialized). Settings and a "this week" summary show on the setup page.

## 21.5 Setup page (six steps)
1. **Your company:**
   - Company name (renames the company; the WD prefix stays) and what it sells.
   - You: name, email, position (preset or other), Slack member ID.
   - "Invite teammates: coming soon" (disabled).
   - Time zone, inside-the-company email domains.
   - Read-only "What tethr is for".
2. **Focus and pace:** goal areas (preselected), growth pace, auto-adjust.
3. **Connections:** as today, plus "Listening in Slack": whether the bot is in channels, and whether private channels and group DMs are allowed.
4. **Goals interview:** realistic, pace-aware targets.
5. **Rhythm and ideas:** the rhythm items, the ideas level, and "Listen in Slack" (on).
6. **Finish.**

The mission text field is gone. The scorecard header shows the company name and what it sells.

## Safety
- Never PHI:
  - Slack text stays in memory for at most 2 hours.
  - Only the idea text is stored.
  - Conversation ideas reply only into the same thread.
- tethr hears only where the bot is invited. Slack never shows a bot your 1:1 DMs with Alec; talk in a channel or a group DM that includes tethr.
- Cost is bounded: at most one turn per settled conversation, plus cooldowns, the pace allowance and quiet hours. The usage throttle and budgets apply. "Listen in Slack" and agent pause are the off switches.

## Manual steps (MANUAL-STEPS)
In the Slack app:
- Add `groups:history` and the `message.groups` event (private channels such as #tethr).
- Add `mpim:history` and the `message.mpim` event (group DMs with tethr).
- Reinstall the app, then invite @tethr to the channels where you and Alec talk.

## Out of scope
- Real logins and invites (the "coming soon" field).
- Alec using tethr directly.
- Texting, hosting.

## Tests
- `tethr-members.test.ts`: company step, positions, admin, persona/CLAUDE.md with no "Wandr" or "Mark".
- `tethr-goal-pace.test.ts`: trend, uplift, damping, caps, cooldown, never below the start.
- `tethr-pace.test.ts`: allowance moves, ranges, quiet hours.
- `tethr-watch.test.ts`, covering:
  - buffering and expiry
  - when a conversation counts as settled, and what's skipped
  - no idea vs an idea, with the Slack thread reply, main-chat card and bell (fake runner and Slack)
  - Useful/Not now feedback
  - nothing is stored from the conversation
- Updated tests: setup, interview, gate wording.
- The full Tethr suite and UI tests stay green.

## Verification
1. **On a throwaway instance** (`PAPERCLIP_INSTANCE_ID=tethr-verify`, its own port and database; Mark's instance is untouched):
   - Run the six setup steps; check dark, light and phone.
   - Record measurements and watch a target adjust, with its note and bell notification.
   - Feed fake Slack messages through the watcher and check the idea in the thread, the main chat and the bell; then Useful/Not now and the pace change.
2. **Stop my dev server.** Mark double-clicks **Tethr** on the Desktop, the launcher starts tethr fresh, the intro plays, and onboarding starts at step 1, "Your company".
3. Update CLAUDE.md, MANUAL-STEPS, DECISIONS (core touches) and `tasks/phase-21.md`. Commit locally per sub-phase; never push.
