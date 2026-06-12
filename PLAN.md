# Tethr local end-to-end — build plan

> Living checklist for the BUILD-PROMPT-fable5 build. Branch: `mark-sandbox`, local only, never pushed.
> Spec bundle: `~/…/My Drive/tethr` (read-only). Product: this repo (Mark's Paperclip fork = Tethr).

## Architecture in one paragraph

Paperclip core already supplies companies, agents (with `reportsTo`), heartbeat runs, cron
routines, approvals, budget policies, cost events, activity log, and a `StorageService`
(local-disk / S3). Tethr is built as additive modules on top: new `tethr_*` tables
(divisions, subagents, route runs, drive nodes/versions, gated outputs, memories,
notifications), a `server/src/tethr/` service layer (LLM provider, routing engine, drive,
gating/publish, seed importer), one new server adapter (`tethr-llm`) registered through the
documented adapter seam so heartbeats/routines/costs flow through existing machinery, one
new route module mounted in `app.ts`, and new UI pages under `ui/src/pages/tethr/` using the
existing tethr brand system. Core file touches are one-liners, logged in DECISIONS.md.

## Phases

- [x] 0. Recon — repo, brand system, bundle, server/db/ui internals
- [x] 1. PLAN.md + DECISIONS.md committed
- [x] 2. Data layer — `tethr_*` schema files + shared constants + generated migration
- [x] 3. Tethr server core — `server/src/tethr/`
  - [x] LLMProvider interface; ClaudeProvider (if `ANTHROPIC_API_KEY`), MockProvider (deterministic)
  - [x] Routing engine — classify/route/do over seeded routing tables; every hop audited
  - [x] Drive service — folders/files/versions/tags/permissions over `StorageService`
  - [x] Gating service — gated outputs hard-blocked behind approvals; publish only after approve
  - [x] Memory + notifications services
- [x] 4. `tethr-llm` adapter registered (heartbeats execute the routing loop)
- [x] 5. Seed importer — Wandr Growth company from the bundle manifest
  - CEO → Helm → 8 agents → 22 subagents; Growth division active, Engineering / Reliability /
    Customer Feedback divisions as ready-to-fill shells; routines from cron cadences; budget
    policies; rich demo data (runs, gated outputs, notifications, memories, drive files)
- [x] 6. API routes — `server/src/routes/tethr.ts` mounted in `app.ts`
- [x] 7. UI screens (all wired, premium, light+dark, mobile)
  - [x] Company — CEO → divisions → agents → subagents (status, last run, budget, approvals)
  - [x] Console — Helm chat with visible routing hops (hero screen)
  - [x] Queue — gated outputs: preview, approve / reject / request changes, reviewer + reason
  - [x] Drive — folders, versions, tags, permissions, markdown preview
  - [x] Runs — schedule view from cron + history + run now
  - [x] Budgets — per-agent caps, combined growth line, spend over time
  - [x] Audit — filterable: routes, runs, outputs, approval decisions
  - [x] Tethr agent detail — role, routing table, subagents, recent runs, outputs, budget
  - [x] Settings — provider statuses, env summary, vendored Paperclip SHA
  - [x] Sidebar section, command palette entries, motion polish, mobile pass
- [x] 8. Sonar end-to-end proven (heartbeat → leads → reply → gate → approve → publish → audit)
- [x] 9. Tests — routing, gating, drive versioning, sonar loop integration
- [x] 10. Docs — RUN.md, ARCHITECTURE-LOCAL.md, MIGRATION-NOTES.md
- [x] 11. Screenshots — `~/Desktop/tethr-screenshots/` with 00-INDEX.md, light + dark
- [x] 12. Final DoD self-review (BUILD-PROMPT §8)

## Definition of done (mirror of BUILD-PROMPT §8)

- mark-sandbox only, zero pushes
- Core touches minimal + logged
- Existing brand system only
- One command up; seeded company visible (Growth full, shells present)
- Helm console routes to correct subagent and returns result
- Sonar end-to-end with hard gate + audit
- All 10 screens real and wired; premium in light and dark
- DB/storage/LLM/notifications behind interfaces; MIGRATION-NOTES.md explains swaps
- .env.example present, no secrets, .tethr-data gitignored
- Screenshot folder complete with index
