# Phase 6 — Memory upgrade (dedupe now, graph decision later)

**Objective:** Make the existing keyword memory layer actually prevent the founding-doc failure mode (re-suggesting already-published articles/photos), and produce a grounded recommendation for Frank on whether/when to add embeddings or a graph layer.

**Definition of done:** Published-content memory is seeded from the blueprint and updated automatically on every publish-type output; routing consults it before content tasks (a duplicate-topic request gets flagged, with a test proving it); `docs/adr/0002-memory-architecture.md` records the embeddings/graph decision for Frank.

**Prerequisites:** Phase 3 (live runs producing outputs). Complements Phase 5 — do after the first content workflow (Atlas) migrates, so there's something real to dedupe against.

**Estimate:** 2–3 sessions.

---

## Prompt 1 — plan (paste into Claude Code)

> Enter plan mode. Read CLAUDE.md, server/src/tethr/memory.ts, the `tethr_memories` schema in packages/db/src/schema/, server/src/tethr/routing.ts, and the seed corpus at `My Drive/tethr/shared/memory-published-articles.md` (read-only).
>
> Three deliverables:
>
> 1. **Seed:** an idempotent script (`scripts/tethr-seed-memory.mjs`) that loads every published article/itinerary/brief title+slug+date from the blueprint's memory-published-articles.md into `tethr_memories` as company-scoped `published-content` records with a stable fingerprint format (type:slug).
> 2. **Write path:** whenever an agent output passes its approval gate as "published", record a matching memory automatically (find the right hook — gating.ts approval transition or worker.ts completion).
> 3. **Read path:** before routing a content-creation task (blog/brief/itinerary), recall against the proposed topic; on a hit, don't block — attach a "possible duplicate of <slug> (published <date>)" warning to the task and include it in the Slack notification. Add a unit test: seeding a known article then requesting the same topic must produce the warning.
> 4. **ADR for Frank:** given the corpus size you observe (hundreds of items, not millions), write `docs/adr/0002-memory-architecture.md` assessing honestly whether keyword `ilike` recall is sufficient at this scale, what concrete failure would justify pgvector embeddings (available on Railway Postgres — verify), and what would justify a graph DB. Recommendation, not hedging — Frank decides from it.
>
> Write the plan to `tasks/phase-6.md` with per-step verification and stop for approval.

## Prompt 2 — execute *(after approving the plan)*

> Execute the approved plan in tasks/phase-6.md. Verify: seed script run twice produces no duplicates (show counts); the dedupe unit test passes in `pnpm test`; one manual end-to-end demo — request a blog task on an already-published topic and show me the warning in the queue/notification. Update CLAUDE.md (memory conventions, fingerprint format, seed command). Commit on `tethr-buildout` and stop.

## Checkpoint for Mark (phone)
Open `<railway-url>` Memory page: published-content records are visible and searchable. The demo duplicate-topic warning is in #scout or the notification bell. Send Frank the ADR link. Two minutes.

## Rollback
Memory writes are additive rows; the routing warning is advisory (never blocks). Disable by removing the recall hook — a one-commit revert. No live workflow depends on it.
