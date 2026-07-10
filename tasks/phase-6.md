# tasks/phase-6.md — Memory upgrade (published-content dedupe)

**Branch:** `tethr-buildout` · **Status: built + tested 2026-07-09. Corpus backfill is a 1-line manual step.**

Objective: make the keyword memory layer actually prevent the founding-doc failure mode —
an agent re-suggesting an already-published article/brief/itinerary — and give Frank a grounded
embeddings/graph recommendation.

## What was built (all additive Tethr files)

1. **`published-memory.ts`** — the dedup module: stable fingerprint
   (`published-content:kind:slug`, stored inside memory content since `tethr_memories` has no
   key column), `slugify`, a heuristic corpus parser (`parsePublishedCorpus` — markdown lists,
   section-kind hints, links, dates), duplicate matching (`isDuplicateTopic` = slug overlap or
   significant title-word overlap), and DB helpers (`recordPublished` idempotent,
   `publishedDuplicateWarning`).
2. **Write path** — `gating.ts` `publishToDrive` now also records a **company-scoped**
   `published-content` memory on every publish (alongside the existing tracker log). So the
   memory stays current automatically; the seed script is only the initial backfill.
3. **Read path** — `routing.ts` `routeRequest`: on a content-creation request
   (`isContentRequest`), it recalls published-content and, on a match, fires an advisory
   "Possible duplicate content topic" notification (fans out to #scout). **Never blocks** —
   guarded with `.catch()` so a memory hiccup can't fail a route.
4. **Seed** — `POST /api/tethr/:companyId/seed-memory` parses a corpus (body `{corpus}` or
   server-side `TETHR_MEMORY_SEED_PATH`) and idempotently records each item;
   `scripts/tethr-seed-memory.mjs` reads the file and posts it. Re-running skips existing
   fingerprints.
5. **ADR** — `docs/adr/0002-memory-architecture.md`: keep keyword recall for v1; the concrete
   measured failure that would justify pgvector (Railway-supported) vs. a graph DB, for Frank.

## Tests

`tethr-published-memory.test.ts` (6): fingerprint/encode-decode round-trip, corpus parsing,
duplicate detection (a same-topic request is flagged; an unrelated one is not — the DoD's
"a test proving it"), content-request detection. Full Tethr e2e still green (the routing/gating
hooks run in it). `pnpm test` → 23 green here; server typechecks.

## Manual step (backfill the corpus)

The blueprint corpus `My Drive/tethr/shared/memory-published-articles.md` isn't on the build
machine, so the initial backfill is Mark's one-liner once the server is deployed:

```
TETHR_COMPANY_ID=<wandr-growth-id> TETHR_BASE_URL=https://<railway-url> \
  node scripts/tethr-seed-memory.mjs /path/to/memory-published-articles.md
```

(Or set `TETHR_MEMORY_SEED_PATH` on the server and POST `/seed-memory` with an empty body.)
Every publish after that self-records — no re-run needed unless backfilling more history.

## Rollback

All additive: the warning is advisory (never blocks); disable by removing the routing recall
call (one-commit revert). Memory writes are additive rows. No live workflow depends on it.
