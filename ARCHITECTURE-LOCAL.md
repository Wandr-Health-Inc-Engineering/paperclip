# Tethr local build — what exists and where the seams are

Tethr is built **inside Mark's Paperclip fork** the way Chrome is built on Chromium:
Paperclip core is the engine (companies, agents, heartbeats, routines, approvals,
budgets, costs, activity log, storage service); Tethr is the product layered on top
through the engine's own seams. Core stays merge-safe — every touched core file is a
one-liner logged in DECISIONS.md.

## Layer map

```
Layer 3  Content        Wandr Growth company (seeded): CEO → Helm → 8 agents → 22
                        subagents; Growth division live, 3 shell divisions ready to fill
Layer 2  Tethr add-ons  server/src/tethr/** — routing engine, gating/compliance, Drive,
                        memory, notifications, LLM provider, tethr_llm adapter, seeder
Layer 1  Tethr shell    ui/src/pages/tethr/** + components/tethr/** — Console, Company,
                        Queue, Drive, Runs, Budgets, Audit, agent detail, settings
Layer 0  Paperclip      untouched engine: heartbeat scheduler, routines (cron), issues,
                        approvals, budget policies, cost events, activity log, storage
```

## The data model (all additive — `tethr_*` tables, migrations 0086/0087)

| Table | Holds |
|---|---|
| `tethr_divisions` | first-class divisions; `status: active \| shell` |
| `tethr_agent_profiles` | per-agent Tethr identity: tag, codename, mission, approval gate, heartbeat cron note, routing table, standing rules |
| `tethr_subagents` | the 22 fine-tuned specs: route-when, not-here, reads, steps, output contract, guardrails, done-when, escalation, sensitivity |
| `tethr_route_runs` | every routed request with its hop trail (classify → route → do) |
| `tethr_outputs` | work products; gated ones link a core `approvals` row |
| `tethr_drive_nodes` / `tethr_drive_versions` | Drive metadata: folder tree, versioned files, tags, permissions; bytes via core `StorageService` |
| `tethr_memories` | per-company + per-agent recall |
| `tethr_notifications` | in-app notification center rows |

## How an agent runs

Every Tethr agent is a core Paperclip employee with `adapterType: tethr_llm`. The
adapter (registered through `registerServerAdapter`, the documented seam) executes the
classify → route → do loop:

1. **Classify** — Helm's routing table picks the agent; the agent's subagent specs pick
   the specialist. `LLMProvider.classify` does the picking (mock = deterministic
   keyword scoring; Claude when a key is present).
2. **Route** — every hop is appended to the route run AND written to the core activity
   log (`tethr_route_hop`), so the full path is reconstructable.
3. **Do** — the subagent's spec is rendered as the system prompt (job, reads, steps,
   guardrails, standing rules, recalled memory) and `LLMProvider.generate` produces the
   work product.

Because execution goes through the real adapter seam, cron routines, "run now",
issue-assignment wakeups, run logs, and cost events all flow through unmodified core
machinery. Helm (router-only, no subagents) routes across the whole org; the CEO
placeholder no-ops gracefully.

## The compliance layer (the signature feature)

`server/src/tethr/gating.ts`. Sensitivities `medical`, `public`, `spend`, `pr` are
**hard-gated**:

- the output row is created `gated` with a linked core `approvals` row (`tethr_output`)
- `publishToDrive` re-checks the approvals row itself — a gated output without an
  `approved` approval **cannot** publish, there is no advisory path
- `decide(approve | reject | request_changes)` records reviewer + reason, audit-logs
  the decision, and only `approve` publishes (file lands in the Drive, versioned)
- the Queue screen is the only human surface that flips these states

`safe`/`internal` outputs publish straight to the Drive — visible, never blocked.

## Heartbeats and schedules

Manifest crons seed real core routines with schedule triggers (Atlas 21:00 daily,
Compass 22:53 daily, Voyager 01:00 daily, Ledger Sunday, Sonar 08:00 paused — matching
production). The scheduler fires them through the `tethr_llm` adapter. The Runs screen
shows the schedule plus history, and "Run now" executes the same chain synchronously.

## Where cloud concerns live (see MIGRATION-NOTES.md)

- **DB**: Drizzle + versioned migrations; embedded Postgres locally, `DATABASE_URL` in cloud
- **Files**: core `StorageService` (`local_disk` → `s3` by env); Drive metadata in Postgres
- **LLM**: `LLMProvider` (mock ↔ Claude by env)
- **Notifications**: `Notifier` interface; in-app live, Slack/SMS/email mocked behind it
- **Secrets**: env files only, never committed; `.env.example` lists every knob
