# tasks/phase-0.md — Repo ground truth & Scout audit

**Branch:** `tethr-buildout` (off `mark-sandbox`) · **Status: executed 2026-07-09**

Run under the RUN-ALL meta-prompt: plan written here, then executed without an approval
pause (Phase 0 has no hard gate). Definition of done from `phase-0.md`.

## Investigations (read-only)

1. **Branch reconciliation.** `git fetch --all`; compare `mark-sandbox` against every
   `origin/*` branch (not `upstream/*`); look for post-2026-06-12 commits, especially
   Frank/Saloni. → `docs/tethr-buildout/branch-reconciliation.md`.
   **Result: nothing newer.** Local `mark-sandbox` == `origin/mark-sandbox`; zero
   post-cutoff commits on `origin/development` or `origin/master`; no Frank/Saloni commits
   anywhere. No STOP condition.
2. **Scout audit.** Read `../scout` (read-only). → `docs/tethr-buildout/scout-audit.md`.
   **Result: `../scout` does not exist at that path.** Per the RUN-ALL fallback, this is
   recorded as MANUAL step #1 and Phase 2's inbound half builds fresh on the `notify.ts`
   seam instead of porting Scout.
3. **Live-run check.** Search for deploy config/tokens; report `terraform/` target.
   **Result: nothing deployed.** No `railway.json|toml`, `vercel.json`, `.vercel/`.
   `terraform/` targets Azure (`azurerm` provider) — preserved, untouched.

## Build steps (executed)

1. Create branch `tethr-buildout` off `mark-sandbox`. ✅
2. Write root `CLAUDE.md` — product framing (cite ARCHITECTURE-LOCAL.md), merge-safe
   rule, Tethr layer locations, run/test, brand lock, hard boundaries, plan-mode + tasks/
   convention, phase status. ✅
3. Write `docs/adr/0001-tethr-buildout-decisions.md` — the 2026-07-09 decisions. ✅
4. Write `docs/tethr-buildout/MANUAL-STEPS.md` — the running deliverable. ✅
5. Commit `CLAUDE.md`, ADR, all of `docs/tethr-buildout/`, `docs/adr/`, `tasks/phase-0.md`
   on `tethr-buildout`. No push, no merge. ✅

## Verification

- `pnpm test` (tethr suite) still green; pre-existing non-Tethr failure
  `heartbeat-comment-wake-batching` noted in memory, not ours.
- `git status` clean except intended files.
- Final message shows: (a) "nothing newer on origin", (b) Scout summary (absent → fallback),
  (c) the single commit diff-stat.

## Rollback

Nothing live touched. Worst case `git branch -D tethr-buildout`.
