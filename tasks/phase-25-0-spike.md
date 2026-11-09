# Phase 25.0 spike: Hermes as a memory layer with no model calls (2026-11-09)

Hermes Agent v0.23.0 (`~/.hermes`). Everything ran on a throwaway Hermes root in the session
scratchpad (`HERMES_HOME=<root>/profiles/tethr`), never `~/.hermes`.

## Findings
- **Runtime.**
  - `hermes --print-runtime-command --module json.tool` prints Hermes's Python and checkout; it
    is Hermes's stable "machine boundary".
  - A helper run as `<python> -I helper.py` that inserts the checkout and imports
    `hermes_bootstrap` gets the full Hermes library, starting in about 0.35s.
  - A brand-new data root installs its runtime once (about 640 MB, a few minutes). Profiles under
    the real `~/.hermes` reuse the installed one.
- **Memory.**
  - `tools.memory_tool.load_on_disk_store()` + `memory_tool(target, operations, store)`: add,
    patch and remove work, the profile's `memory_char_limit` / `user_char_limit` apply (6,000 /
    2,000 read back), and an injection attempt is refused ("matches threat pattern
    'prompt_injection'").
  - Files are `<profile>/memories/MEMORY.md` and `USER.md`, separated by `\n§\n`, with a
    `.lock` beside each.
- **Sessions.**
  - Writes go only through the gateway: `session_store().call("session.mutate",
    operation="import" | "rename")`, the same path `hermes sessions import` uses.
  - With no gateway running, one auto-starts with `--idle-exit` (it exits after 600s without
    clients) and serves the root's profiles.
  - Custom `source`, `title` (via rename; titles are unique) and `parent_session_id` all
    persist.
  - `SessionDB(read_only=True).search_messages(query, source_filter=[…])` finds by source, so an
    agent can be limited to its own chats; `session_search()` groups by lineage.
  - Neither calls a model.
- **Skills.**
  - `tools.skill_manager_tool.skill_manage("create" | "edit" | "delete", …, category="tethr")`
    and `tools.skills_tool.skills_list` / `skill_view` work with no model.
  - Saved skills are marked `created_by: learn`, which the curator's prune pass leaves alone.
  - Descriptions written through `skill_manage` must fit in 60 characters.
- **No model calls.** `hermes insights` on the profile after every operation showed
  `Total tokens: 0`. Telemetry defaults off and the profile also turns it off explicitly.
- **Profiles.** A profile tethr makes by hand (a folder + `config.yaml`) works with `hermes -p
  <name>`. `hermes profile create` was avoided because it can seed a model from the default
  profile.

## Decision
- One helper for everything (memory, import, search, skills); no `hermes serve`, no MCP plugin.
- `mcp-serve` exposes only gateway messaging conversations: no memory and no search.
