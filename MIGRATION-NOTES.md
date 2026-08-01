# Tethr → cloud: exactly what to swap

Everything stateful sits behind an interface. The cloud move is configuration plus
three small provider implementations — no caller changes anywhere.

## 1. Database (one env var)

- Local: embedded Postgres (dev) — schema managed by Drizzle migrations
  (`packages/db/src/migrations`, currently through `0087`).
- Cloud: set `DATABASE_URL=postgres://…` (RDS/Cloud SQL/Neon). Run
  `pnpm db:migrate` in deploy (or `PAPERCLIP_MIGRATION_AUTO_APPLY=true`).
- Nothing else: all Tethr data access goes through Drizzle repositories in
  `server/src/tethr/*`; there are no raw queries in UI code.

## 2. File storage (env vars, provider already exists)

- Local: `PAPERCLIP_STORAGE_PROVIDER=local_disk`, bytes under
  `PAPERCLIP_STORAGE_LOCAL_DIR`.
- Cloud: `PAPERCLIP_STORAGE_PROVIDER=s3` + `PAPERCLIP_STORAGE_S3_BUCKET/REGION/PREFIX`
  (S3 provider ships in core: `server/src/storage/s3-provider.ts`; GCS = implement the
  4-method `StorageProvider` interface in `server/src/storage/types.ts`).
- Drive metadata (folders/versions/tags/permissions) lives in Postgres and moves with
  the database. Object keys are provider-agnostic.

## 3. LLM (one env var)

- Local default: deterministic mock (`server/src/tethr/llm/mock.ts`) — demoable offline.
- Cloud: set `ANTHROPIC_API_KEY` (+ optional `TETHR_CLAUDE_MODEL`). The
  `ClaudeProvider` (`server/src/tethr/llm/claude.ts`) is plain fetch — no SDK to vendor.
- Seam: `LLMProvider` interface (`server/src/tethr/llm/types.ts`) — classify + generate.
  Per-agent model routing or a different vendor = implement the interface, switch in
  `getTethrLLMProvider()`.

## 4. Notifications (implement 3 small senders)

- Seam: `Notifier` in `server/src/tethr/notify.ts` (`channel` + `send()`).
- In-app is the live local implementation (DB-backed; keep it in cloud).
- Slack / SMS / email are mocks that log. Replace each `send()` body with the real
  call (Slack `chat.postMessage` to `#tethr` C0BGK29482J; Twilio; SES).
  Fan-out logic already calls all channels.

## 5. Secrets

- Never committed; `.env.example` enumerates every knob with blanks.
- Cloud: core already supports `PAPERCLIP_SECRETS_PROVIDER=aws_secrets_manager`.
  Put `ANTHROPIC_API_KEY`, Slack/Twilio/SES creds, and `DATABASE_URL` in the manager.

## 6. Heartbeats

- Already real core routines with cron triggers — they move with the database.
  Verify server timezone (`America/New_York` triggers seeded) and re-enable Sonar's
  08:00 trigger when Mark green-lights reactivation (open question in handoff.md).

## 7. Known cloud risks carried over from the bundle (unchanged)

- Google Ads MCP auth + Chrome action layer are laptop-bound → Tailwind stays
  recommendation-only with the spend hard-gate until hosted/headless is confirmed.
- `wandr-destination-brief` skill is missing upstream → Compass runs against the mock
  generator until located/rebuilt.

## Checklist for the cloud team

- [ ] Provision Postgres, set `DATABASE_URL`, run migrations
- [ ] Provision bucket, set `PAPERCLIP_STORAGE_*`
- [ ] Set `ANTHROPIC_API_KEY` (secrets manager)
- [ ] Implement Slack/SMS/email `Notifier.send()` bodies
- [ ] Set `TETHR_BUNDLE_PATH` to the synced spec bundle (or rely on vendored specs)
- [ ] Confirm approval gates block in staging: a gated output must refuse to publish
      until decided in the Queue (covered by `server/src/__tests__/tethr.test.ts`)
