# Phase 2 — Slack: real senders + Scout migration

**Objective:** Make Tethr's Slack channel real in both directions — outbound agent notifications to `#scout` via the existing `notify.ts` stub, and inbound by migrating the existing Scout bot (`../scout`) into Tethr as its command surface.

**Definition of done:** (a) A Tethr in-app notification fans out to a real Slack message in `#scout` (channel `C0AE02FJR5Y`) from the Railway deployment; (b) Scout's current behavior (digest links/photos posted in Slack, kick off content when tagged) runs from the Tethr server, not Mark's laptop; (c) a standardized "agent recommendation" Slack message format exists and is documented.

**Prerequisites:** Phases 0 (Scout audit at `docs/tethr-buildout/scout-audit.md`) and 1 (deployed server for webhook/event URLs). A Slack app with bot token + events subscription — Mark creates/updates it in api.slack.com when prompted (~15 min; Claude Code will specify exact scopes).

**Estimate:** 3–4 sessions.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, docs/tethr-buildout/scout-audit.md, server/src/tethr/notify.ts, server/src/tethr/digest.ts, and the Scout repo at `../scout` (delegate the re-read to a subagent; I want its Slack connection mode, event handlers, and content-kickoff flow summarized into the plan).
>
> Build, in this order:
>
> 1. **Outbound:** implement the real Slack sender inside the existing `Notifier` seam in server/src/tethr/notify.ts (`chat.postMessage`, bot token from env `SLACK_BOT_TOKEN`, default channel `C0AE02FJR5Y`). Keep the stub as fallback when the token is unset so local dev stays offline. Do NOT implement SMS/email senders in this phase.
> 2. **Recommendation format:** a typed message builder (new file under server/src/tethr/) for the standard agent recommendation: what's wrong, why it matters, affected file/page/URL if determinable, agent codename, and a footer line "Reply in-thread and tag @Cursor to fix". Blocks-kit, plain black/white aesthetic, no emoji noise.
> 3. **Inbound (Scout migration):** port Scout's Slack event handling into a new additive module `server/src/tethr/slack.ts` (events endpoint on the existing Express app): link/photo digestion behavior preserved as-is per the audit, and tag-to-kick-off-content mapped to Tethr's routing entry point (`server/src/tethr/routing.ts`) so a tagged request becomes a routed Helm task instead of whatever ad-hoc thing Scout did locally. Reuse Scout's logic wherever it can be imported/copied verbatim — do not rewrite what works. If the audit shows Scout uses Socket Mode, keep Socket Mode (no public URL dependency); otherwise use the events API against the Railway URL.
> 4. List the exact Slack app config I must set (scopes, event subscriptions, request URL) — I'll do the dashboard part.
>
> Non-negotiables: no auto-posting of content to any public platform; Slack messages are notifications and intake only; secrets via Railway env vars, never committed. Write the plan with exact files, order, and per-step verification (unit test the message builder; a `scripts/`-level manual send script for the outbound test) to `tasks/phase-2.md` and stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-2.md. After each step run the verification you specified (at minimum: `pnpm test` green, plus the manual send script posting a test recommendation to #scout once I've set SLACK_BOT_TOKEN on Railway — pause and tell me when to set it). For inbound, verify with a real Slack message: I'll post a link in #scout and tag the bot; show me the server log line and the resulting routed task in the Tethr Queue UI.
>
> Update CLAUDE.md (Slack env vars, event URL/socket mode, the recommendation format contract) and DECISIONS.md if core files were touched. Commit on `tethr-buildout`. Stop before enabling any scheduled/heartbeat posting — everything in this phase is manually triggered.

## Checkpoint for Mark (phone)
Two Slack messages in #scout on your phone: (1) the test recommendation in the standard format, sent from Railway; (2) your own tagged link post answered/acknowledged by the bot, with the task visible when you open `<railway-url>` Queue page. Two minutes.

## Rollback
Unset `SLACK_BOT_TOKEN` on Railway → senders revert to log-only stubs instantly. Scout keeps running on the laptop until this checkpoint passes; only after it passes do you stop the laptop Scout process (note how to restart it in scout-audit.md first).
