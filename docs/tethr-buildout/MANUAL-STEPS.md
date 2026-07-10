# Tethr buildout — manual steps for Mark

**Regenerated: 2026-07-09 (after Phase 0).** This is the running list of every action that
needs *you* (an account, a card, a dashboard click, a "go") — everything else Claude Code
builds without you. Groups are priority-ordered: **(A)** gets your agents talking in Slack
fastest, **(B)** unlocks money / live runs, **(C)** everything else.

> Nothing here has been pushed to GitHub. All work is local commits on branch
> `tethr-buildout`. You push/merge when you're ready.

---

## Status table

| Phase | Name | Built | Verified | Blocked on |
|---|---|---|---|---|
| 0 | Repo ground truth & Scout audit | ✅ yes | ✅ (tests green, committed) | — |
| 1 | Deploy Tethr to Railway | ⏳ code in progress | ❌ | **A1** Railway account/CLI |
| 2 | Slack: real senders + inbound surface | ⏳ pending | ❌ | **A2** Slack app + token; needs P1 URL |
| 3 | Go live with Claude (supervised) | ⏳ pending | ❌ | **B1** Anthropic key; **B2** "go" for spend |
| 4 | V1 loop (Sentry → #scout → @Cursor → PR) | ⏳ pending | ❌ | **B3** Cursor Slack integration; needs P2+P3 |
| 5 | Migrate laptop workflows | ⏳ pending | ❌ | **C-parity** your parity judgment + cron pause |
| 6 | Memory upgrade (dedupe) | ⏳ pending | ❌ | none (buildable) |
| 7 | Command Center → cloud | ⏳ pending | ❌ | **C1** CC source + `data.db` + `CC_PASSWORD` |
| 8 | Error-patching agent (Pulse/PostHog) | ⏳ pending | ❌ | **C2** PostHog key; needs P4 |
| 9 | Observability, budgets, access control | ⏳ pending | ❌ | **C3** Frank/Alec logins; needs P3+P5+P7 |
| 10 | Scale review vs $1M-no-hiring | ⛔ excluded | — | needs a month of steady-state data |

---

## GROUP A — unlocks Slack-with-your-employees fastest

*Do these in order; A1 must be done before A2's request-URL step. Total ≈ 45 min of your
time, most of it waiting on Railway/Slack UI.*

### A1 · Create the Railway project and deploy (unblocks Phase 1) — ~15 min

Claude Code will have committed `railway.toml` + a verified local Docker build first, then
hand you the exact commands. The account-linked part you run yourself:

1. Install the CLI: `brew install railway` (or `npm i -g @railway/cli`).
2. `railway login` — opens the browser, log into your Railway account.
3. In the repo root: `railway init` — create a new project (name it e.g. `tethr`).
4. Add managed Postgres: `railway add` → choose **PostgreSQL** (gives you `DATABASE_URL`).
5. Deploy: `railway up` (builds the root `Dockerfile`).
6. Set service variables (Claude will give the final list; at minimum):
   `railway variables --set SERVE_UI=true --set PAPERCLIP_MIGRATION_AUTO_APPLY=true`
   (`DATABASE_URL` is auto-injected by the Postgres plugin; **do NOT** set
   `ANTHROPIC_API_KEY` yet — mock LLM this phase.)
7. Paste the deploy URL back into Claude Code so it can verify `/health` and the seeded org.

**Where:** railway.app dashboard + your terminal. **Unblocks:** Phase 1 (Tethr live on a
URL) → prerequisite for A2.

### A2 · Create the Slack app + bot token (unblocks Phase 2) — ~15 min

Claude Code will have built the real Slack sender + inbound handler behind env vars first,
then give you the exact scopes/URLs. You do the dashboard part at **api.slack.com/apps**:

1. **Create New App** → *From scratch* → workspace = your Wandr workspace.
2. **OAuth & Permissions** → Bot Token Scopes: `chat:write`, `channels:read`,
   `channels:history`, `files:read`, `app_mentions:read` (Claude will confirm the final set).
3. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).
4. Invite the bot to `#scout`: in Slack, `/invite @<app name>` in the channel
   (`C0AE02FJR5Y`).
5. Set the token on Railway: `railway variables --set SLACK_BOT_TOKEN=xoxb-…`
   (**secret — never commit it**).
6. Inbound: Claude will tell you whether to use **Socket Mode** (needs an app-level
   `xapp-…` token, no public URL) or **Events API** (needs the Request URL
   `<railway-url>/api/tethr/slack/events` + signing secret). Set whichever it specifies.

**Where:** api.slack.com/apps + Railway. **Unblocks:** Phase 2 (agents post to #scout;
your tagged posts route into Tethr).

### A3 · Say "go" for the first real #scout post — ~1 min

The first live Slack post is a hard gate. When Claude Code pauses and shows you the test
recommendation it's about to send, reply **"go"**. (Rollback is instant: unset
`SLACK_BOT_TOKEN`.)

---

## GROUP B — unlocks money / live runs

### B1 · Anthropic API key with a low spend cap (unblocks Phase 3) — ~10 min

1. **console.anthropic.com** → **Settings → Limits** → set an **org spend limit of
   $25/mo** for the shakedown (keep this permanently).
2. **API Keys** → create a key; label it `tethr-railway`.
3. Set it on Railway when Claude Code prompts:
   `railway variables --set ANTHROPIC_API_KEY=sk-ant-…` and
   `railway variables --set TETHR_LIVE_FETCH=true` (secrets — never commit).

**Where:** console.anthropic.com + Railway. **Unblocks:** Phase 3 (one real Sonar run,
capped).

### B2 · Say "go" for the first live-LLM spend — ~1 min

First live spend is a hard gate. Claude runs a $0.01-cap stop test first (proves the
hard-stop), then asks before the real $5-capped Sonar run. Reply **"go"**. Rollback: unset
`ANTHROPIC_API_KEY` → instant revert to mock.

### B3 · Install Cursor's Slack integration (unblocks Phase 4) — ~10 min

1. **Cursor dashboard → Integrations → Slack** → connect your Slack workspace.
2. Set the default repo to your **website repo** under
   `Wandr-Health-Inc-Engineering/<website-repo>`.
3. That's it — this is Cursor's native feature; Tethr builds nothing for it. After Phase 4
   posts a finding, you reply in-thread `@Cursor fix this — <one sentence>` and Cursor opens
   the PR.

**Where:** cursor.com dashboard. **Unblocks:** Phase 4 (the full V1 loop → merged PR = V1 done).

---

## GROUP C — everything else

### C1 · Command Center migration inputs (unblocks Phase 7) — ~10 min + a file

The Command Center app lives in Drive (`05 Marketing /Command Center/`, Python stdlib), not
in this repo. To migrate it Claude needs:
1. **Access to the source** — either mount/copy `05 Marketing /Command Center/` where Claude
   Code can read it, or paste `server.py` + `static/`.
2. **A fresh copy of `data.db`** handed to Claude at migration time (row counts get verified).
3. **Pick a `CC_PASSWORD`** — set it on Railway (`railway variables --set CC_PASSWORD=…`);
   never commit.

**Where:** your machine + Railway. **Unblocks:** Phase 7 (Command Center at a URL with login).

### C2 · PostHog read-only API key (unblocks Phase 8) — ~5 min

1. **us.posthog.com → Settings → Personal API Keys** → create a key scoped **read-only** to
   project **361561**.
2. Set on Railway: `railway variables --set POSTHOG_API_KEY=phx_…` (secret).
3. Fill `server/src/tethr/tools/pulse-events.json` with your real critical event names when
   Claude asks (it ships a placeholder + a PHI denylist).

**Where:** us.posthog.com + Railway. **Unblocks:** Phase 8 (Pulse analytics agent).

### C3 · Frank/Alec logins (unblocks Phase 9) — depends on the auth approach

Phase 9 investigates what Paperclip core already ships for auth before building. If it needs
real work, Claude stops and presents options (build-minimal vs Railway private
networking + Tailscale vs defer) rather than sinking time. Your part: confirm which of
Mark=admin / Frank=admin / Alec=viewer you want, and receive seeded initial credentials
(never printed in chat).

### C4 · If the Scout repo turns up — ~2 min

`../scout` isn't on this machine (see `scout-audit.md`), so Phase 2 builds the inbound
surface fresh. **If** you have the Scout repo somewhere, clone it to
`/Users/markkaram/git/scout` (or tell Claude the path) *before* Phase 2's inbound step so it
reuses working code instead of rewriting.

### C5 · Deferred (not scheduled — no action needed now)

- **Ads pair (Tailwind/Ledger):** excluded from migration until the Google Ads MCP auth +
  Chrome action layer is solved for headless. They stay recommendation-only with the spend
  hard-gate.
- **Instagram Graph API publishing:** Command Center stays "generate → one-tap approve →
  you post manually"; the Graph API path (Business account + FB Page + app review) is a
  future phase.
- **Founding docs:** the May 18 "Wandr x AI" notes + `wandr-concept-v6.pdf` aren't in the
  contact@ Drive (likely personal account). Not blocking — the Jun 10–18 blueprint
  supersedes them. Share them only if you want the §5.1 reconciliation done.

---

### One-evening path to "agents in my Slack"

From your phone/laptop in one sitting: **A1** (Railway deploy) → **A2** (Slack app + token)
→ **A3** ("go"). That's Phases 1–2 live. Add **B1 + B2** the same evening and you also have
one real capped agent run (Phase 3). Everything between those steps is already built and
waiting.
