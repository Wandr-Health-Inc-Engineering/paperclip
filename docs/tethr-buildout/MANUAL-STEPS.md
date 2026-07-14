# Tethr buildout — manual steps for Mark

**Regenerated: 2026-07-09 · everything buildable-without-your-accounts is built.**

This is the one list of everything that needs *you* — an account, a card, a dashboard click, a
"go", or a file only you can reach. Everything else is done: **8 of 10 phases are code-complete
and committed locally on branch `tethr-buildout`** (Phases 0,1,2,3,4,6,8,9), with the full Tethr
test suite green and **zero Paperclip-core files modified** (merge-safe). Phases 5 and 7 need
inputs only you can provide (below). **Nothing has been pushed to GitHub — you push/merge when
ready.**

Groups are priority-ordered: **(A)** gets your agents talking in Slack fastest, **(B)** unlocks
money / live runs, **(C)** everything else. Clearing **Group A** in one evening puts live agents
in your #scout.

---

## Status table

| Phase | Name | Built | Verified | Blocked on |
|---|---|---|---|---|
| 0 | Repo ground truth & Scout audit | ✅ yes | ✅ tests green, committed | — |
| 1 | Deploy Tethr to Railway | ✅ code (`railway.toml`, build verified) | ❌ deploy | **A1** Railway account |
| 2 | Slack: senders + inbound surface | ✅ code + 14 tests | ❌ token/post | **A2** Slack app · **A3** "go" |
| 3 | Go live with Claude (supervised) | ✅ code + safety + **budget-bug fixes**, 8 tests | ❌ spend | **B1** Anthropic key · **B2** "go" |
| 4 | V1 loop (Sentry → #scout → @Cursor → PR) | ✅ code + 16 tests | ❌ run | **B3** Cursor + enable Sentry |
| 5 | Migrate laptop workflows | ⛔ not built (needs Drive) | ❌ | **C4** Drive access + your parity + cron pause |
| 6 | Memory upgrade (dedupe) | ✅ built + tested, ADR-0002 | ⚠️ backfill | **C5** corpus backfill (1 cmd, optional) |
| 7 | Command Center → cloud | ⛔ not built (source in Drive) | ❌ | **C6** provide source + `data.db` + `CC_PASSWORD` |
| 8 | Error-patching agent (Pulse/PostHog) | ✅ code + 10 tests, PHI denylist | ❌ run | **C1** PostHog key + fill config |
| 9 | Observability, budgets, access control | ✅ built + tested, `RUNBOOK.md` | ⚠️ logins | **C2** Frank/Alec accounts + uptime |
| 10 | Scale review vs $1M-no-hiring | ⛔ excluded | — | needs ~1 month of steady-state data |

Reference: `CLAUDE.md` (how it all works), `RUNBOOK.md` (ops/kill-switches), `tasks/phase-N.md`
(what each phase did), `docs/adr/000{1,2}-*.md` (decisions).

---

## GROUP A — agents in your Slack, fastest (~45 min, one evening)

### A1 · Deploy to Railway (unblocks Phase 1) — ~15 min

`railway.toml` is committed and the server build is verified green. In the repo root:

```
brew install railway                       # or: npm i -g @railway/cli
railway login                              # browser auth
railway init                               # new project, name it "tethr"
railway add                                # choose PostgreSQL
railway variables --set PAPERCLIP_MIGRATION_AUTO_APPLY=true \
                  --set SERVE_UI=true \
                  --set BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
                  --set DATABASE_URL='${{Postgres.DATABASE_URL}}'
railway up                                 # builds the Dockerfile, deploys
railway variables --set PAPERCLIP_PUBLIC_URL='https://<railway-domain>'   # after it prints a URL
```

**Do NOT set `ANTHROPIC_API_KEY` yet** (mock LLM this phase). First visit creates your admin
login (authenticated/private by default; accounts persist in Postgres). Fallback if that flow
misbehaves headless: `--set PAPERCLIP_DEPLOYMENT_MODE=local_trusted` (restore to `authenticated`
before Group C's real logins). **Where:** railway.app + terminal. Full runbook: `tasks/phase-1.md`.

### A2 · Create the Slack app + bot token (unblocks Phase 2) — ~15 min

At **api.slack.com/apps** (uses the Events API against your Railway URL — no Socket Mode):

1. **Create New App** → *From scratch* → your Wandr workspace. **Name it "Tethr"** (App Name
   and the bot's display name under App Home) — tagging `@tethr` is how everyone reaches the
   coordinator. If the app already exists under another name (e.g. "Scout"), rename it there.
2. **OAuth & Permissions → Bot Token Scopes:** `chat:write`, `channels:read`,
   `channels:history`, `files:read`, `app_mentions:read`. **Install to Workspace** → copy the
   **Bot User OAuth Token** (`xoxb-…`).
3. **Basic Information → App Credentials:** copy the **Signing Secret**.
4. **Event Subscriptions:** on → Request URL `https://<railway-url>/api/tethr/slack/events`
   (auto-answers Slack's challenge) → subscribe to bot events `app_mention`, `message.channels`.
5. `/invite @<app>` into **#scout** (`C0AE02FJR5Y`).
6. `railway variables --set SLACK_BOT_TOKEN=xoxb-… --set SLACK_SIGNING_SECRET=…` (secrets).

### A3 · Say "go" for the first #scout post — ~1 min

Once the token is set, `SLACK_BOT_TOKEN=xoxb-… node scripts/tethr-slack-send.mjs` drops one
standard-format recommendation into #scout. Run it (or reply "go" in a session where the token
is available). Then test inbound: post a link in #scout tagging the bot → it routes into the
Tethr Queue. Rollback: unset `SLACK_BOT_TOKEN`.

---

## GROUP B — money / live runs

### B1 · Anthropic API key + spend cap (unblocks Phase 3) — ~10 min

Phase 3 fixed two real bugs so budget caps now actually enforce (before, every agent recorded
$0 cost and only Tailwind hard-stopped). Safety is locked by 8 tests. So this is just:

1. **console.anthropic.com → Settings → Limits** → org spend limit **$25/mo** (keep permanently).
2. **API Keys** → create `tethr-railway`.
3. `railway variables --set ANTHROPIC_API_KEY=sk-ant-… --set TETHR_LIVE_FETCH=true`. Restart.
   Leave `SLACK_BOT_TOKEN` unset for the tightest first run, or keep it for a #scout digest.

### B2 · Say "go" for the first live spend — ~1 min

The plan runs a **$0.01-cap stop test** first (proves the hard-stop halts a run), then one real
**$5-capped** Sonar news-scan. Reply "go". Read the cost on the Budgets page. Rollback: unset
`ANTHROPIC_API_KEY` → instant mock revert.

### B3 · Cursor integration + turn Sentry on (unblocks Phase 4) — ~15 min

Sentry (site auditor: meta / JSON-LD / broken-link / GA4+GTM checks, 14-day dedupe) is built,
tested, seeded **paused** with a $20/mo cap.

1. **Cursor** dashboard → Integrations → Slack → connect workspace; default repo = your website
   repo. (Cursor's native feature — Tethr builds nothing for it.)
2. **Preview:** `railway variables --set TETHR_SENTRY_DRY_RUN=true`, then Run-now on Sentry
   (`POST <url>/api/tethr/<companyId>/agents/<sentryAgentId>/run-now` or the Company page) →
   `resultJson.sentry.postedFindings` shows what it would post. Review.
3. **Go live:** set `TETHR_SENTRY_DRY_RUN=false`, confirm `SLACK_BOT_TOKEN` is set, Run-now to
   post the batch, then **enable Sentry's heartbeat** (unpause) for the daily run.
4. In #scout: reply `@Cursor fix this — <one sentence>`. Cursor opens a PR; review on mobile,
   merge. **That merged PR is V1 done.**

---

## GROUP C — everything else

### C1 · PostHog key + fill Pulse config (Phase 8) — ~10 min

Pulse (analytics agent: error spike / dead event / funnel drop, PHI denylist) is built, tested,
seeded paused ($20/mo). To turn it on:

1. **us.posthog.com → Settings → Personal API Keys** → **read-only** key scoped to project
   **361561**; `railway variables --set POSTHOG_API_KEY=phx_…`.
2. **Fill `server/src/tethr/tools/pulse-events.json`** — replace each `FILL_ME` with real event
   names (a couple of critical events + one funnel pair). Marketing events only (clinical names
   auto-rejected). Commit it (config, not a secret).
3. Preview with `TETHR_PULSE_DRY_RUN=true` (Run-now on Pulse), review, then enable its heartbeat.

### C2 · Frank/Alec logins + uptime pinger (Phase 9) — ~10 min

Core ships **better-auth** (the deploy already runs authenticated), so this is account setup, not
a build:

1. Add **Frank** (admin) and **Alec** (viewer) via the app once live. If core has no viewer role
   yet, make all three admins for now (noted in `RUNBOOK.md`). Never print passwords.
2. **Uptime:** point **UptimeRobot** (free) at `https://<railway-url>/api/tethr/health/deep`,
   5-min HTTP monitor, alert on non-200. (Deep check reports DB + heartbeat age.)
3. Optionally schedule the weekly Monday spend summary alongside the daily digest.

### C3 · Backfill published-content memory (Phase 6) — ~2 min, optional

Dedupe is built and every new publish self-records; this only backfills your existing catalog.
When you have `My Drive/tethr/shared/memory-published-articles.md`:

```
TETHR_COMPANY_ID=<wandr-growth-id> TETHR_BASE_URL=https://<railway-url> \
  node scripts/tethr-seed-memory.mjs /path/to/memory-published-articles.md
```

Idempotent. Optionally send `docs/adr/0002-memory-architecture.md` to Frank for the embeddings/
graph call.

### C4 · Migrate the laptop workflows (Phase 5) — needs Drive access + your judgment

**Not yet built — it needs inputs only you have.** This moves the 4 active laptop crons
(blog / briefs / itineraries / analytics) into Tethr heartbeats, one at a time, Sonar first.
For a future Claude Code session to build each migration it needs read access to the Drive
blueprint (`My Drive/tethr/agents/…`, `…/skills/wandr/…`, `engine-inventory.md`) and the live
engine at `05 Marketing /Claude Marketing/` **as read-only reference**. Then per workflow: Claude
builds the heartbeat, does one manual run, and places the output beside the laptop's latest for
**your parity judgment**; only after 3 outputs at parity do **you** pause (never delete) that
laptop cron. **Ads pair (Tailwind/Ledger) is excluded** until the Google Ads/Chrome-headless
question is solved. Nothing here touches the laptop or Drive engine without you.

### C5 · Command Center → cloud (Phase 7) — needs the source + a file

**Not yet built — the app lives in Drive, not this repo.** To migrate it, a future session needs:
(a) read access to `05 Marketing /Command Center/` (`server.py` + `static/`), (b) a fresh
`data.db` at migration time (row counts get verified), (c) a `CC_PASSWORD` you set on Railway.
Then it's copied (never moved) into `apps/command-center/`, Postgres-backed, behind a login,
restyled to the Tethr brand, with the Reddit/Instagram flows preserved. Your laptop copy keeps
running throughout — it *is* the rollback.

### C6 · If the Scout repo turns up — ~2 min

`../scout` isn't on this machine, so Phase 2 built the inbound surface fresh. **If** you have the
Scout repo, clone it to `/Users/markkaram/git/scout` before revisiting Phase 2 so working code
can be reused instead of rewritten. (`docs/tethr-buildout/scout-audit.md`.)

### C6a · Overseer roster — buzz the right cofounder (~2 min, in-app)

Slack alerts (heartbeat deliverables + things needing approval) route by an
agent's role. Set the three people once, in **Settings → overseer roster**:
**Tech = Frank**, **Exec = Alec**, **Growth & Ops = Mark**. For each, enter their
**Slack member ID** (Slack → their profile → ⋯ → **Copy member ID**, looks like
`U0…`). New agents auto-route by domain (a tech agent → Frank). Until IDs are
set, alerts stay in the in-app bell only. If proactive DMs don't deliver, add the
**`im:write`** scope to the Slack app (OAuth & Permissions → reinstall).

### C6b · AI image generation into the shared workspace (deferred; needs your account)

The shared-folder mirror (2026-07-13) can already carry any file bytes; what's missing is a
*generator*. Anthropic has no image-gen API, so this needs a second provider:

1. **Recommended: OpenAI Images (`gpt-image-1`)** — best quality/simplicity for marketing
   visuals (~$0.02–0.19/image). Alternative: Google Imagen (Vertex).
2. Create the account/key yourself, then set `OPENAI_API_KEY` in the instance env.
3. Say "go" in a session: the build is a `generate_image` tool (allowlisted per-agent,
   `spend`-sensitivity gated so every image is human-approved) writing PNGs through the same
   mirror seam into `00 Tethr`. Zero code exists today; it's a one-session add.

### C7 · Deferred (no action needed now)

- **Ads pair (Tailwind/Ledger):** excluded until Google Ads MCP auth + Chrome-action layer works
  headless — stays recommendation-only with the spend hard-gate.
- **Instagram Graph API publishing:** Command Center stays "generate → one-tap approve → you post."
- **S3/R2 for Drive file bytes:** Railway's FS is ephemeral; core's S3 provider is a later env swap
  (or attach a Railway volume at `/paperclip`).
- **Founding docs:** the May 18 notes + `wandr-concept-v6.pdf` aren't in the contact@ Drive; the
  Jun 10–18 blueprint supersedes them.

---

## The one-evening path

**A1 → A2 → A3** = agents posting in #scout from the cloud. Add **B1 → B2** the same evening and
you also have one real, $5-capped agent run. **B3** then closes the V1 loop (a Sentry finding →
`@Cursor` → merged PR). Everything in those steps is already built and waiting on the token/click
each one names. Group C is at your leisure; C4/C5 are the only remaining *build* work, and each
just needs you to open a door (Drive access, the CC source) for a future session.
