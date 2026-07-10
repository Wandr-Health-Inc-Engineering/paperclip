# Phase 0 — Repo ground truth & Scout audit

**Objective:** Commit the discovery findings into the repo (CLAUDE.md, ADR, gap analysis), reconcile any work Frank/Saloni pushed since Jun 18, and audit the `../scout` repo — so every future Claude Code session starts from verified ground truth.

**Definition of done:** `CLAUDE.md` exists at repo root and is accurate; `docs/tethr-buildout/` (gap analysis, roadmap, phase files) and `docs/adr/0001-tethr-buildout-decisions.md` are committed on a `tethr-buildout` branch; a branch-reconciliation note and a Scout audit report exist in `docs/tethr-buildout/`.

**Prerequisites:** None. This is the first phase. Claude Code running inside the paperclip repo with the `scout` repo present at `../scout`.

**Estimate:** 2 sessions.

---

## Prompt 1 — reconciliation + Scout audit (paste into Claude Code)

> Enter plan mode. Read docs/tethr-buildout/00-current-state-and-gap-analysis.md, DECISIONS.md, PLAN.md, and MIGRATION-NOTES.md first.
>
> I want three read-only investigation deliverables before we write anything:
>
> 1. **Branch reconciliation.** Run `git fetch --all`, then compare `mark-sandbox` against every `origin/*` branch (not `upstream/*`) and report any commits on origin that aren't in mark-sandbox — especially anything from Frank or Saloni after 2026-06-18. Delegate the log-reading to a subagent; I only want the conclusion: "nothing newer" or a list of branches/commits with one-line summaries.
> 2. **Scout audit.** Use a subagent to read the sibling repo at `../scout` (read-only, skip node_modules): language/framework, how it connects to Slack (bot token? socket mode? events API?), what it does when tagged (digest links/photos, kick off content), what secrets/env it needs, and how it currently runs on my machine. Write the findings to `docs/tethr-buildout/scout-audit.md`.
> 3. **Live-run check.** Confirm nothing in this repo is currently deployed: search for any Railway/Vercel config or deploy tokens (`railway.json`, `railway.toml`, `vercel.json`, `.vercel/`), and report what `terraform/` targets without applying anything.
>
> Write the plan for all three to `tasks/phase-0.md` and stop for my approval before executing.

## Prompt 2 — commit ground truth *(after approving the plan)*

> Execute the approved plan in tasks/phase-0.md. Then:
>
> 1. Create a branch `tethr-buildout` off `mark-sandbox`.
> 2. Write a root `CLAUDE.md` for this repo covering: what Tethr is (product layered on the Paperclip fork — cite ARCHITECTURE-LOCAL.md), the merge-safe rule (additive files only; core touches logged in DECISIONS.md), where the Tethr layer lives (`server/src/tethr/`, `ui/src/pages/tethr/`, `packages/db/src/schema/tethr_*`), how to run it (`pnpm install && pnpm dev`, embedded Postgres, mock LLM, seeded Wandr Growth org), how to test (`pnpm test`, `node scripts/tethr-e2e.mjs`), the brand lock (Urbanist + JetBrains Mono, pure black/white, 2px borders, no gradients, edit only `ui/src/lib/brand.ts` + `ui/src/styles/tethr-theme.css`), the hard boundaries (never touch PHI/clinical systems; internal-only output; never modify the live Drive engine at `05 Marketing /Claude Marketing/`; nothing auto-merges), and the plan-mode + `tasks/phase-N.md` convention.
> 3. Write `docs/adr/0001-tethr-buildout-decisions.md` recording the 2026-07-09 decisions: Railway-first hosting (Azure terraform preserved as future path), Scout migrated from `../scout` not rebuilt, error-patching loop included in V1, live laptop engine retired workflow-by-workflow in Phase 5.
> 4. Commit `CLAUDE.md`, the ADR, everything in `docs/tethr-buildout/`, and `tasks/phase-0.md`. Do NOT push and do NOT merge — stop after the commit and show me `git log --stat -1`.
>
> Verification: `pnpm test` still passes (run it), and `git status` is clean except intended files.

## Checkpoint for Mark (phone)
Slack yourself / open GitHub mobile later — but the immediate check is in this chat: Claude Code's final message must show (a) "nothing newer on origin" or the list of unmerged work, (b) a one-paragraph Scout summary, and (c) the single commit diff-stat containing CLAUDE.md + docs. Two minutes.

## Rollback
Nothing live is touched. Worst case: `git branch -D tethr-buildout`.
