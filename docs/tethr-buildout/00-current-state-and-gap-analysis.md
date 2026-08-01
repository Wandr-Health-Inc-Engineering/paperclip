# Tethr — Current State & Gap Analysis

**Stage A deliverable · 2026-07-09 · Discovery by Claude (Cowork), for Mark**
**Status: awaiting Mark's confirmation before any Stage B phase prompts are written.**

Sources audited: the `paperclip` repo (branch `mark-sandbox`), Drive `/tethr/` blueprint folder (Jun 10–18), Drive `05 Marketing /Claude Marketing/` (the live engine), Drive `05 Marketing /Command Center/`, the skills library, and Drive-wide searches for founding docs, Scout, and Slack bot code.

---

## 1. Headline finding: the brief is ~7 weeks behind the repo

The brief assumes Tethr is early scaffold plus "some UI work." Discovery says otherwise: **Tethr V1 (12 phases) and V2 (6 phases) are marked complete in `PLAN.md`**, with real implementation throughout. Where the brief and reality disagree, reality wins — the contradictions are listed in §4 and they materially reshape the roadmap. Most of the brief's suggested Phase 1 ("core orchestration engine") and much of its UI work **already exist**. The remaining work is almost entirely: deployment, live integrations (Slack/LLM/senders), migration of the live laptop engine, and the V1 recommendation loop.

## 2. What exists (verified)

### 2.1 The repo — a mature, merge-safe Paperclip fork
- Fork of upstream: `origin` = `github.com/Wandr-Health-Inc-Engineering/paperclip`, `upstream` = `github.com/paperclipai/paperclip` (~250 upstream branches tracked). Active branch `mark-sandbox`; last commits Jun 12, 2026 ("tethr v2: …").
- **Layered exactly per the Chrome-on-Chromium vision**: L0 Paperclip core untouched except 12 files / ~231 lines (logged in `DECISIONS.md`, one substantive fix — company `remove()` FK ordering — is upstreamable). L2 Tethr layer = `server/src/tethr/` (23 modules: `routing, worker, gating, drive, org, memory, notify, digest, state, export`, `llm/`, `tools/`, `seed/`).
- **UI: done and on-brand.** 10 Tethr pages (`ui/src/pages/tethr/`: Console, Company, Queue, Drive, Runs, Budgets, Audit, AgentPage, Settings, Memory) + `RouteFlow`, notification bell. `ui/src/styles/tethr-theme.css` implements the locked brand: Urbanist + JetBrains Mono, pure black/white, light+dark+mobile. The brief's "any UI work must state the brand spec" is already satisfied by the theme layer — future prompts will still restate it.
- **Data:** Postgres via Drizzle (SQLite explicitly rejected, `DECISIONS.md` #2). Embedded Postgres in dev; `DATABASE_URL` swap for cloud. 8 `tethr_*` tables, migrations through 0089.
- **Org chart: seeded and fine-tuned.** Company "Wandr Growth": CEO (placeholder) → **Helm, Chief Growth Officer** → 8 codename agents (**Atlas** content/SEO, **Compass** briefs, **Voyager** itineraries, **Sonar** scout/leads, **Tailwind** ads, **Ledger** analytics, **Herald** PR, **Beacon** strategy/brand) → ~22 subagents as `tethr_subagents` rows. 4 divisions: Growth (active) + Engineering, Reliability, Customer Feedback (shells). Import manifests exist (`tethr/import/wandr-growth.company.json|.yaml`).
- **Budgets: real.** Per-agent `budgetMonthlyCents` seeded (Helm 1,500 / Atlas 200 / Tailwind 400 / etc. in dollars), wired to core `budget_policies` + `cost_events` hard-stop machinery, with a Budgets UI page. Tailwind is spend-gated; hard approval gating (`gating.ts`) is implemented.
- **LLM:** `LLMProvider` interface → `ClaudeProvider` when `ANTHROPIC_API_KEY` set, else deterministic mock. V2 added a tool registry with allowlists, flag-gated live fetch (`TETHR_LIVE_FETCH`), agentic loop, Helm plans, live-streaming console. Paperclip core adapters remain multi-vendor (claude/codex/cursor/gemini/opencode/...).
- **Verification assets:** browser e2e (`scripts/tethr-e2e.mjs`), sonar-loop e2e passing, 16 tests green at last commit, screenshot deliverable (32 captures). Evals are light (promptfoo scaffold, 2 yamls).

### 2.2 The Drive `/tethr/` blueprint (Jun 10–18, frozen snapshot)
Complete migration blueprint: `handoff.md` (to Frank & Saloni), `engine-inventory.md` (11 live workflows w/ sensitivity ratings), per-agent `ROLE.md`/`ROUTING.md`/`subagents/`, skills bundle, import manifests, `TETHR-PRODUCT-ARCHITECTURE.md` (L0–L3 product framing), `PAPERCLIP-MIGRATION.md`. Port order recommended there: **Sonar first** (isolated, already paused), Ads pair (Tailwind+Ledger) **last** (Google Ads MCP auth + Chrome action layer are tied to Mark's machine — biggest open risk).

### 2.3 The live engine (still on the laptop — untouched, still the production system)
`05 Marketing /Claude Marketing/` + Cowork scheduled tasks. Active daily: blog writer (Atlas source), itineraries 1:00 AM (Voyager), destination-brief-auto 10:53 PM (Compass), analytics weekly. Paused: lead-scout (since 2026-03-25), image-health-check. Daily calendar backups Jul 1–9 confirm it's firing. **Nothing has migrated yet** — Tethr runs seeded/mock; the laptop engine is still the only thing producing real output.

### 2.4 Command Center
`05 Marketing /Command Center/` — **pure Python 3 stdlib** (`http.server` + `sqlite3`, zero deps) + vanilla HTML/CSS/JS, localhost:4747, launchd auto-start. 6-table SQLite DB, single-writer lock (deliberate — Drive whole-file sync corrupts concurrent writers), Reddit tracker synced from `../Reddit`, Instagram 90-day calendar synced from `../Instagram`, live public IG stats fetch, JSON export. **No auth by design.** In active use (DB written Jul 8). Cloud migration must preserve: Reddit spotted/replied workflow, IG calendar + one-tap publish flow, the calendar-sync contract with those Drive folders (or replace it deliberately).

### 2.5 Skills library (Wandr-only, Caliber excluded)
Bundled in `tethr/skills/`: `seo-skill-wandr, country-builder, reddit-commenter, wandr-nightly-auto-brief, wandr-travel-news-scan, lead-scout, wandr-itineraries-engine, anita, machu-picchu-scout, partner-page-builder, newsroom-brief` + strategy (`brand-strategy, penney, dinesh`) + `general/schedule`. Also live in the Claude account: `wandr-weekly-health-brief, wandr-social-refill, wandr-reply-assistant, wandr-nightly-auto-brief`. `wandr-stripe-terraform` was cloud-only — pointer left, not copied. Mapping to agents is already done in the blueprint; **no new agent logic needs writing — orchestration only** (consistent with the no-duplicate-logic boundary).

## 3. What's missing (the real gap list)

1. **No deployment.** Nothing is live. Terraform exists but targets **Azure** (see §4.1); actual Azure/Vercel/Railway account state unverified — needs Mark.
2. **No real Slack.** `server/src/tethr/notify.ts` has a `Notifier` fan-out with in-app real, **Slack/SMS/email as log-only stubs** (target: `#scout`, channel `C0AE02FJR5Y`). No inbound Slack surface (slash commands, mentions, event subscriptions) exists at all.
3. **The "Scout Slack bot" of the brief was not found.** See contradiction §4.2.
4. **Memory is keyword-only.** `tethr/memory.ts` + `tethr_memories`: record/list/recall via SQL `ilike`, recency-ordered, agent+company scoped, with a Memory UI page. It can already prevent re-suggesting a published article **if seeded** (`shared/memory-published-articles.md` exists for exactly this), but there is **no graph DB and no embeddings** — Frank's graph layer was never built.
5. **The V1 recommendation loop (brief §6) is not wired.** Agents produce outputs + in-app notifications, but no structured Slack recommendation post and no `@Cursor` fix loop.
6. **Live-workflow migration not started.** The 4 active laptop crons must become Tethr heartbeats one at a time, with the laptop versions retired only after parity.
7. **No CLAUDE.md in the repo.** `AGENTS.md` (upstream contributor guide) partially covers it; a Tethr-specific CLAUDE.md is a Phase 0 deliverable.
8. **No auth/multi-user on Tethr** (explicitly excluded from V2 scope) and none on Command Center.
9. **Live LLM/product runs unproven.** Everything verified against mock provider; `ANTHROPIC_API_KEY` + live-fetch path needs a supervised shakedown.
10. **Mixed cloud residue:** Azure terraform coexists with an AWS ECS task def, SES email, and `aws_secrets_manager` references in `MIGRATION-NOTES.md`. One cloud story needs to be picked and the other cleaned out.
11. **Evals are thin** (2 promptfoo yamls) relative to an org of 8 agents about to run autonomously.

## 4. Where discovery contradicts the brief (discovery wins)

1. **Infra (brief §9): the repo says Azure, not Railway/Vercel.** `terraform/` provisions an Azure Container App (codename **"scout"**), Azure PostgreSQL Flexible Server, storage account, managed identity, Key Vault `wandrhealth-admin-keys`, ACR `wandrapps` — i.e., Tethr was pointed at **Wandr's existing Azure estate**, which also carries the clinical platform's ops maturity. The brief's Railway recommendation predates this. Decision needed (question 1 below). Note: Paperclip needs a persistent server either way — Vercel remains wrong for the backend under any option.
2. **"The Slack bot. Already built" (brief §3): not found.** Drive-wide grep for any Slack SDK/bot code returned zero; the repo has only outbound stubs. What does exist: the **lead-scout skill** (Sonar) that *posts* to #scout via Cowork scheduled tasks — paused since Mar 25 — and "scout" as the Azure deploy codename. The described bot (digests links/photos, tag-to-kick-off-content) either lives somewhere not audited (Mark's machine outside Drive, or Frank's code) or is aspirational. Needs Mark (question 2).
3. **"Chief of Distribution"** → actually **Helm, Chief Growth Officer** in every artifact. Same role, different name; plans will use Helm/CGO.
4. **"Some UI work has happened"** → the entire V1+V2 product incl. 10 on-brand UI pages is built. The brief's Phase 1 and most UI phases collapse into verification/hardening, not construction.
5. **Command Center stack** — pure Python stdlib, not "Node/Python."
6. **Founding docs unverifiable:** the May 18 "Wandr x AI" Gemini notes (both copies) and `wandr-concept-v6.pdf` are **not in the contact@travelwithwandr.com Drive** (searched title, full-text, shared-with-me). Likely on a personal account. Not blocking — the Jun 10–18 blueprint supersedes them — but I could not do the §5.1 line-by-line reconciliation.
7. **Memory:** brief treats it as an unbuilt dependency; a working (simple) layer exists. The gap is *quality* (keyword recall vs graph/semantic), not existence.
8. **V1 scope lock holds structurally:** the seeded org is sales/distribution only; Engineering + Reliability divisions exist as **empty shells**, which is the designed landing zone for the error-patching agent when scope expands. The V1 loop in brief §6 (flagging bugs → human → Cursor PR) is *internal recommendations*, not customer-facing output, so it does not breach the SaMD boundary — but pulling it forward is still a scope call for Mark (question 3).

## 5. Hard-boundary check (brief §4)
- **HIPAA/PHI:** nothing in the Tethr layer touches clinical systems; seeds/tools are marketing-only. Compliance gating (`gating.ts`) is the enforcement point — keep it hard in every phase. ✅
- **SaMD/internal-only:** approval gates enforced; nothing auto-publishes medical content. ✅
- **No duplicate logic:** blueprint orchestrates existing skills; maintained in all phases. ✅
- **Brand lock:** implemented in `tethr-theme.css`; restated in any UI prompt. ✅
- **Cost guardrails:** per-agent budgets + hard-stops already in core. New autonomous phases must set explicit caps. ✅
- **Phone-checkable checkpoints:** every Stage B phase will end in a URL, a Slack message, or a single number. ✅

## 6. Draft phase scaffold implied by discovery (for reaction only — not Stage B yet)
- **P0** Repo ground truth: CLAUDE.md, ADR, commit this gap analysis, clean AWS/Azure residue after the infra decision.
- **P1** Deploy Tethr to the chosen cloud (container + managed Postgres + secrets), mock LLM first, then live Claude key. *(replaces brief's "build core engine" — engine exists)*
- **P2** Real Slack senders + inbound Slack surface (the actual Scout bot), standardized recommendation message format.
- **P3** V1 recommendation loop: one auditor heartbeat (SEO meta/tracking/schema on travelwithwandr.com) → structured #scout post → human tags `@Cursor` → PR. **This is the V1 definition-of-done and it is closer than the brief assumes.**
- **P4** Migrate live workflows laptop→Tethr one at a time (Sonar first per blueprint, then news-scan, image-health-check, blog, briefs, itineraries; Ads pair last).
- **P5** Memory upgrade (seed published-articles memory; then embeddings/graph decision with Frank).
- **P6** Command Center cloud move (auth, Postgres, preserve Reddit/IG flows, brand-spec UI pass).
- **P7** Error-patching agent into the Reliability shell division; **P8** observability/auth/multi-user; **P9** scale review vs the $1M-no-hiring goal.

## 7. Open questions — RESOLVED by Mark, 2026-07-09
1. **Hosting: Railway (+ Vercel) first, to keep cost down; migrate to Azure later if it makes sense.** The Azure terraform stays in the repo untouched as the future path — nothing gets deleted.
2. **Scout bot: EXISTS.** It lives in a repo named `scout` at the same level as the paperclip folder (`../scout`). It was outside this discovery's mounted folders, which is why the Drive/repo search found nothing — corrects §4.2. Phase 2 starts with an audit of `../scout` and plans a migration, not a rebuild.
3. **Scope: the internal error-patching recommendation loop is IN V1** (flag → Slack → `@Cursor` → PR; internal-only, never customer-facing, SaMD boundary intact).
4. **Completeness: Mark is "not sure"** whether Frank/Saloni built anything since Jun 18 outside `mark-sandbox`/Drive. Mitigation: Phase 0 has Claude Code fetch all remotes, diff branches, and audit `../scout` before anything else — unseen work gets caught at execution time, not assumed away.
