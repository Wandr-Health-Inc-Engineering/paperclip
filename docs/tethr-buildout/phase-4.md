# Phase 4 — The V1 recommendation loop (auditor → #scout → @Cursor → PR)

**Objective:** Stand up the V1 definition-of-done from the brief: an agent notices a non-medical, non-PHI issue on travelwithwandr.com's public surface, posts a structured recommendation to #scout, a human tags `@Cursor` in-thread, Cursor opens a PR, humans merge. Nothing auto-merges.

**Definition of done:** At least one real finding (SEO meta / tracking event / schema / obvious UI bug) has traveled the full loop: heartbeat run → structured #scout post → in-thread `@Cursor` fix instruction → GitHub PR → human review/merge. The auditor runs on a schedule with a stated budget cap.

**Prerequisites:** Phases 2 (Slack + recommendation format) and 3 (live LLM + budget discipline). Cursor's Slack integration installed in the workspace and connected to the website repo (Mark: Cursor dashboard → Slack integration → default repo `Wandr-Health-Inc-Engineering/<website repo>`; ~10 min; this is Cursor's native feature — we build nothing for it).

**Estimate:** 3–4 sessions.

**Budget guardrail:** the auditor lives under the Reliability division with its own new agent budget — $20/mo cap, daily heartbeat, hard-stop on cap.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, docs/adr/0001-tethr-buildout-decisions.md, server/src/tethr/seed/wandr-growth.ts (agent + subagent shape), server/src/tethr/tools/web.ts (live fetch), server/src/tethr/notify.ts and the recommendation builder from Phase 2, and server/src/tethr/worker.ts (heartbeat execution).
>
> I want a **Site Auditor agent** in the Reliability division (currently a shell — activate it):
>
> 1. **Agent definition** (additive, same pattern as the seeded Growth agents): codename **Sentry**, division Reliability, budget cap $20/mo, daily heartbeat. Scope allowlist — public pages of travelwithwandr.com only, read-only fetch. Checks, v1: (a) missing/duplicate/too-long meta titles+descriptions on a fixed page list (home, /destinations/*, /travel-medicine/*, /blog latest 10); (b) missing or malformed JSON-LD (FAQPage/MedicalWebPage/Article presence where expected); (c) broken internal links (404s) on those pages; (d) GA4/GTM tag presence in page source (`G-WP11MQFLQ5`, `GTM-N7K829F8` — these are the real IDs, treat absence as a finding). Explicitly OUT of scope: anything behind auth, anything clinical/PHI, medication content correctness (that's a licensed-human domain — findings about medical *content* are forbidden; structural/technical only).
> 2. **Dedupe:** before posting, check `tethr_memories` (server/src/tethr/memory.ts) for the same finding fingerprint (page+check-type); record every posted finding. No repeat posts for 14 days unless the finding changed.
> 3. **Posting:** each finding → one #scout message in the Phase 2 recommendation format, including the affected URL and, where inferable from the public site structure, the likely file path in the website repo, plus the "reply and tag @Cursor" footer. Cap: max 3 findings per day (highest severity first) so the channel stays reviewable by a tired person on a phone.
> 4. **The fix loop itself is Cursor's native Slack integration — build nothing for it.** Just confirm the message format leaves the thread usable for `@Cursor` (plain text file paths, no formatting that breaks copy).
>
> Write the plan to `tasks/phase-4.md` — exact files, order, verification per step (unit tests for each check against fixture HTML in server/src/tethr/tools/fixtures/; one manual full run against the live site with heartbeat disabled). Stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-4.md. Verify: `pnpm test` green including the new fixture tests; then one manually-triggered full audit run against the live site — show me the findings it *would* post before enabling Slack posting; I'll approve the batch; then post them and enable the daily heartbeat with the $20 cap.
>
> Update CLAUDE.md (Sentry's scope, how to pause its heartbeat, the dedupe window) and DECISIONS.md if core was touched. Commit on `tethr-buildout`. Stop after the heartbeat is enabled — do not create more auditors.

## Checkpoint for Mark (phone)
Next morning: #scout has ≤3 Sentry findings in the standard format. Pick one real one, reply in-thread: `@Cursor fix this — <one sentence>`. Cursor's PR link appears in the thread. Open the PR on GitHub mobile, review, merge if right. That merged PR **is** V1 done.

## Rollback
Pause Sentry's heartbeat in the Tethr UI (or set its budget cap to 0 — hard-stop). No production system depends on it. Cursor PRs are just PRs — close unmerged ones.
