# Phase 5 — Migrate live workflows off the laptop (one at a time)

**Objective:** Move the four active laptop workflows (blog writer, destination-brief-auto, itineraries, analytics-weekly) plus the two paused ones (lead-scout, image-health-check) from Cowork scheduled tasks + Drive into Tethr heartbeats — one workflow at a time, with a parity gate before each laptop cron is retired.

**Definition of done:** All four active laptop crons are disabled; the equivalent Tethr heartbeats have each produced ≥3 consecutive outputs that Mark judged at parity; the live Drive engine at `05 Marketing /Claude Marketing/` is untouched (read as reference only, never edited).

**Prerequisites:** Phases 2 and 3. Port order (from the blueprint, confirmed by discovery): **1) Sonar/lead-scout, 2) news-scan, 3) image-health-check, 4) Atlas/blog-writer, 5) Compass/destination-brief-auto, 6) Voyager/itineraries. Tailwind+Ledger (ads) are EXCLUDED from this phase** — their Google Ads MCP auth + Chrome action layer are unsolved for headless; do not attempt.

**Estimate:** 6–8 sessions (roughly one per workflow; blog/briefs/itineraries are the heavier ones).

**Budget guardrails:** per seeded caps in `server/src/tethr/seed/wandr-growth.ts` (Sonar $100, Atlas $200, Compass $150, Voyager $150/mo). No cap raises in this phase.

---

## Prompt 1 — run once per workflow, substituting the bracketed slot (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, the agent's spec in server/src/tethr/seed/wandr-growth.ts, its ROLE.md and skill under the Drive blueprint (`My Drive/tethr/agents/helm/[AGENT]/` and `My Drive/tethr/skills/wandr/[SKILL]/` — read-only), and `My Drive/tethr/engine-inventory.md` for the workflow's trigger/inputs/outputs/sensitivity row.
>
> Migrate the **[WORKFLOW NAME]** workflow ([current schedule], currently a Cowork scheduled task on my laptop) into Tethr:
>
> 1. Implement it as the corresponding agent's heartbeat task, executing the existing skill logic — orchestrate the skill's instructions, do NOT rewrite its content logic (no-duplicate-logic rule). Where the skill assumes Drive paths for output, write to Tethr Drive (`server/src/tethr/drive.ts`) instead, same folder semantics (Drafts/, Published/).
> 2. Preserve the human gate exactly as the ROLE.md defines it (e.g. Atlas: draft → Slack Publish/Reject, never auto-publish; anything touching medication/medical content routes to human review via gating.ts — hard gate, not advisory).
> 3. Honor known content rules from the blueprint's shared memory: no "delivered to your door"/shipping language (Wandr stopped shipping May 2026), azithromycin is never called "Z-Pak", brief pricing $89/$129 for new briefs, only the 11-med catalog. These live in the skill/ROLE files — confirm they're in the agent's context, don't hardcode them.
> 4. Run it once manually (heartbeat disabled) and place the output side-by-side with the most recent laptop-produced equivalent from `05 Marketing /Claude Marketing/` (read-only reference) — I'll judge parity.
> 5. Only plan the enable-heartbeat + retire-laptop-cron steps as instructions for me; you never touch the laptop or the live Drive engine.
>
> Write the plan to `tasks/phase-5-[agent].md` with per-step verification and stop for approval.

## Prompt 2 — execute *(after approving each plan)*

> Execute the approved plan in tasks/phase-5-[agent].md. After the manual run, stop and show me: the output in Tethr Drive, the cost, and the diff-in-spirit vs the laptop's latest equivalent output (a subagent can do the comparison read). Do not enable the heartbeat until I say the output is at parity. When I confirm, enable the heartbeat, tell me exactly which Cowork scheduled task to pause on my laptop, and update CLAUDE.md's migration table (workflow → status → date).

## Parity + retirement gate (per workflow)
Three consecutive scheduled outputs at parity → Mark pauses (not deletes) the laptop cron → one more week of Tethr-only output → laptop cron stays paused permanently. **Never delete the laptop task or any Drive content.**

## Checkpoint for Mark (phone)
Per workflow: the Slack notification for the Tethr-produced draft arrives on schedule; open the draft link; it reads like the laptop version. The CLAUDE.md migration table (viewable on GitHub mobile) shows the workflow's status.

## Rollback
Per workflow, instant: pause the Tethr heartbeat, resume the paused Cowork scheduled task on the laptop. Both systems write to separate locations, so no data conflict. This is why crons are paused, never deleted.
