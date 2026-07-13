# Running Tethr entirely on your laptop

Everything runs locally — no cloud, no Railway. As a solo user this is the nicest place to
start: the embedded Postgres persists across restarts and you have the Console UI right there.
Two ways to talk to **Tethr** (the coordinator — the one agent that absorbs any request):
the **Console chat** (built in) and **Slack tag/DM** (Socket Mode — no tunnel).

## 1. Start it

```bash
pnpm install     # once
pnpm dev         # server :3100 + UI :5173, embedded Postgres, auto-seeds the org
```

First boot seeds the clean-slate org: company **Wandr** (prefix `WD`) with one agent —
**Tethr** (`@tethr`), the coordinator. (If an older DB still has the 12-agent "Wandr Growth"
org, it is archived automatically — nothing deleted.) Open **http://localhost:5173** → the
**Wandr** company → **Console**. Type anything — a question, "draft a plan for X" — and Tethr
answers directly or saves a plan to the Drive. Gated work stops in the **Queue**. That's the
whole product, on **mock LLM** (deterministic, free, offline). Nothing else is required.

**Local config lives in `~/.paperclip/instances/default/.env`** (NOT the repo `.env`). Add the
vars below there and restart `pnpm dev`. (Exporting them in your shell before `pnpm dev` also
works.)

## 2. Slack — agents post to you, and you tag/DM the bot back

You don't need a public URL or a tunnel: outbound is a normal API call, and inbound uses
**Socket Mode** (an outbound WebSocket from your laptop to Slack).

### 2a. Create the Slack app (~15 min, once) — api.slack.com/apps

1. **Create New App → From scratch** → your workspace. **Name it "Tethr"** (App Name and the
   bot display name under App Home) so tagging `@tethr` reaches the coordinator. Renaming an
   existing app: Basic Information → App Name + App Home → bot display name.
2. **Socket Mode** (left nav) → toggle **On**. It prompts you to create an **App-Level Token**
   with scope `connections:write` → copy it (`xapp-…`) → this is `SLACK_APP_TOKEN`.
3. **OAuth & Permissions → Bot Token Scopes:** `chat:write`, `app_mentions:read`,
   `channels:read`, `channels:history`, `files:read`, **`im:history`, `im:read`, `im:write`**
   (the `im:*` ones enable DMs). **Install to Workspace** → copy the **Bot User OAuth Token**
   (`xoxb-…`) → this is `SLACK_BOT_TOKEN`.
4. **Event Subscriptions** → On (Socket Mode needs no Request URL) → **Subscribe to bot events:**
   `app_mention`, `message.im` (DMs), `message.channels` (channel posts). Save.
5. **App Home** → enable **Messages Tab** and check **"Allow users to send Slash commands and
   messages from the messages tab"** so you can DM the bot.
6. Invite the bot to your channel: `/invite @<app>` in **#scout** (`C0AE02FJR5Y`).

### 2b. Set the tokens locally

In `~/.paperclip/instances/default/.env`:

```
SLACK_BOT_TOKEN=xoxb-…      # send + receive
SLACK_APP_TOKEN=xapp-…      # Socket Mode (inbound, no public URL)
# optional: SLACK_SCOUT_CHANNEL=C0AE02FJR5Y   # default is already #scout
```

Restart `pnpm dev`. You'll see `tethr slack: Socket Mode connected` in the log. Now:

- **DM the bot** anything ("what's our Peru ad budget?") → Tethr handles it exactly like the
  Console chat, and **the answer comes back in the same DM/thread**.
- **@tethr-mention the bot** in #scout, or drop a link → same thing, answered in-thread.
- **Agents post to #scout** — recommendations, digests, approvals — via the bot.

> Requires **Node ≥ 22** (for the built-in WebSocket). Check with `node -v`. If it's older,
> either upgrade Node or use the Events-API path with a tunnel (below). Without
> `SLACK_APP_TOKEN`, Socket Mode is simply off and everything else still works.

### 2c. Alternative: no Socket Mode (tunnel)

If you'd rather use the HTTP Events API (e.g. Node < 22): leave `SLACK_APP_TOKEN` unset, run a
tunnel (`cloudflared tunnel --url http://localhost:3100` or `ngrok http 3100`), set the Slack
app's **Event Subscriptions Request URL** to `https://<tunnel>/api/tethr/slack/events`, and set
`SLACK_SIGNING_SECRET` in the env. Re-paste the URL whenever the tunnel restarts.

## 3. Go live with real Claude (optional)

Still local — just swap the provider:

```
ANTHROPIC_API_KEY=sk-ant-…
TETHR_LIVE_FETCH=true
# optional: TETHR_CLAUDE_MODEL=claude-sonnet-5        (work model — the default)
# optional: TETHR_CLAUDE_FAST_MODEL=claude-haiku-4-5  (cheap routing — the default)
```

Restart. Now agents use real Claude, and **budget caps enforce for real** (each agent has a
monthly cap with a hard stop). Keep a low org-level spend limit at console.anthropic.com. Unset
the key to snap back to the free mock. Read spend on the **Budgets** page.

## 4. The two auditors (Sentry + Pulse)

Their code is built and tested, but the clean-slate org doesn't seed them — they return as
Tethr's org grows (or live in the archived Wandr Growth org, re-seedable with
`POST /api/tethr/seed {"org":"growth"}`). Once seeded, run them on demand:

- **Sentry** (site audit — travelwithwandr.com): "Run now" on Sentry in the Company page, or set
  `TETHR_SENTRY_DRY_RUN=true` to preview findings without posting. Needs internet (it fetches the
  live public site); no key.
- **Pulse** (PostHog): set `POSTHOG_API_KEY` and fill `server/src/tethr/tools/pulse-events.json`
  with real event names, then "Run now" (or `TETHR_PULSE_DRY_RUN=true` to preview).

To have them run daily, un-pause their heartbeat routines — they fire while `pnpm dev` is
running.

## 5. Keeping it running

Heartbeats/schedules fire only while the server is up. For always-on local operation either keep
`pnpm dev` running, or use the Docker path for a more production-like local instance:

```bash
make compose-up      # Postgres 17 + server + bundled UI on :3100
```

Data is in Postgres (embedded dev dir, or the compose volume), so restarts are safe. When you're
ready for the cloud, `docs/tethr-buildout/MANUAL-STEPS.md` Group A is the same setup pointed at
Railway — nothing you do locally is throwaway.
