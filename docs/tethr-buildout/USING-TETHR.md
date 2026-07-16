# Using Tethr — a plain-English walkthrough

**What this is:** how to actually use everything, and — the part you asked for — exactly
**what is the original Paperclip and what we added on top.**

The one idea to hold onto: **Tethr is built on Paperclip the way Chrome is built on Chromium.**
Paperclip is the untouched engine (agents, schedules, approvals, budgets, storage). Tethr is a
thin product layer we added *through the engine's own seams* — never by rewriting it. So there
are really two UIs living in one app: the **core Paperclip pages** (the machinery) and the
**Tethr pages** (what your team uses day to day).

---

## Part 1 — The original Paperclip UI (untouched engine)

These pages ship with Paperclip. We did **not** change how they work — Tethr just layers on top.
You mostly won't need them day to day, but they're the ground truth underneath.

**Top of the sidebar**
- **Search** — global search across issues, agents, projects.
- **New Issue** — opens the new-issue dialog.
- **Dashboard** — the company home / overview.
- **Inbox** — notifications and items needing attention.

**Work**
- **Issues** — the hierarchical task board (statuses, assignees). Tethr's work rides on this.
- **Routines** — recurring scheduled agent runs (the cron layer). Tethr **heartbeats** are routines.
- **Goals** — the goal tree.
- **Workspaces** — isolated execution workspaces (only if the experimental flag is on).

**Projects** — the project list → project detail (issues, budget, config tabs).

**Agents** — the core agent roster and agent detail (the raw engine view of every agent).

**Company**
- **Skills** — the company skill catalog.
- **Settings** — company settings (environments, access, invites, secrets, export/import).

> Rule we held to the whole build: **add files, don't edit the engine.** The only core files we
> touched are registration points (route table, nav links, one adapter entry) + one bug fix —
> all 12 of them logged in `DECISIONS.md`. A future `git merge` from upstream Paperclip stays clean.

---

## Part 2 — What we added: the Tethr layer

### The "Operate" nav (the pages your team uses)

This whole section is ours (`ui/src/pages/tethr/**`):

- **Console** — the front door. Type a request in plain language; **@tethr** answers directly, drafts a plan to the Drive, or routes it to a specialist. This is the main way to talk to the org.
- **Company** — the org chart. Now split into **Organization** (the CEO + specialists like Radar) and **System · infrastructure** (@tethr, @tinkr, @patch — the tooling that runs the org). Click any agent for its routing table, crew, and recent work. "Ask the CEO for an agent" proposes a new one.
- **Queue** — the approval queue. Any gated work (anything external, spend, medical, PR, or an org change) **stops here** for your approve / reject / request-changes. Nothing ships without you.
- **Drive** — the shared **00 Tethr** workspace that syncs to Google Drive: 01 Briefs, 02 Documents, etc. Toggles reveal the internal working drive and other Drive folders.
- **Budgets** — one monthly spend line for the company + per-agent caps (hard stops).
- **Activity** — the audit trail: every hop, run, output, and decision.
- **Memory** — what the company remembers; agents pull from here each run.
- **Providers** — LLM / storage / notification status, the **live↔mock** switch, the **usage throttle**, and the overseer roster.

(Two more pages exist off-nav: an agent detail page, reached by clicking an agent; and a heartbeat-run history page.)

### The off-app surfaces we added (no web app needed)

- **Terminal CLI** (`scripts/tethr-cli.mjs`) — talk to @tethr from a terminal instead of Slack. `tethr "what bugs do I need to fix?"` or a REPL. Great for engineers. (Setup + remote access: `LOCAL.md` §6.)
- **Folder Command Center** (`scripts/tethr-command-center/start.command`) — a double-click local app to read and organize the 00 Tethr folder (nice Markdown viewer + rename/move/archive) **without opening the web app**.
- **Claude subscription backend** — run the whole org on your **Claude Pro/Max** subscription instead of a per-token API key (set `TETHR_LLM_BACKEND=claude-code`).
- **Usage throttle** — one switch that **pauses every agent** when you're near your Claude limits (Providers page, the "AGENTS PAUSED" pill by the bell, or "pause agents" in Slack).

### The three ways to reach the org

1. **Console chat** (in the web app) · 2. **Slack** (tag @tethr or DM the bot) · 3. **Terminal CLI**.
All three go through the *same* engine and land in the same Queue.

---

## Part 3 — The walkthrough (how to actually use it)

A day-in-the-life checklist:

1. **Ask for something.** Open **Console** (or Slack, or `tethr`) and ask in plain language —
   a question, "draft a brief on X", "what bugs do I need to fix?". @tethr answers or routes it.
2. **Watch it work.** The request shows its hops (route → agent → tools). A quick question comes
   straight back; bigger work becomes a draft.
3. **Review gated work in the Queue.** Anything external/spend/medical/PR or an org change waits
   in **Queue** for your approve/reject. This is the safety valve — nothing ships without you.
4. **Read the output in the Drive.** Approved deliverables land in **00 Tethr** (and sync to
   Google Drive). Read them in the web Drive page, the **Command Center**, or Google Drive itself.
5. **Grow the org.** On **Company**, "Ask the CEO for an agent" → the CEO proposes one → approve it
   in the Queue → it's built (paused). Turn on its heartbeat when you're ready.
6. **Let it run on its own (optional).** For true autonomy: set an agent to **Auto-approve** and
   enable its **heartbeat**. Then it plans, works, and files to the Drive on a schedule — you get
   a Slack FYI. (Spend/medical/PR **never** auto-approve; budget changes stay manual, always.)
7. **Keep an eye on cost.** **Budgets** shows spend vs caps. If you're on the Claude subscription
   and usage is getting high, **throttle** (next section).

---

## Part 4 — The controls you'll reach for

| I want to… | Do this |
|---|---|
| **Pause every agent** (near my Claude limit) | Providers page → flip **Agents active** off · or say **"pause agents"** in Slack · or click the **AGENTS PAUSED** pill |
| **Resume** | Same toggle · or **"resume agents"** in Slack |
| **Run the org on my Claude subscription** | Set `TETHR_LLM_BACKEND=claude-code` in `~/.paperclip/instances/default/.env`, restart. (A go-live decision — flip it when ready.) |
| **Go live vs. free mock** | Providers page → **Agent intelligence** toggle |
| **Stop one agent** | Company → click the agent → pause it (or set its budget cap) |
| **Talk from a terminal** | `tethr "…"` (see `LOCAL.md` §6) |
| **Browse the folder without the web app** | Double-click `scripts/tethr-command-center/start.command` |

---

## The boundaries that never move

- Nothing publishes, spends, or makes a medical decision without a **human approving it** — that
  gate is hard, in every path (Console, Slack, CLI, auto-approve, subscription — all of them).
- Budget/spend changes are **always** manual.
- Tethr is marketing/distribution only — it never touches PHI, clinical systems, or the website's
  medical-content correctness.

*More detail lives in `CLAUDE.md` (the operating contract), `LOCAL.md` (running it locally), and
`RUNBOOK.md` (ops).*
