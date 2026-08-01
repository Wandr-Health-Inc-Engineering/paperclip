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

## What V2 added

- Agents have tools now: watch the Console — tool calls appear as hops in the chain
  (`TETHR_LIVE_FETCH=true` enables real read-only CDC/web fetches; Reddit falls back to
  fixtures since it blocks unauthenticated clients).
- "Request changes" in the Queue sends the draft back; the agent's revision (v2) appears
  linked to v1 in the lineage strip. `TETHR_AUTO_REVISE=false` turns auto-revision off.
- Atlas/Compass/Voyager heartbeats advance real calendars in `/state/` (Drive) and
  published work lands in the dedup log.
- Try "Launch a Peru campaign for the spring season" in the Console — Helm plans a
  4-step sequence across Beacon → Ledger → Tailwind → Atlas, streaming live.
- The bell (top right) is the in-app notification center; Helm posts a daily 5 PM digest.
- Add divisions/agents from the Company screen — shells are genuinely fillable.
- Browser e2e: `node scripts/tethr-e2e.mjs` (run the dev stack first).
- Export Tethr state: `GET /api/tethr/<companyId>/export`.

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
