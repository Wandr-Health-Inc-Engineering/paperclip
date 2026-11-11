# Tethr build — decisions log

Branch: `mark-sandbox` (local only). Date started: 2026-06-11.

## Baseline

- Upstream merge-base (paperclipai/paperclip): `68f4eb6b967fb1583396006187434920df6ca037`
- Fork HEAD at build start: `436dc2b7` (tethr reskin phase 12)
- Toolchain: Node v24, pnpm 9.15.4, Vite 6 / React 19 / Tailwind v4, Express 5, Drizzle ORM,
  Postgres (embedded for dev, external via `DATABASE_URL`, docker-compose provides Postgres 17)

## Stack and shape decisions

1. **Build inside the fork's existing seams, not a parallel app.** The BUILD-PROMPT sketches
   `tethr-server` / `tethr-shell` / `tethr-addons` directories; this fork already *is* the
   Tethr shell (12 reskin phases) and Paperclip core already provides companies, agents with
   `reportsTo`, heartbeat runs, cron routines, approvals, budget policies, cost events,
   activity log, and a `StorageService` with local-disk + S3 providers. Rebuilding those
   in a side app would duplicate the engine and break the "thin shell, rich edges" rule.
   Tethr code lives in clearly separated modules instead:
   - `packages/db/src/schema/tethr_*.ts` — additive tables
   - `server/src/tethr/**` — all Tethr services (routing, drive, gating, llm, seed)
   - `server/src/routes/tethr.ts` — one route module
   - `ui/src/pages/tethr/**` + `ui/src/components/tethr/**` — all new screens
2. **DB = Postgres via Drizzle with generated migrations** (matches core exactly; SQLite
   rejected). Local dev uses the embedded Postgres core already ships; `docker compose up`
   provides Postgres 17 for the containerized path. Cloud swap = `DATABASE_URL` change.
3. **Storage**: file bytes go through core's `StorageService` interface
   (`local_disk` default → `s3` by env, already implemented in core). Tethr adds the
   *Drive* metadata layer (folders, versions, tags, permissions) in `tethr_drive_*` tables,
   keyed by provider object keys. Future GCS/S3 = implement provider + env switch; callers
   untouched. Local bytes live under `.tethr-data/storage/` (env-configured, gitignored).
4. **LLM**: `LLMProvider` interface in `server/src/tethr/llm/`. `ClaudeProvider` used when
   `ANTHROPIC_API_KEY` is present; otherwise `MockProvider` returns deterministic,
   realistically-shaped output (routing decisions, leads, replies, briefs) so the entire
   product is demoable offline. No keys hardcoded.
5. **Agent execution**: a real server adapter `tethr-llm` registered through the adapter
   registry (the documented seam). Heartbeats/routines/run-now/cost events therefore flow
   through core machinery unmodified. The adapter runs the classify → route → do loop and
   returns resultJson + usage.
6. **Approval gating**: gated outputs are `tethr_outputs` rows with status `gated`; each
   gets a core `approvals` row (type `tethr_output`). Publish transitions are *only*
   performed by the gating service after the linked approval is `approved` — a hard block,
   not advisory. Reject / request-changes flow back to the output status. Every decision is
   written to the core activity log (audit).
7. **Subagents are Tethr rows, not core employees** (matches the bundle manifest: "config
   inside agent, not separate employees in v1"). `tethr_subagents` carries the full
   fine-tuned spec (route-when, reads, steps, output, guardrails, done, escalation).
8. **Divisions are first-class** (`tethr_divisions`), CEO → division head → agents.
   Growth seeded fully; Engineering/Tech, Reliability/Errors, Customer Feedback/Support
   seeded as ready-to-fill shells (head slot + empty agent slots), so adding a division is
   data, not architecture.
9. **Seed source**: the importer reads the bundle at `TETHR_BUNDLE_PATH`
   (default: Mark's Drive path) for agent ROLE/ROUTING/subagent markdown and copies them
   into Drive storage. A vendored compact org spec (`server/src/tethr/seed/wandr-growth.ts`,
   derived from `import/wandr-growth.company.json` + FINE-TUNING-SUMMARY) makes the seed
   fully self-contained when the Drive bundle is absent. The live bundle is never written to.
10. **Naming (brand kit surfaces)**: Console (Helm), Queue (approvals), Drive (files),
    Runs, Budgets, Audit, Company. "Ledger"/"Beacon" surface names from the brand kit were
    skipped — they collide with agent codenames.
11. **Sonar's Slack delivery** is a `Notifier` interface: in-app notification center is the
    working local implementation; `SlackNotifier`/`SmsNotifier`/`EmailNotifier` are stubs
    behind the same interface (mock locally, listed in MIGRATION-NOTES.md).
12. **No live integrations touched**: no Google Drive, no Slack, no Google Ads, no GA4.
    Tailwind (ads) + spend paths are execution-gated and mock-only.

## V2 decisions (operating-grade build, 2026-06-12)

13. **Tool registry with per-subagent allowlists** (`server/src/tethr/tools/`): every
    subagent gets `drive_list`/`drive_read`/`recall_memory`; web reach (web_fetch,
    reddit_scan, cdc_scan) and tracker writes only where the spec's `reads` call for
    them. `drive_write` is restricted to `/state/` + `/scratch/` — publishing still
    only happens through the gating service, so tools cannot bypass the hard gates.
14. **Live fetch is flag-gated** (`TETHR_LIVE_FETCH=true`, on for Mark's instance) with
    deterministic fixtures otherwise. Live CDC RSS works; **Reddit returns 403 to
    unauthenticated clients** — reddit_scan degrades to fixtures gracefully; cloud team
    can add read-only OAuth creds later. Rate limit ~1 req/s, honest User-Agent, GET only.
15. **Agentic loop on both providers**: ClaudeProvider runs the real tools API loop
    (8-turn cap, forced final answer at cap); MockProvider runs a deterministic scripted
    loop so tests/offline demos behave identically run-to-run. Every tool call is a
    `tool` hop on the route run.
16. **Trackers are versioned JSON in `/state/`**, not markdown tables: a single
    atomic `putFile` per advance = the locked-tracker problem from the bundle resolved
    by version history instead of lock files. Approve-publish appends the dedup log and
    flips the claimed row to published (topic/slug heuristic match, noted).
17. **Revisions**: `request_changes` auto-triggers a revision (`TETHR_AUTO_REVISE=false`
    disables; manual button exists). v(n+1) links to v(n) via `revision_of_id`
    (migration 0088) and re-enters the same gate.
18. **Plans**: Helm asks the provider for a multi-agent sequence before single-agent
    classification; the three worked examples from ROUTING-MODEL.md are the mock's
    canned plans. Steps share results forward; spend/clinical steps still gate.
19. **Live console = async route + poll** (650ms) rather than new websocket event types
    in shared — keeps the core LiveEventType union untouched. Console paces hops at
    350ms so the chain is watchable; heartbeat/run-now paths stay synchronous.
20. **Digest** is a heartbeatMode on Helm's adapter config (5 PM routine), not a fake
    subagent — Helm is a router and a reporter, never a producer.
21. **Export carries state, not history**: org + specs + memories + outputs + drive
    files (≤256KB each, base64). Import restores drive + company-wide memories into an
    existing company; full org remapping stays a cloud-importer task (documented).
22. **Core company remove() fixed** (the V1-documented bug): cost_events before
    heartbeat_runs, routines/budget-policies added, tethr tables cleared first (their
    CASCADE + SET NULL mix trips Postgres RI checks when agents delete mid-transaction).
    Regression-tested in tethr.test.ts. This is the one substantive core change; it is
    upstreamable as written.
23. **Upstream merge drill** (2026-06-12, vs upstream/master `d9ea1bf9`): 24 conflicted
    files, zero in `tethr` files. Conflicts are reskin-era styling + the logged
    registration points (.gitignore, shared/index.ts, Sidebar, companies.ts,
    migrations journal) — all one-liner shape, as designed. Drill aborted cleanly.

## Phase 18 decisions (Tethr v1, chat-first — 2026-11-07)

24. **Outward connector actions follow the Integrations modes** (Mark's decision,
    2026-11-07). The old hard boundary "Internal-only output. Nothing auto-publishes" is
    replaced: each connector runs in **Auto** or **Approval required** per the Integrations
    page. **Always ask, regardless of Auto:** money (every Stripe write, all of Mercury),
    anything public-facing (including email to external recipients), and anything medical.
    **Never PHI.** Nothing auto-merges; the gating hard-block on `medical`/`public`/`spend`/`pr`
    outputs is unchanged. CLAUDE.md "Hard boundaries" carries the wording.
25. **Fresh start: archive the nine specialists, keep only @tethr** (Mark's call,
    2026-11-07 — barely used: @tethr handled 35 of the last 100 requests, the others 1–9 each;
    @ceo in an error state). **Archive, not delete:** paused with `pauseReason "archived: fresh
    start"` (never terminated — terminated agents can't be resumed), routines paused + triggers
    off (plus @tethr's "Weekly growth review"), @tethr's routing rows to them stripped. Everything
    changed is stashed in the instance-dir `tethr-archive.json` so `restoreSpecialists` puts it
    back exactly; the file doubles as the run-once boot marker, so a restore survives restarts.
    The specialist seeds + growth workflows no longer auto-run — opt back in with
    `TETHR_SEED_SPECIALISTS=true`, which also skips the boot archive. Routing falls back to
    @tethr for any paused/archived target. Rejected: deleting the agents (loses the parts bin
    and history) and terminating them (one-way in core). No core files changed.
26. **Tethr adapter returns `costUsd` top-level** as well as in `resultJson`. Core
    `heartbeat.updateRuntimeState` bills `result.costUsd`, so live heartbeat/task runs had been
    recording $0 spend against the budget hard-stops. Tethr-only fix (`adapter.ts`).

## Phase 23 decisions (tethr runs a team — 2026-11-08)

27. **tethr spins up its own agents** (Mark: "a new Hermes/paperclip hybrid"). A team agent is
    a real Paperclip agent (core agents row, profile, hard-stop budget policy, a routine when it
    has a schedule) that works tasks as Claude session turns in its own chat thread, inside a
    connector allowlist, with no shell. tethr creates agents, assigns tasks and gets reports
    back; agents can't create agents or assign work (depth 1, like Hermes subagents). Rejected:
    reviving the archived classic-engine specialists (they ran through the old routing engine,
    with no connectors and no memory of the conversation).
28. **New agents: "Ask me" or "Automatic"** (Integrations → Team; Mark: "can be set to
    autonomous or manual approval"). Ask (default) = an approval card for every new agent and
    every change. **Automatic is Mark's explicit, standing go** for tethr to create agents and
    switch their schedules on, within the team's limits (max active agents, a monthly budget for
    the whole team); past them it falls back to a card. For team agents this replaces the
    hard gate "enabling any heartbeat needs an explicit go" only while Automatic is on; an
    approved card is that go under Ask. **Raising an agent's budget or runs always asks** (a
    `spend` card, Mark's standing budget rule); pausing never needs approval.
29. **Delegation needs no approval** (Mark's answer): `assign_task` runs within the agent's
    daily run cap (default 4, max 12), 3 open tasks, its budget hard stop and the usage throttle.
    Anything outward an agent tries still follows the Integrations modes, and its approval card
    DMs the agent's owner.
30. **Reports go to the main chat and to the right person** (Mark: "agents should report to a
    Slack ID based on setup and relevance"): a card + note in the main chat, the bell, and a
    Slack DM to the owner (overseer roster role, inferred from the agent's job; else the admin;
    else #tethr). Slack carries only the headline and the agent's one-line "Slack summary",
    never the report. No core files changed.

## Phase 24 decisions (tethr is the brain — 2026-11-09)

31. **Framework only; nothing new runs on its own until switched on** (Mark: "The previous
    work added agents I didn't want. I want everything to be done inside tethr. We're just
    building the framework."). The three agent proposals a build-time "Propose a starting team"
    run left in his chat were withdrawn (status rejected, `meta.withdrawn`, logged as a system
    action) and tethr was told in a note. Builds never propose, create or run anything on Mark's
    instance; verification happens on a throwaway copy.
32. **Teams go two levels deep** (Mark: "sub-agents like one just for keywords, one to look for
    strategies"): tethr → a lead → up to 4 sub-agents. A lead's sub-tasks are core child issues of
    its task, so core wakes it to roll up; sub-agents report to their lead, and only the lead
    reports to tethr. Sub-agents get a subset of their lead's tools and follow the same approval
    setting. Rejected: unlimited depth (cost and accountability blur).
33. **tethr's own turns (check-ins on reports, a daily review) ship switched off** and are
    bounded by a daily cap and the usage throttle. Switching one on in Integrations → Team is
    Mark's go for those turns (the "enabling any heartbeat needs a go" gate).
34. **Approval DMs fall back to the company admin's Slack ID** when nobody is set for the role
    (Mark: "If it needs a permission it can buzz me"), and link to the card when tethr has a
    public URL. No core files changed.

## Phase 25 decisions (Hermes is tethr's memory — 2026-11-09)

35. **tethr stays the main product; Hermes is its memory layer, on the subscription** (Mark: "I
    want to use tethr as our main thing but you can use hermes as the memory layer. We need to
    utilize it but stick with the subscription style not API for now"). Hermes stores tethr's
    notes, keeps every chat turn searchable and holds the skills tethr learns. Claude Code on the
    subscription does all the thinking. **tethr never runs a Hermes turn, so Hermes never calls a
    model**: Hermes's own Anthropic login would bill Max extra usage (Pro can't use it), and any
    other provider bills per token. Enforced, not just intended:
    - The helper calls only Hermes's data functions: the memory store, session import/rename,
      read-only search and skills.
    - It runs with an environment that holds no keys.
    - tethr's profile has no provider, `adopt_external_logins: false`, background review off and
      consolidation off.
    - `tethr-hermes.test.ts` fails on an agent entry point and asserts 0 tokens on a real Hermes.
36. **A dedicated profile per company (`tethr-<prefix>`), apart from Mark's own Hermes.** His
    Hermes runs model turns on OpenRouter/Nous, and sharing would let those turns read and
    rewrite Wandr's memory on per-use billing. tethr writes the profile folder and its config
    itself rather than using `hermes profile create`, which can seed a model from the default
    profile.
37. **Memory.md is now a read-only copy.** The chat saves with the `memory` tool (Hermes's
    entry format and checks). CLAUDE.md renders the entries every turn. Without Hermes, a
    built-in store keeps the same entries, with no search and no skills. The old free-form
    Memory.md is turned into entries once and backed up outside Drive.
38. **Indexed: the person's message and tethr's answer only.** Never tool results (raw email or
    Slack) and never private turns. An agent's recall searches only its own chats (a lead's
    also covers its sub-agents'). A recall taints the thread like a connector read.

39. **After the independent review (2026-11-09): memory changes are checked in one place, and
    nothing is dropped silently.** `changeMemory` is the only way in. A note that can't be saved
    during a switch or a migration waits on the Memory page with its reason. An agent adds notes
    and changes only its own (Hermes's rule for its own background workers). A private turn only
    reads.
40. **tethr may start Hermes's background service, and that is a switch.** A session write needs
    the service; when it's down Hermes starts it, and it then runs whatever the owner set up in
    their default profile. Default on, because a Hermes installed only for tethr has nothing else
    to run and would otherwise never index. Off for someone who stops their own Hermes on purpose.
41. **The health check is a tripwire about a person, not a word list.** The business is travel
    medicine, so health words must pass. A sentence has to tie one person (a name, "the patient",
    he/she, contact details) to a health detail. It runs on the Mac before text is saved, indexed
    or, from phase 26, sent to Jev.

42. **Only a company admin drives the chat brain from Slack** (phase 26.1). The chat brain runs
    with the admin's own claude.ai connectors, and reading with them needs no approval, so a
    teammate's Slack message would read the admin's mail and files. Teammates keep the classic
    engine until each person can have their own access.
43. **A channel never gets connector data** (phase 26.1). A Slack channel thread can be read by
    everyone in it, Slack Connect guests included. Once a chat has read a connector (or used
    recall), its answers in a channel go to the asker by DM, with a one-line note in the thread.

## Phase 26.9 decisions (the growth map — 2026-11-09)

44. **A level is evidence, never a setting.** Each of an area's six unlocks is worked out on every
    read from what exists: an audit tethr recorded (a score), a connection tethr has actually seen,
    three notes or skills, a linked goal metric, an active agent or a switched-on schedule, and a
    number on track over two measurements (or an audit up 10 points). `map_area` records an audit
    and links; nothing, tethr included, can write a level. So levels drop when the evidence does.
45. **A connector counts as connected once tethr has seen it on a real turn**, not when its mode
    merely isn't Off (Setup's checklist is looser). claude.ai connectors can't be probed headlessly,
    and "Ask" is the default for every connector, so mode alone would equip areas with tools that
    were never connected.
46. **The keyword rules are a fallback, and a tie places nothing.** tethr names the area when it
    saves a note, skill or audit; a note without one is placed only when one area's rules clearly
    win. A metric is sorted by its name and goal only (its method names the tool that measures it,
    which would pull everything toward Measurement).
47. **The map in CLAUDE.md holds only computed text** (area names, levels, unlocks, playbooks),
    never a saved note or audit summary, so nothing saved can pose as an instruction there. The
    growth_map tool returns saved text marked as data.
48. **One number or agent counts in one area, and agents only audit their own** (after the
    independent review). Links are exclusive (linking a metric or agent to an area unlinks it
    everywhere else), only tethr's own chats link or set the focus, and an agent records audits only
    for the area it's placed in. A number proves an area only once it has moved off its baseline and
    was on track at each of its last two measurements; an audit rise counts only across a week or
    more. Otherwise one on-track metric, one agent, or two audits in a row could lift the whole map.

## Phase 26.2-26.6 decisions (Jev decides, tethr files and learns — 2026-11-09)

49. **One migration for three tables** (0097), not one each as planned: they shipped together, and
    the lessons' review verdict came as 0098.
50. **The backtest is the record, not a replay.** The record never stores the content Jev judged, so
    "would have got 46 of 50 right" is how often its pick was what a person went with, overall and
    above its confidence bar. Automatic needs 20 answers and 90% right.
51. **Jev never sees what a person must see first.** A person's health details, a card number or a
    key stops a file (or a report, a Slack conversation, a lesson) on the Mac; nothing is sent.
52. **The Inbox copies chat uploads and never deletes.** "File this" sends a copy (the chat keeps
    its own); moves are `fsMove` inside 00 Tethr, never into the Inbox, the archive, the workspace or
    a hidden folder. People are told a file's name and folder, never its content.
53. **Only a person applies a lesson.** Jev scores; tethr and agents propose; the ideas pace limits
    the learner's cards; applying writes memory or a skill through the same checks as everything
    else, and retiring takes it back out.
54. **The learner works in a sealed room.** Own folder outside the Drive, no memory, no connectors,
    no team tools, no skills, no user settings (`--setting-sources project`), web search and public
    pages only; the runner's deny rules, the hook gate and the tools endpoint each enforce it.
55. **Agent reports are held only when earned.** report.urgency starts Off; on Automatic a "can wait"
    above the bar holds only the Slack DM (the card, the bell and the daily review still have it).
56. **tethr's own actions don't prove themselves.** An automatic decision counts toward its kind's
    confidence bar only after the week to undo it has passed, and a held report stays an open
    question until a person answers it on the card (independent review, 2026-11-09).

## Phase 27 decisions (first-run fixes — 2026-11-10)

57. **Setup ends in the chat.** The forms come first (company, focus, connections, rhythm, on its
    own); the goals interview is last and starting it completes setup. A setup that's "done" no longer
    waits on a Finish button, so the chat never says "finish setting up" to someone who came from it.
58. **A question is a card, and it grants nothing.** `ask` puts a yes/no or a choice in front of the
    person with buttons. The answer goes into the chat as their own message and the next turn acts on
    it; anything outward still gets its own approval card. Text on the card is plain text.
59. **A missing connection stops the agent, not the conversation.** An agent's `needs` are checked
    before any turn. Missing and not waived: no turn, nothing spent, one card with the fix. "Connected"
    is checked, not believed; a need the agent raised against something tethr thought was on is cleared
    only by a person. A lead's missing need holds its sub-team. tethr's own chat gets the card with no hold.
60. **One list of what waits on a person.** Approvals, questions and missing connections are "Needs
    you": the chat's pill, the page (the Queue, renamed, same address) and the sidebar count read the
    same route.
61. **Slack never reaches the old engine while the chat engine is on.** An unrecognised sender is told
    so. Linking a Slack account to the admin is one tap only when Slack says the account has the admin's
    email; a display name is never treated as proof (whoever is linked drives tethr as the admin).
62. **A queued message is the person's until it starts.** It can be edited (its files stay) or removed
    (the row is deleted: it never ran). Turns tethr started aren't editable.
63. **Icons follow the job** and use only core's agent icon names, so the sidebar and tethr's pages agree.
64. **No core edit to hide Paperclip's "no workspace" line.** It's in a busy upstream file; tethr's own
    line on the run page explains it.
65. **What only a person can do comes as a checklist, not prose** (Mark, 2026-11-10, after tethr explained
    in paragraphs how to set up a Google Ads campaign it couldn't create). The `checklist` tool makes a card
    the person ticks off; the last tick is sent into the chat as their message so tethr checks it took.
    It grants nothing and touches nothing outside tethr. "Not now" puts it away with a note, no turn.
66. **Playbooks are loaded, not just listed.** A small-budget ask came back as five ad groups; the paid-ads
    skill was installed but never loaded. CLAUDE.md now has a "## Playbooks" section above "Deciding"
    (installed skills per area, "load it in that turn and follow it, say which"), plus a budget-fit rule
    (a small budget or first test = one channel, one campaign, highest-intent targets, grow on results).
    An agent's identity names the playbooks for its job's area (`playbooksForJob`, the growth map's
    keyword rules). The sealed learner gets neither.
67. **Every connector can be autonomous or ask, per kind** (Mark, 2026-11-10). Under Automatic, spending,
    reaching outside people and deleting each have "Ask an admin" (the default, today's behavior) or
    "Automatic". Automatic spending needs a monthly cap that tethr checks before every call: against
    the account where it can read it (Google Ads), else against what its own calls committed this month,
    and a call with no readable amount asks. Medical always asks; ad accounts never delete. This replaces
    the fixed always-ask list for money, public and destructive, and Mercury's Auto cap.
68. **Google Ads can make changes, through the same gate.** tethr's own `ads_*` tools are the connector
    "Google Ads" (Read only by default). New campaigns start paused; turning one on or raising a budget
    is spending. A person's edit in Google Ads within 14 days makes a card instead of being undone.
    Mark's instance: Google Ads set to Automatic with spending on "Ask an admin" and no cap, his call.
69. **Settings live on each agent; a lead's cover its team** (Mark, 2026-11-10). Integrations keeps what's
    connected (Off is off for everyone) and tethr's own settings. Each agent has a mode per tool (Read only,
    Approval needed, Automatic) and the three kinds under Automatic, set in its pane. New agents start on
    Approval needed; tethr can propose modes, but anything that lets an agent do more on its own is a
    person's call (a card, or the person's own edit). Agents made before this follow tethr's settings until
    their own are set.
70. **The learner studies in sealed rooms, and private data never meets the web** (Mark, 2026-11-10: "I don't
    need a bunch of MD files. It should be observing… and applying this information in the form of skills").
    One study is three fresh, unsaved turns, each with its own folder, CLAUDE.md and tool list: plan (what's
    been happening in tethr, goals, skills, memory; no web), research (the web, and only the topic and
    questions; nothing private), apply (the findings next to what tethr knows; no web). Only the topic and
    questions cross, after a screen (no emails, links, long numbers, masked details, health details, keys,
    instructions). The runner, the hook gate and the tools endpoint read one room table (sandbox.ts).
71. **The learner applies skills itself, under that rule.** Its skills save on their own by default (Ask first is a
    setting), checked first (no instructions, health details, keys or medical claims; links only to the
    study's sources), with Undo. It changes on its own only skills it made; a change to one tethr or a person
    saved is always a card. This replaces "only a person applies" for the learner's work; lessons from tethr,
    agents and people keep their old flow.
72. **The learner watches at a pace a person sets** (Light, Steady, Aggressive or Custom: how often, how many a day,
    whether it may go deep, picky or eager). A study someone asks for skips the pace's cap but not the ceiling
    of 10 a day. What it watches is a server-built digest of people's own messages (masked), where tethr
    struggled, goals behind pace and what tethr knows: never tethr's answers, tool results or the Ideas chat.
73. **Skills work without Hermes.** The built-in memory store has a skills folder, so skill_view, skill_save and
    the learner's skills work on either store; recall still needs Hermes. Every agent can open a skill.
74. **A budget is a setting; skills are foundations.** tethr says where a figure came from, sizes plans to it and
    names the next step up; skills put numbers in tiers or ratios and never hold company figures. A "review the
    skills" job (no web) checks every skill holds as the company grows and rewrites the narrow ones.
75. **Memory has no ceiling; the notes table is the record** (Mark: "I don't want a cap like this… working for months
    and keep learning"). Every note lives in `tethr_memory_notes` (Postgres full-text search). Hermes's MEMORY.md /
    USER.md (or the built-in files) hold a curated always-loaded part; saving never fails for space, curation never
    deletes, and the notes about a message are added to its turn. Hermes still holds past conversations and skills.
    Hermes Holographic was not used: a community plugin made for Hermes agent turns, which tethr never runs.

## Core changes (keep merge-safe)

Every core file touched, with reason. Everything else Tethr lives in new files.

| File | Change | Why |
|------|--------|-----|
| `packages/db/src/schema/index.ts` | + exports for `tethr_*` schema files | barrel is the only registration point |
| `ui/src/main.tsx` | Imports `tethr-theme.css`. 2026-11-08: the service worker registers in production only; in dev it's unregistered and its cache cleared (a request that failed during a dev-server restart made it serve hours-old source modules, e.g. the old intro) | app entry is the only place both happen |
| `packages/shared/src/constants.ts` (or new `tethr.ts` + index export) | + Tethr status constants | match core enum convention |
| `server/src/app.ts` | + mount line for `tethrRoutes` + `initTethr(db)` (adapter registration) | route registration point |
| `server/src/index.ts` | + 1 line `maybeAutoSeed(db)` at startup | seeding is a boot concern, not an app-construction concern (keeps API tests clean) |
| `server/src/adapters/index.ts` | + 1 registry entry for `tethr-llm` | documented adapter seam |
| `ui/src/App.tsx` | + route entries for Tethr pages; Phase 15: `/inbox*` → redirect to `/queue` (Inbox retired — its Approve flipped the approvals row without calling `gating.decide`, so Tethr outputs never published/applied; Queue is the single approval surface) | route table |
| `ui/src/components/Sidebar.tsx` | + "Operate" nav section; Phase 12 de-dup: dropped overlapping core nav items (Runs→Routines, Costs→Budgets, Org→Company, Activity→the Tethr trail) per Mark — routes untouched, only nav links; Phase 15: Inbox nav item removed (see App.tsx row) | nav registration point |
| `ui/src/components/CommandPalette.tsx` | + page entries; Phase 15: Inbox entry removed | palette registration point |
| `ui/src/components/MobileBottomNav.tsx` | Phase 15: Inbox tab → Queue tab (same reason as the App.tsx inbox row). 2026-11-08 mobile pass: the five tabs are Chat · Growth · Queue · Drive · Issues (Home, Create and Agents stay in the drawer), since the chat is tethr's main screen and was missing from the phone bar | mobile nav registration point |
| `ui/src/components/Layout.tsx` | 2026-11-09 phone pass (Mark: "we don't need the bottom bar, the hamburger menu does just fine"): the phone bottom tabs are no longer rendered (import + render line removed) and the phone `main` bottom padding drops from 5rem (room for the tabs) to 1.5rem, both plus the safe area. The tabs' scroll-to-hide state and listener are left in place, unused, to keep the diff to three lines; `MobileBottomNav.tsx` stays as the parts bin. | phone shell |
| `ui/src/lib/company-routes.ts` | + Tethr route roots in `BOARD_ROUTE_ROOTS` | prefix resolver allowlist |
| `packages/db/src/migrations/meta/_journal.json` | + entries 0086–0089 | inherent to adding migrations |
| `server/src/services/companies.ts` | remove(): FK-order fix + routine/budget/tethr tables | pre-existing core bug (V1 log), now fixed + tested |
| `ui/src/components/BreadcrumbBar.tsx` | + `<TethrBell />` next to the theme toggle | global toolbar is the only bell mount point |
| `ui/src/styles/tethr-theme.css` | + routing-flow / stagger animation section | the brand layer is designed to be extended here |
| `ui/src/context/ThemeContext.tsx` | Smoked Glass reskin (2026-11-07): + `"system"` preference that follows `prefers-color-scheme` live; adds `preference`/`setPreference`, keeps `theme`/`setTheme`/`toggleTheme`; warm theme-color values | Mark: theme defaults to the device, with Day/Night overrides. The context is the only place the theme is resolved |
| `ui/index.html` | boot script: no stored choice (or `"system"`) → follow the OS instead of forcing dark; warm theme-color values | avoids a flash of the wrong theme before React mounts |
| `ui/src/components/BreadcrumbBar.tsx` | `ThemeToggleButton` now renders `TethrThemeSwitch` (Auto/Day/Night) | global toolbar is the only theme-control mount point |
| `ui/src/components/SidebarAccountMenu.tsx` (+ test mock) | theme item cycles Auto → Day → Night and shows the current choice | second theme control (mobile) |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/lib/company-routes.ts` | Phase 16 (2026-11-07): + `growth` route, + "Growth" nav item at the top of Operate, + `growth` in `BOARD_ROUTE_ROOTS` (one line each) | the growth board is the COO's home; same registration points as the other Tethr pages |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/lib/company-routes.ts` | Phase 17 (2026-11-07): Console renamed **Chat** (Mark's call) — `/chat` route (→ `TethrChat`), `/console` → redirect to `/chat`, nav + palette label "Chat" (nav item moved to the top group, above Dashboard), + `chat` in `BOARD_ROUTE_ROOTS` (one line each) | same registration points; the redirect keeps old links working |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CompanySettingsSidebar.tsx`, `ui/src/components/CommandPalette.tsx` | Phase 17 (2026-11-07): Memory moved off the main sidebar into Company → Settings (Mark: "for now, rework later") — route `company/settings/memory` (→ `TethrMemory`), `/memory` → redirect there, + one Settings-sidebar nav item, palette path updated (one line each) | Settings sidebar is the registration point for settings pages; the redirect keeps old links working |
| `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx` | Phase 18.4 (2026-11-07): nav + palette label "Providers" → "Integrations" (route `/tethr-settings` unchanged; one line each) | the page became the chat's connector/approval settings |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/lib/company-routes.ts` | Phase 19.2 (2026-11-07): + `environment` route (→ `TethrEnv`), "Environment" nav item under Integrations, palette entry, + `environment` in `BOARD_ROUTE_ROOTS` (one line each) | Mark asked for a Vercel-style screen to see and add .env settings; same registration points as the other Tethr pages |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/lib/company-routes.ts` | Phase 20 (2026-11-07): + `setup` route (→ `TethrSetup`), a "Set up tethr" sidebar item at the top that shows only until setup is complete (`TethrSetupNavItem`), palette entry, + `setup` in `BOARD_ROUTE_ROOTS` (one line each) | Mark asked for a proper from-scratch onboarding with real goals; same registration points as the other Tethr pages |
| `server/src/index.ts` | 2026-11-08: the startup import of `maybeAutoSeed` now comes from `./tethr/boot.js` instead of `./tethr/index.js` (same one line) | `tethr/index.ts` re-exports the whole engine, so importing it at startup loaded every Tethr table and broke core's `server-startup-feedback-export` test (it mocks `@paperclipai/db` with a partial list). `boot.ts` has no static imports beyond types |
| `ui/src/App.tsx`, `ui/src/pages/Auth.tsx` | 2026-11-08: + `<TethrStartupIntro />` beside `<OnboardingWizard />` (one line + import); the sign-in page calls `requestIntro()` when sign-in succeeds (one line + import) | Mark asked for a startup animation when signing in or opening the desktop app; App is the only root mount point, and the sign-in success handler is the only place that knows a sign-in just happened |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/lib/company-routes.ts` | Phase 26.5 (2026-11-09): + `learning` route (→ `TethrLearning`), a "Learning" nav item under Growth map, palette entry, + `learning` in `BOARD_ROUTE_ROOTS` (one line each) | the Learning page; same registration points as the other Tethr pages |
| `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/lib/company-routes.ts` | Phase 26.9 (2026-11-09): + `growth-map` route (→ `TethrGrowthMap`), a "Growth map" nav item under Growth, palette entry, + `growth-map` in `BOARD_ROUTE_ROOTS` (one line each) | Mark asked for the growth map as its own screen; same registration points as the other Tethr pages |
| `ui/src/components/SidebarAgents.tsx` | Phase 18.1 follow-up (2026-11-07): the sidebar agent list also hides agents whose `pauseReason` starts with "archived" (the fresh-start archive), not just terminated ones (one line) | Mark still saw the 9 archived specialists in the sidebar; the Company page's Archived group is where they live now and where Restore is |
| `ui/src/App.tsx` | Phase 27 (2026-11-10): the two root redirects go to `chat` instead of `dashboard` (one word each), and `<TethrFirstRunToSetup />` sits beside `<TethrStartupIntro />` (one line + import) | the app opens on tethr's chat; a first run reaches setup from any page |
| `ui/src/components/SidebarAgents.tsx` | Phase 27: the list renders through `lib/tethr-agent-tree.ts` (a lead's sub-team nests under it and folds); `SidebarAgentItem` takes `depth` and `fold` | the only place the sidebar's agents are drawn; flat as before when nobody has a sub-team |
| `ui/src/components/Sidebar.tsx`, `ui/src/components/CommandPalette.tsx`, `ui/src/components/MobileBottomNav.tsx` | Phase 27: "Queue" → "Needs you" (the sidebar item is `<TethrNeedsYouNavItem />`, which carries the count) | one name for what waits on a person |
| `ui/src/components/Sidebar.tsx` | Phase 27 follow-up (2026-11-10): the "New Issue" button at the top is removed and "Needs you" moves up, right under Chat and above Dashboard | the chat is the main way in (Mark); New issue stays in the command palette and on the Issues page |
| `ui/src/components/SidebarAccountMenu.tsx` | 2026-11-09: + `<DesktopTerminalButton />` beside the account button (the row becomes a flex row; the account button keeps the remaining width). The icon renders only inside the Tethr desktop app and only asks the app to show or hide its terminal panel | Mark asked for "a small icon at the bottom" to open a terminal inside the desktop app; the account row is the sidebar's bottom edge |
| `.gitignore` | + `.tethr-data/` | local data dir |
| `.env.example` | + Tethr vars (commented, blank) | 12-factor |
| `README.md` | + a 5-line fork banner above the upstream header pointing at `TETHR-ENGINEERING.md` + `CLAUDE.md` | an engineer landing on the repo has to be told this is a fork and where the map is; upstream's README body is untouched below it |

Verified with `git diff --diff-filter=M --stat 436dc2b7..HEAD`: 12 modified files,
230 insertions / 1 deletion — everything else is new files.

(Reskin-era copy edits across pages predate this build and are documented in BRANDING.md.)

## Assumptions

- "Task board" DoD item is satisfied by core Issues (hierarchical, statuses, assignees) —
  surfaced from Tethr nav; no parallel task system built.
- Core `Approvals`/`Activity`/`Costs` pages remain; Tethr's Queue/Audit/Budgets pages are
  the product surfaces over the same data + Tethr gating data.
- The bundle's `wandr-destination-brief` skill is missing upstream (flagged in bundle);
  Compass runs against a mock brief generator in the LLM provider — noted, not a blocker.
- Google Ads MCP / Chrome action layer are laptop-bound per handoff.md → Tailwind stays
  recommendation-only with hard spend gates in this build.
- Heartbeat cadences map 1:1 from manifest cron strings into core routines. They seed
  `active` (matching production-enabled workflows) except Sonar, which seeds `paused`
  exactly as in production since 2026-03-25. Active routines run the mock provider on
  their schedule — a live company, with gated work stopping in the Queue.
- Upstream bug observed (not fixed, to stay merge-safe): core company `remove()` deletes
  `heartbeat_runs` before `cost_events` and predates routines/budget-policy tables, so
  deleting a company with cost-linked runs fails on FK order. Tethr tables all cascade
  on company delete (migration 0087) so they never add to the problem.
- Pre-existing test failure (verified on baseline 436dc2b7 in a clean worktree):
  `server/src/__tests__/heartbeat-comment-wake-batching.test.ts` — two 90s-timeout
  cases fail before and after this build identically. Final state: server suite
  1814 passed / 2 pre-existing failures; Tethr suite 10/10; UI 987/987; shared+db green.
