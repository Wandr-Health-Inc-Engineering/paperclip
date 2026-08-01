# Tethr Buildout — Master Roadmap

**2026-07-09 · Built from the Stage A gap analysis (`00-current-state-and-gap-analysis.md`) — read that first.**
**Builder profile:** solo, part-time, async around a clinical night-shift schedule. Estimates are in *sessions* (one session ≈ 1–3 focused hours with Claude Code) and calendar weeks at ~3–4 sessions/week.
**How to run a phase:** open Claude Code inside this repo, paste the phase file's Prompt 1 (plan mode), review the plan it writes to `tasks/phase-N.md`, approve, paste Prompt 2. Verify the phone checkpoint before starting the next phase.

## Locked decisions (Mark, 2026-07-09)
- **Hosting:** Railway for the Tethr server + Postgres (+ Command Center service later). Vercel only if/when a standalone dashboard frontend is split out. Azure terraform stays in-repo untouched as the eventual migration path.
- **Scout:** existing bot at `../scout` (sibling repo) — migrate, don't rebuild.
- **V1 scope:** distribution agents **plus** the internal error-patching recommendation loop. Internal-only, SaMD-avoidant, PHI-untouchable — unchanged.

## Phase order & dependencies

| Phase | Name | Depends on | Estimate | Definition of done (one line) |
|---|---|---|---|---|
| 0 | Repo ground truth & Scout audit | — | 2 sessions / 1 wk | CLAUDE.md + ADR committed; all remotes/branches reconciled; `../scout` audited |
| 1 | Deploy Tethr to Railway | 0 | 3–4 sessions / 1–2 wk | Tethr UI live at a Railway URL on managed Postgres, mock LLM, seeded org visible |
| 2 | Slack: Scout migration + real senders | 0, 1 | 3–4 sessions / 1–2 wk | Agent notification arrives in #scout from the cloud; Scout's inbound flow runs in Tethr |
| 3 | Go live with Claude (supervised) | 1 | 2 sessions / 1 wk | One real agent run (Sonar) on live LLM within a $ cap, visible in Budgets/Runs |
| 4 | V1 recommendation loop (site auditor → @Cursor → PR) | 2, 3 | 3–4 sessions / 2 wk | An auditor finding posted to #scout became a merged PR via @Cursor, no auto-merge |
| 5 | Migrate live workflows off the laptop | 2, 3 | 6–8 sessions / 3–4 wk | All 4 active laptop crons retired; Tethr heartbeats producing identical output |
| 6 | Memory upgrade | 3 | 2–3 sessions / 1 wk | Published-article dedupe enforced in routing; graph/embeddings decision recorded |
| 7 | Command Center → cloud | 1 | 4–5 sessions / 2 wk | Command Center at a real URL with auth, Reddit/IG flows intact, on-brand |
| 8 | Error-patching agent (Reliability division) | 4 | 3 sessions / 1–2 wk | Reliability agent files scoped bug recommendations through the P4 loop |
| 9 | Observability, budgets, access control | 3, 5 | 3 sessions / 1–2 wk | Cost dashboard trustworthy; alerts on cap-hit; Frank/Alec can log in read-only |
| 10 | Scale review vs $1M-no-hiring | all | 1 session | Written review: hours saved, spend, next bottleneck |

**Total: ~32–38 sessions ≈ 3–4 months part-time.** The critical path to V1-done (brief §6) is 0→1→2→3→4: roughly 13–16 sessions.

## Sequencing notes
- 1 and 2's Scout audit half can be interleaved; 2's senders need 1's deployed server for webhook URLs.
- 5 runs one workflow at a time (Sonar → news-scan → image-health-check → blog → briefs → itineraries; **Tailwind/Ledger ads pair deliberately excluded until the Chrome-action/MCP-auth question is solved — do not schedule them**).
- 6 and 7 are parallelizable with 5.
- Every phase that adds autonomous runs states a per-agent budget cap in its prompt — no exceptions.

## Standing rules for every Claude Code session (also in CLAUDE.md after P0)
- Never touch the live Wandr clinical systems, PHI, or the website repo's medical content.
- Never modify `05 Marketing /Claude Marketing/` (the live engine) — it's retired workflow-by-workflow in P5, never edited.
- Paperclip core stays merge-safe: additive files under `server/src/tethr/`, `ui/src/pages/tethr/`, `packages/db/src/schema/tethr_*`; any core-file touch gets a one-line entry in `DECISIONS.md`.
- UI work: Urbanist + JetBrains Mono, pure black/white, 2px borders, no gradients/color — via `ui/src/lib/brand.ts` + `ui/src/styles/tethr-theme.css` only.
- Nothing auto-merges. Nothing auto-deploys past the checkpoint. Plans go to `tasks/phase-N.md` before execution.

## Phase files
`docs/tethr-buildout/phase-0.md` … `phase-10.md` — each has Objective, Definition of Done, Prerequisites, paste-ready Claude Code prompts, a phone-checkable checkpoint for Mark, and rollback notes.
