# ADR 0002 — Tethr memory architecture (keyword vs embeddings vs graph)

**Status:** Accepted (v1) · **Date:** 2026-07-09 · **Author:** Claude Code (for Frank to decide the next step)
**Context:** Phase 6 of the Tethr buildout. See `docs/tethr-buildout/phase-6.md`.

## Decision

**Keep keyword (`ilike`) recall for v1. Do not add embeddings or a graph DB yet.** Revisit
only when a concrete, measured failure below appears.

## Context

`tethr_memories` recall is SQL `ilike '%query%'`, company + agent scoped, recency-ordered
(`server/src/tethr/memory.ts`). Phase 6 layered a **published-content** dedup on top: every
publish records a fingerprinted memory (`gating.ts`), a backfill script seeds the blueprint
corpus, and routing warns on a duplicate-topic content request
(`server/src/tethr/published-memory.ts`). The dedup match is slug overlap + significant
title-word overlap — deterministic and explainable.

The corpus is **hundreds of items** (articles + briefs + itineraries accumulated over a couple
of years), not millions. Recall runs on indexed columns (`company_id, created_at`) over a small
table.

## Why keyword is sufficient at this scale

- **Volume.** Hundreds of rows. `ilike` over that is sub-millisecond; there is no performance
  problem to solve.
- **The failure mode it must prevent is narrow.** "Don't re-suggest an already-published
  article" is a *title/topic* match, not open-ended semantic retrieval. Slug + word overlap
  catches the realistic cases (same destination + same subject) and is auditable — a human can
  see exactly why something was flagged, which matters for an advisory warning.
- **Cost & moving parts.** Embeddings add an API call per record + per query, a vector column,
  and a similarity index. A graph DB adds a whole datastore to run, back up, and migrate. Both
  are real operational weight for a solo, part-time operator.

## What would justify **pgvector embeddings**

Add embeddings when keyword recall **misses in practice** — specifically, when we observe the
duplicate-warning failing on **paraphrase/synonym** topics it should catch (e.g. "high-altitude
sickness in the Andes" vs a published "Peru Altitude Guide" that shares no keywords), OR when
agents need genuine *semantic* recall of past work (not just dedup). Railway Postgres supports
the `pgvector` extension (verify the plan's extension allowlist at deploy time), so this is an
in-place upgrade: add an `embedding vector(N)` column, backfill, and switch recall to a cosine
KNN with the keyword path as a cheap prefilter. Trigger metric: **>~10% of content tasks that
were true duplicates went unwarned** in a month of real runs, traced to vocabulary mismatch.

## What would justify a **graph DB**

Only if the memory need shifts from *recall* to *relationships* — e.g. "which briefs cite which
sources," "what content targets which ICP/destination cluster," multi-hop questions across
entities. That is Frank's original graph-layer idea, and it solves a different problem than
dedup. **Do not adopt it for dedup.** Trigger: a concrete product requirement for multi-hop
entity queries that SQL joins over `tethr_*` tables can't answer cleanly.

## Recommendation for Frank

Ship v1 keyword dedup (done). Instrument it: log every duplicate warning and, when Mark
overrides one as a false negative, capture the pair. After ~1 month of live content runs, review
the misses. If they cluster on vocabulary mismatch → do the pgvector upgrade (small, in-place).
If they don't → keyword is fine and the graph layer stays deferred until a real relationship-query
requirement shows up. Decide from the logged data, not from first principles.
