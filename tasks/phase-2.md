# tasks/phase-2.md — Slack: real senders + inbound surface

**Branch:** `tethr-buildout` · **Status: code-side built 2026-07-09; live token + first post gated (A2/A3).**

Objective: make Tethr's Slack channel real in both directions — outbound agent
notifications to `#scout`, and an inbound command surface. `../scout` was absent, so the
inbound half is built **fresh** on the `notify.ts` seam (not a port), per the phase fallback.

## What was built (no Slack app needed)

1. **Outbound sender** — `server/src/tethr/notify.ts` `slack` notifier now calls a real
   `chat.postMessage` when `SLACK_BOT_TOKEN` is set, and **falls back to the log stub when
   unset** (local dev stays offline). Fan-out to in_app/sms/email unchanged; SMS/email stay
   log-only per the phase. Added optional `slackBlocks` / `channelId` / `threadTs` to
   `TethrNotification` (additive; ignored by other channels, not persisted).
2. **Recommendation format** — `server/src/tethr/recommendation.ts`: a typed
   `buildRecommendation()` producing `{ text, body, blocks }`. Block Kit, pure black/white,
   no emoji/color. Fields: what's wrong (title), why it matters, affected URL/page/**file
   path (plain text, copy-safe for @Cursor)**, agent codename, severity, optional detail
   bullets; footer **"Reply in-thread and tag @Cursor to fix."**
3. **Inbound surface** — `server/src/tethr/slack.ts`: a plain-fetch Web API client
   (`postSlackMessage`, `slackConfigured`), `verifySlackSignature` (v0 HMAC; fail-open only
   when no signing secret is set), and a **pure** `interpretSlackEvent` (url_verification
   challenge → challenge; app_mention or link/photo drop → kickoff with links extracted and
   the mention stripped; bot/own messages and plain chatter → ignore). `resolveTethrCompanyId`
   maps an inbound event to the seeded "Wandr Growth" company (or `TETHR_SLACK_COMPANY_ID`).
4. **Events endpoint** — `POST /api/tethr/slack/events` in `server/src/routes/tethr.ts`:
   verifies the signature, answers the challenge, acks within Slack's 3s window, then routes a
   kickoff via `routing.routeRequest({ invocationSource: "api" })` and posts a threaded ack.
   Deliberately **not** behind `assertCompanyAccess` — Slack authenticates by signature, and
   core's `actorMiddleware` only *resolves* the actor (no global auth wall), so the public
   webhook is reachable without a core change.
5. **Manual outbound test** — `scripts/tethr-slack-send.mjs`: posts one standard-format test
   recommendation to `#scout` using `SLACK_BOT_TOKEN` (this is gate A3).
6. **Tests** — `server/src/__tests__/tethr-slack.test.ts` (14): recommendation shape/footer/
   copy-safe file path, link extraction, event interpretation (challenge/kickoff/ignore/loop
   guard), signature verify (valid/tampered/stale/skip). `pnpm test` → 31 green total.

## Zero core touches

No core (non-`tethr`) files modified; no `packages/shared` enum change (inbound uses the
existing `invocationSource: "api"`). Nothing added to `DECISIONS.md`.

## Slack app config Mark must set (gate A2) — api.slack.com/apps

- **Bot Token Scopes:** `chat:write`, `channels:read`, `channels:history`, `files:read`,
  `app_mentions:read`. Install → copy the `xoxb-…` **Bot User OAuth Token**.
- **Event Subscriptions:** enable; Request URL = `https://<railway-url>/api/tethr/slack/events`
  (Slack will hit it with a `url_verification` challenge — the endpoint answers it). Subscribe
  to bot events: `app_mention`, `message.channels`. Copy the **Signing Secret**.
- **Invite the bot to #scout** (`/invite @<app>` in `C0AE02FJR5Y`).
- **Railway vars:** `SLACK_BOT_TOKEN=xoxb-…`, `SLACK_SIGNING_SECRET=…`
  (optional `SLACK_SCOUT_CHANNEL` override; default `C0AE02FJR5Y`). Secrets — never committed.

Socket Mode note: with a Railway public URL, the Events API is the natural fit (no websocket).
If a firewall ever forces Socket Mode, add an app-level `xapp-…` token and a socket client on
the same `interpretSlackEvent` core — the pure interpreter is transport-agnostic.

## Verification

- [x] `pnpm test` green (31, incl. 14 new). Server build typechecks.
- [ ] (gate A3) `SLACK_BOT_TOKEN=… node scripts/tethr-slack-send.mjs` posts a recommendation to #scout.
- [ ] (gate A2) Post a link in #scout tagging the bot → server logs the routed run → task shows in the Queue UI.

## Rollback

Unset `SLACK_BOT_TOKEN` → senders revert to log-only stubs instantly. The events endpoint
returns 401 on unsigned calls; disable inbound by removing the Slack app's event subscription.
