# Phase 18.0 — spike: can one headless Claude Code session be Tethr's chat? (2026-11-07)

Plan: chat-first Tethr v1 (each chat thread drives ONE Claude Code session with Mark's claude.ai
connectors; enforced approvals via hooks). This spike ran the Claude CLI (v2.1.252) headless the
way the runner will — `-p … --output-format stream-json --verbose --include-partial-messages`,
`--settings <json>`, `--permission-mode`, `--resume` — from a clean environment, against Mark's
real connectors, with every outward action blocked. Harness + hook were throwaway (scratchpad).
Nothing was sent or changed in any account; the temporary Drive folder was removed afterwards.

**Verdict: go.** Every check passed or has a clear workaround. No fallback (Agent SDK, Hermes,
warm process) is needed for v1.

## Results

| # | Check | Result |
|---|---|---|
| 1 | claude.ai connectors in headless `-p` | **Yes, deferred.** Not in `system/init` (`mcp_servers` shows only the stray user-scope `posthog`, needs-auth); the model loads them on demand with `ToolSearch`. Names: `mcp__claude_ai_<Connector>__<tool>` (spaces → `_`, e.g. `mcp__claude_ai_Google_Calendar__list_events`). Do **not** pass `--strict-mcp-config`. |
| 2 | `--resume` | Works; same `session_id` across turns; remembers turn 1. |
| 3 | PreToolUse hook on MCP tools | **Can deny** (JSON `hookSpecificOutput.permissionDecision:"deny"` + reason, exit 0). The reason comes back to the model as an error tool result; also listed in `result.permission_denials`. **Hook `allow` overrides `dontAsk`** (an MCP read ran with no allow rule). PostToolUse fires for MCP tools with `tool_response`, `tool_use_id`, `duration_ms`. `updatedInput` not tested (not needed for v1). |
| 3b | Gate wording | First deny message ("…tell Mark it's waiting") was flagged by the model as a possible prompt injection. When Mark had asked for the action it was accepted. → The persona must explain the approval gate, and the deny text must read as a status ("Tethr approval gate: waiting for Mark's approval — <id>"), not instructions. |
| 4 | `dontAsk` with **no** hook | Denies Write (inside and outside cwd) and MCP calls; **allows read-only Bash** (`echo hi` ran). Denial text invites "other tools" → the hook must gate Bash too. Hook crash/timeout falls back to these denials (fail-closed except read-only Bash). |
| 5 | Deny rules | `permissions.deny: ["mcp__claude_ai_Mercury"]` hides the whole connector (ToolSearch: "No matching deferred tools"). A single-tool deny hides that tool (model picked another read tool). Deny rules therefore beat hook-allow by removing the tool. Caveat: a denied server still connects and its server **instructions** still enter context (the model called Mercury's leftover text suspicious). |
| 6 | Latency (sonnet unless noted) | init ≈ 0.6–0.9 s. Simple answer: first text 1.8–2.0 s, done 2.5–3.2 s (fresh or resumed). One connector call: done ≈ 6–8 s. A file write: ≈ 10.7 s. Thrashing tool search (7 searches) ≈ 27 s first text. Old engine: median 35 s, p90 200 s. |
| 7 | Memory file | `CLAUDE.md` containing `@Memory.md` loads on a fresh session (answered the codeword). **Edits to Memory.md between turns were seen on resume** (no "memory changed" note needed). |
| 8 | Drive-synced cwd | Works in `…/My Drive/00 Tethr/<sub>` (spaces fine). Nothing extra written to the folder. Claude's own session transcripts go to `~/.claude/projects/<cwd-slug>/<session>.jsonl` (contain raw tool results — PHI note stands). |
| 9 | Personal-settings leakage | Mark's `~/.claude/settings.json` has no hooks/plugins and there is no `~/.claude/CLAUDE.md` → negligible. Claude Code **auto-memory** is on by default (`init.memory_paths.auto`); `"autoMemoryEnabled": false` in `--settings` removes it (verified). `--bare` is unusable (it also disables hooks). Keep default setting sources. |
| 10 | Input shapes | Gmail send: `send_message {to: [..], subject, body}` (captured by the gate, not sent). Stripe writes are one tool: `stripe_api_write` (+ `manage_stripe_accounts`, `atlas_company_formation`). PostHog is a single `exec` tool → classify by command verb. |
| 11 | Context limit | Loading every connector's full tool list in one session hit **"Prompt is too long"** (≈207 tool schemas). Normal turns load only what they need; discovery must go one connector at a time (or harvest from real turns). Default Canva (47 tools) and Figma (40) to Off. |
| 12 | Environment | Spawned `claude` must not inherit host-session vars. Paperclip's `runChildProcess` already strips `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`/session vars; the dev server's env had no `ANTHROPIC_BASE_URL`. Runner should still scrub any `CLAUDE_CODE_*` host vars defensively. |

## Decisions for Phase 2–3

- Flags: `-p --output-format stream-json --verbose --include-partial-messages --permission-mode dontAsk --settings <per-turn file> [--resume <id>] --add-dir <00 Tethr>`; no `--strict-mcp-config`, no `--bare`.
- Per-turn settings: `autoMemoryEnabled: false`; `permissions.deny` = Off connectors (`mcp__claude_ai_<X>`) + `mcp__posthog` (+ Mercury by default); PreToolUse/PostToolUse hooks with matcher `.*`.
- The hook decides everything (allow/deny) under `dontAsk`; it must also gate `Bash`, `Write`/`Edit` (workspace only), and fail closed when the Tethr server is unreachable.
- Persona explains the approval gate; deny reasons are phrased as gate status.
- Model default `sonnet`; first visible text target < 3 s for plain answers is realistic.

## Tool inventory (11 connectors; Mercury hidden by deny)

- **Gmail (30):** apply_sensitive_message_label, apply_sensitive_thread_label, create_draft, create_label, delete_draft, delete_label, forward, get_draft, get_message, get_thread, label_message, label_thread, list_drafts, list_labels, mark_message_spam, mark_thread_spam, reply, search_threads, send_message, trash_message, trash_thread, unlabel_message, unlabel_thread, unmark_message_spam, unmark_thread_spam, untrash_message, untrash_thread, update_draft, update_label, update_message_labels
- **Slack (19):** slack_add_reaction, slack_create_canvas, slack_get_reactions, slack_list_channel_members, slack_list_user_channels, slack_read_canvas, slack_read_channel, slack_read_file, slack_read_thread, slack_read_user_profile, slack_schedule_message, slack_search_channels, slack_search_emojis, slack_search_public, slack_search_public_and_private, slack_search_users, slack_send_message, slack_send_message_draft, slack_update_canvas
- **Google Calendar (9):** create_event, delete_event, get_event, list_calendars, list_events, respond_to_event, search_events, suggest_time, update_event
- **Google Drive (16):** add_comment_reply, copy_file, create_file, download_file_content, get_file_metadata, get_file_permissions, get_shared_drive_metadata, list_recent_files, list_shared_drives, read_file_content, request_access, resolve_comment_thread, search_files, share_file, trash_file, update_file
- **Google Sheets (9):** append_values, batch_clear_values, copy_sheet_to_another_spreadsheet, get_spreadsheet, get_values, insert_dimension, update_formulas, update_spreadsheet, update_values
- **Stripe (12):** atlas_company_formation, list_available_accounts_or_orgs, manage_stripe_accounts, search_stripe_documentation, send_stripe_feedback, stripe_analytics, stripe_api_details, stripe_api_read, stripe_api_search, stripe_api_write, stripe_implementation_planner, stripe_reports
- **PostHog (1):** exec
- **Clay (19):** add-company-data-points, add-contact-data-points, ask-question-about-accounts, get-credits-available, get-current-workspace, get-task, get-task-context, get_subroutine_input_options, list_subroutines, load-more-search-results, query-objects, render-search-results, run_subroutine, run_subroutine_direct, run_subroutine_no_mapping, search-companies, search-contacts, search-contacts-by-name, track-event
- **Claude Docs (5):** create, delete, export, query, read
- **Canva (47)** and **Figma (40):** design tools (full lists in the spike log); default Off.
