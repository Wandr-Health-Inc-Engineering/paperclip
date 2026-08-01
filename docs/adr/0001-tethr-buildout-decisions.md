# ADR 0001 — Tethr buildout decisions

**Status:** Accepted · **Date:** 2026-07-09 · **Deciders:** Mark
**Context source:** `docs/tethr-buildout/00-current-state-and-gap-analysis.md` (Stage A discovery), resolved open questions §7.

These are the standing decisions that shape every phase of the Tethr buildout. They
supersede the original brief where they disagree (discovery is 7 weeks ahead of the brief).

---

## 1. Hosting: Railway-first; Azure preserved

**Decision.** Deploy the Tethr server + Postgres (and later the Command Center service) to
**Railway**. Use **Vercel** only if/when a standalone dashboard frontend is split out
(Paperclip needs a persistent server, so Vercel is wrong for the backend regardless).

The repo's `terraform/` provisions a full **Azure** estate (Container App codename "scout",
Azure PostgreSQL Flexible Server, storage, managed identity, Key Vault
`wandrhealth-admin-keys`, ACR `wandrapps`) — Tethr was pointed at Wandr's existing Azure.

**Consequence.** `terraform/` **stays in-repo, untouched**, as the documented future
migration path. Railway is chosen for cost/speed now; a later move to Azure (to sit next to
the clinical platform's ops maturity) remains open. Nothing is deleted.

**Alternatives rejected:** Azure-now (heavier, slower to first-live for a solo part-time
builder); Vercel-for-backend (wrong — needs a persistent server).

## 2. Scout: migrate, don't rebuild — with a fallback

**Decision.** The existing Scout Slack bot (per discovery, a sibling repo `../scout`) is to
be **migrated** into Tethr as its inbound command surface, not rebuilt.

**Amendment 2026-07-09 (execution).** `../scout` **is not present on the build machine**
(see `docs/tethr-buildout/scout-audit.md`). Phase 2 therefore builds the inbound Slack
surface **fresh** on the `notify.ts` / new `slack.ts` seam (the phase file's documented
fallback). If the repo turns up later, re-run the audit and reuse working code. Outbound
senders (Phase 2 half 1) are unaffected.

## 3. V1 scope: distribution agents **plus** the internal error-patching loop

**Decision.** V1 is the seeded distribution org **and** the internal error-patching
recommendation loop: an agent flags a non-medical, non-PHI issue → structured `#scout`
post → human tags `@Cursor` in-thread → Cursor opens a PR → humans merge. **Internal-only,
never customer-facing** — so it does not breach the SaMD boundary. Nothing auto-merges.

**Consequence.** The **Reliability** shell division is activated in Phase 4 (agent "Sentry",
public-site technical audit) and extended in Phase 8 (agent "Pulse", PostHog-driven). Both
carry explicit budget caps ($20/mo each) and post through the same standardized format.

## 4. Live laptop engine: retired workflow-by-workflow in Phase 5

**Decision.** The production marketing engine at `05 Marketing /Claude Marketing/` (+ Cowork
scheduled tasks) is **never edited**. In Phase 5 each active cron is reproduced as a Tethr
heartbeat, judged at parity by Mark over ≥3 consecutive outputs, then the laptop cron is
**paused (never deleted)**. Port order: Sonar → news-scan → image-health-check → blog
(Atlas) → briefs (Compass) → itineraries (Voyager). **The Tailwind/Ledger ads pair is
excluded** until the Google Ads MCP auth + Chrome action layer is solved for headless.

## 5. Standing hard boundaries (unchanged, restated)

PHI/clinical systems untouched; internal-only output; compliance gate (`gating.ts`) stays
hard for `medical`/`public`/`spend`/`pr`; brand lock via `brand.ts` + `tethr-theme.css`
only; per-agent budget caps on every autonomous phase; secrets never committed; nothing
auto-merges/auto-publishes; `terraform/` and the live Drive engine are read-only.

## 6. Merge-safety

Paperclip core stays merge-safe: additive files under `server/src/tethr/`,
`ui/src/pages/tethr/`, `packages/db/src/schema/tethr_*`. Any core-file touch is a one-liner
logged in `DECISIONS.md`. This preserves the ability to keep merging from `upstream`.

---

Future ADRs: `0002-memory-architecture.md` (Phase 6, embeddings/graph decision for Frank).
