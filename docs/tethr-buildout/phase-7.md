# Phase 7 — Command Center → cloud

**Objective:** Move the Wandr Social Command Center off localhost:4747 onto Railway with auth and Postgres, preserving its Reddit/Instagram semi-automated workflows exactly, and restyling to the Tethr brand spec.

**Definition of done:** Command Center loads at a real URL from Mark's phone behind a login; the Reddit tracker (spotted/replied/no_response_needed) and Instagram 90-day calendar + one-tap-approve flows work; data migrated from `data.db` with zero loss; the laptop instance still runs until Mark retires it.

**Prerequisites:** Phase 1 (Railway project exists). Independent of phases 2–6 — can run in parallel. **Decision embedded below:** Instagram publishing stays "generate → one-tap approve → Mark posts manually" for now; the Graph API path (Business account + linked FB Page + app review) is deferred to its own future phase — don't build it here.

**Estimate:** 4–5 sessions.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. This phase works on the Command Center app, currently at `My Drive/05 Marketing /Command Center/` (note the trailing space in "05 Marketing ") — `server.py` (~45KB, Python 3 stdlib http.server + sqlite3, zero deps), `static/` (vanilla index.html/styles.css/app.js), `data.db` (SQLite, 6 tables: content_items, reddit_log, instagram_log, reminders, metrics_snapshots, meta). Delegate a full read of server.py and app.js to a subagent first; I want every API route and workflow catalogued in the plan.
>
> Migration requirements:
>
> 1. **Repo home:** copy (never move — originals stay in Drive untouched) the app into `apps/command-center/` in this repo, as a separate Railway service. Keep the Python-stdlib philosophy unless the subagent read shows a hard blocker; do not rewrite in Node for its own sake.
> 2. **Database:** Postgres (same Railway instance, separate schema `command_center`) replacing SQLite — the single-writer/Drive-sync constraint that forced SQLite's design disappears in the cloud. Write a one-shot migration script that imports my current `data.db` and verifies row counts per table match.
> 3. **Auth:** minimal and real — single shared password + long-lived session cookie over HTTPS (env var `CC_PASSWORD`), rate-limited login. No user system yet (Phase 9 adds proper access control). Phase 2 of the old README wanted phone-on-wifi access; this replaces it properly.
> 4. **Calendar sync:** the app currently syncs from Drive folders (`../Reddit`, `../Instagram/90 Day Calendar`). Cloud version can't read Drive directly — replace with an upload/import endpoint + a documented weekly manual import step for me (keep it dumb; a Drive API integration is future work, note it in the plan's later-list).
> 5. **Instagram:** keep the existing flow — calendar, captions, one-tap "mark posted", live public profile stats fetch. Do NOT build Graph API publishing.
> 6. **Brand pass:** restyle static/ to the Tethr spec — Urbanist + JetBrains Mono, pure black and white, 2px borders, no gradients, no color accents, minimal wireframe aesthetic (reference `ui/src/styles/tethr-theme.css` for the exact values). Function unchanged.
>
> Write the plan to `tasks/phase-7.md` — exact files, order, per-step verification (local run against local Postgres; migration script row-count assertions; a click-through checklist of every workflow) — and stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-7.md. Verify each step as planned; pause for me at (a) the data.db import — I'll hand you a fresh copy of the file, and you show me matching row counts; (b) Railway service creation commands; (c) the final click-through. Update CLAUDE.md (Command Center service, env vars, weekly import step). Commit on `tethr-buildout`. Stop after deploy verification — I decide when the laptop instance retires.

## Checkpoint for Mark (phone)
On your phone (this is the app's whole point now): log in at the new URL, see your real Reddit tracker with current statuses, open the IG calendar, mark one test item posted, confirm it moved. Compare a couple of numbers against localhost:4747. Two minutes.

## Rollback
The laptop app keeps running throughout — it IS the rollback. Nothing in Drive is modified (copies only, per the standing rule). If the cloud version misbehaves, ignore it and keep using localhost:4747; the migration script can re-import a fresh data.db any time.
