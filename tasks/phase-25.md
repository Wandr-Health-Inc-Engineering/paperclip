# Phase 25: Hermes is tethr's memory (subscription only, no API)

Mark (2026-11-09): "isn't hermes the memory layer? I just want to make sure we're maximizing these
tools not just creating a new interface to just use claude code", then "I want to use tethr as our
main thing but you can use hermes as the memory layer. we need to utilize it but stick with the
subscription style not API for now".

## What was thin
- tethr's memory was one free-form `Memory.md` (728 bytes, mostly the seed) that Claude edited
  when told "remember".
- Context beyond that was the last 5 turns after a session rotated, plus the resumed Claude
  session.
- Nothing said in an earlier chat could be found again unless someone wrote it down.

## Design (as built)
**Hermes stores, searches and keeps skills; Claude Code on the subscription does the thinking.
tethr never runs a Hermes turn, so Hermes never calls a model.**

- **The bridge.** `server/src/tethr/hermes/bridge.ts` is the only code that talks to Hermes.
  - It finds Hermes through its launcher's `--print-runtime-command` and runs one Python
    helper, `hermes/helper.ts` `HELPER_SOURCE`. The helper is content-addressed in the
    instance dir, runs as `<hermes python> -I`, gets `HERMES_HOME` = tethr's profile, and its
    environment holds no keys.
  - Allowed operations (`HELPER_OPS`):
    - `status`
    - `memory.apply`: Hermes's own memory store, with its lock, injection scan and limits.
    - `sessions.import`: through Hermes's session store, the same path as `hermes sessions
      import`.
    - `sessions.search` and `sessions.read`: read-only FTS5 search.
    - `skills.list`, `skills.view`, `skills.save`, `skills.delete`: Hermes's skill functions,
      category `tethr`.
- **The profile.**
  - It is per company, `tethr-<prefix>` (Wandr: `tethr-wd`), at `~/.hermes/profiles/`.
  - tethr writes the folder and a locked-down `config.yaml`: no provider,
    `adopt_external_logins: false`, background review off, consolidation off, telemetry off,
    limits 6,000 (company) / 2,000 (people) characters.
  - `hermes -p tethr-wd sessions list` / `insights` work for Mark; chatting in that profile
    fails by design.
- **Entries** (`hermes/entries.ts`): Hermes's `§` format.
  - Two targets: "company" (MEMORY.md) and "people" (USER.md).
  - Rendered into CLAUDE.md v4's "## Memory" every turn, as data, with usage and guidance.
  - `Memory.md` is now a read-only copy for the team; the chat can't write it.
- **Store** (`hermes/memory-layer.ts`): Hermes when its profile is on, else a built-in store
  with the same files in the instance dir (no search, no skills).
  - Provenance (who saved each entry, from which chat) is kept in `tethr-memory.json`
    (`hermes/state.ts`).
  - The old free-form Memory.md is migrated once, with a backup outside Drive.
  - Switching Hermes on moves the built-in entries in; switching it off copies them back.
- **Index** (`hermes/indexer.ts`): every finished chat turn is imported, one queue, a ledger so
  each turn goes in once, and a backfill at boot plus every 10 minutes.
  - Imported: the person's message and tethr's answer only.
  - Never: tool results, private turns (the Ideas chat) or throttled turns.
  - One lineage per tethr chat. The source is `tethr`, or `tethr-agent-<tag>` for an agent's
    chats.
- **Tools** (`assistant/memory-tools.ts`, on the `tethr` MCP server):
  - `memory` (draft): add, patch or remove; health details are refused.
  - `recall` (read): search, or open a turn and the two before it. An agent searches its own
    chats (a lead also its sub-agents'). It taints the thread.
  - `skill_view` (read) and `skill_save` (draft; tethr's own chats only).
  - None of them in a private turn: the hook token carries `privateTurn`, and both the list
    and the call refuse.
- **Nudge:** every 10th message from a person, the turn's notes remind tethr to save what's
  durable. It's part of that turn, so it adds no turn and no cost.
- **UI:**
  - The Memory page (`TethrMemory.tsx`): entries with who saved them, edit, remove, add, usage
    bars, a past-conversation search and the skills list.
  - An Integrations "Memory" card: Hermes on/off, lockdown checks, how many turns are indexed,
    the last import error.
  - Routes in `server/src/routes/tethr-memory.ts`: switching Hermes is for instance admins;
    edits are for people.

## Spike
See `tasks/phase-25-0-spike.md`.

## Verified live (throwaway instance + throwaway Hermes root, real Claude on the subscription)
- **Remember:** "remember …" became a `memory` call; the entry landed in the profile's
  MEMORY.md with provenance (@tethr, main chat). A NEW side chat answered from the Memory block
  with no tool call.
- **Recall:** a fact said with "don't save it" was found by `recall` from a fresh side chat, and
  that thread was tainted.
- **Skills:** a procedure was saved with `skill_save`; a new chat loaded it with `skill_view`.
- **UI:** the Memory page (edit an entry, search past conversations, skills) and the
  Integrations card checked in light, dark and phone.
- **No model:** `hermes insights` on the profile: 6 sessions, 0 tokens.
- **Bug found and fixed:** the boot catch-up drained an empty queue, and that left the queue's
  flag set for good, so no later turn was imported. It's fixed, with a regression test that
  fails on the old code.

## Rollout on Mark's Mac (approved with the plan)
1. Merge the worktree branch, one restart.
2. Switch Hermes on for Wandr: this creates `~/.hermes/profiles/tethr-wd`, moves memory in and
   backfills the past chats.
3. Set `auth.adopt_external_logins: false` in his default Hermes profile, so his own running
   Hermes can never refresh tethr's Claude Code login.
4. Read-only checks: entries, a search, and `hermes -p tethr-wd insights` showing 0 tokens.
