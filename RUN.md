# Running Tethr locally

One command brings the whole product up with the Wandr Growth company seeded.

## Quickstart

```bash
pnpm install        # once
pnpm dev            # server (3100) + UI (5173), embedded Postgres, auto-migrations
```

Open http://localhost:3100 (or the Vite dev URL http://localhost:5173). On first boot
the server auto-seeds the **Wandr Growth** company — CEO → Helm → 8 agents → 22
subagents, the Growth division fully populated, three ready-to-fill division shells,
heartbeat routines, budgets, Drive content, and demo activity. Switch to the company
(prefix `WG`) and open **Console** in the sidebar.

No Docker, no external database, no API keys required: the dev stack runs an embedded
Postgres and the deterministic mock LLM provider out of the box.

## The five-minute demo

1. **Console** — type "Can we afford to spend more on Peru?" and watch Helm classify it,
   route to @ledger → @ledger.guardrails, and return the result.
2. **Queue** — open the pending reply draft (public-facing), read the guardrails, and
   Approve with a note. It publishes to the Drive; the decision lands in the Audit log.
3. **Company** — the live org. Click Sonar → "Run heartbeat now" to fire the
   leads → reply chain; the reply stops in the Queue (the human send gate).
4. **Drive** — browse `/agents/helm/sonar/ROLE.md` (versioned spec files) and
   `/scout/replies` (the output you just approved).
5. **Runs / Budgets / Audit** — schedules from the manifest crons, the combined growth
   line, and the full reconstructable trail.

## Docker path

```bash
make compose-up     # Postgres 17 + server with bundled UI on :3100
```

## Environment knobs (.env.example has all of them)

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | switches every agent from the mock to live Claude calls |
| `TETHR_CLAUDE_MODEL` | live model override (default claude-sonnet-4-6) |
| `TETHR_BUNDLE_PATH` | path to the `/tethr` spec bundle; seeder imports the real agent markdown into the Drive (falls back to vendored specs when unset) |
| `TETHR_AUTOSEED=false` | skip auto-seeding at startup |
| `PAPERCLIP_STORAGE_LOCAL_DIR` | where Drive bytes live (default instance dir; set `./.tethr-data/storage` to keep them in-repo) |
| `DATABASE_URL` | use an external Postgres instead of the embedded one |

Note: the dev server loads env from the Paperclip instance dir
(`~/.paperclip/instances/default/.env`) — put `TETHR_BUNDLE_PATH` there for `pnpm dev`.

## Tests

```bash
cd server && npx vitest run src/__tests__/tethr.test.ts
```

Covers the routing engine, the hard approval gate (publish blocked while pending),
the Sonar loop end-to-end, Drive versioning/tags/permissions, and memory recall
against an embedded Postgres.

## Re-seeding

```bash
curl -X POST http://localhost:3100/api/tethr/seed -H 'content-type: application/json' -d '{}'
```

Idempotent: returns the existing company if "Wandr Growth" is already present.
