# Phase 19 — Score growth lists with Jev (2026-11-07)

Mark picked "score growth lists" as the first use of **Jev** (TypeSafe AI's decision model:
yes/no probabilities, pick-from-list, 0–10 scores; it doesn't write text; about $0.042 per
million input tokens; output is free). The chat (one Claude Code session per thread) gets
**Tethr's own tools** so it can score hundreds of keywords, leads or posts in seconds, then
write up only the top ones.

## How the chat gets Tethr's tools
- A per-turn `--mcp-config` adds one stdio MCP server, **`tethr`**, next to Mark's claude.ai
  connectors. It is never `--strict-mcp-config`, because that would drop the connectors.
- The server is a tiny zero-dependency bridge script (`assistant/tools-bridge.ts`). It is
  content-addressed in the instance dir, like the hook script. It speaks MCP JSON-RPC over
  stdio and forwards `tools/list` and `tools/call` to
  `POST /api/tethr/assistant/tools/:op`, using the turn's hook token.
- The token and URL reach the bridge through the config's `env`. The config file is per turn
  (named by run id), mode 0600, and deleted after the turn.
- Secrets (TypeSafe key, Google Ads) stay in the Tethr server; the Claude process never sees
  them.
- Every call still passes the PreToolUse approval gate. In policy, connector **"Tethr tools"**
  (server `tethr`) is a `read` class: no side effects, allowed unless set to Off in
  Integrations.
- These tools don't taint the thread: they bring in no private data. The endpoint re-checks
  the Off mode itself.

## Tools (`server/src/tethr/assistant/tethr-tools.ts`)
- **`keyword_ideas`** `{seeds ≤20, geo?, limit≤500, save_as?}`: the existing Keyword Planner
  client. It returns the ideas by volume, and with `save_as` it writes `files/<name>.csv` so
  score_list can read it without the list going back through Claude.
- **`score_list`** `{items | from_file, criteria[1..8], context?, top?, save_as?}`:
  - Criteria types: `score` (levels, low to high), `yes_no` (with `want: yes|no`), `choice`
    (options).
  - Each item gets one Jev request: state = item (+ the shared context), with all criteria
    as questions in parallel.
  - Requests run 8 at a time, retrying 429/529 with backoff (respecting `retry-after`), with a
    30s timeout each.
  - The composite is the weighted mean of normalized scores and yes/no probabilities, and
    answers with low confidence are flagged.
  - It returns a top-N table plus failures, model, tokens and cost, and writes all rows to
    `files/<name>.csv`.
  - `from_file` reads a CSV or line list from the workspace `files/` (root-confined).
  - Limits: 500 items, 4,000 characters per item and per context.
- Jev client `server/src/tethr/jev.ts`: raw `fetch` to `POST /v1/systemone`, Bearer
  `TYPESAFE_API_KEY`, model `TETHR_JEV_MODEL` (default `jev-latest`), base URL
  `TYPESAFE_API_URL` for tests. With no key, score_list says so plainly and tells Claude to
  score the list itself.
- Activity log `tethr_jev_scored` (items, tokens, ms, model); no raw content is stored.

## UI and copy
- `events.ts`: a score_list or keyword_ideas call with `save_as` becomes a file hop, so the
  CSV shows as a chip and opens in the side panel.
- Integrations lists "Tethr tools" with whether Jev is connected. `integrationRulesText`
  tells the chat when to use them.

## Tests
`tethr-jev.test.ts`:
- request shape
- composite math
- retries
- no-key message
- CSV round trip
- from_file confinement
- the bridge's JSON-RPC handling
- the endpoint's token auth and Off mode
- policy classifying `mcp__tethr__*` as read

## Verify
- A live chat turn calls `keyword_ideas` (real Google Ads), then `score_list` against a local
  fake Jev server.
- The CSV opens in the panel.
- With no key: a clear message, and Claude scores the list itself.

## Manual (Mark)
Get a Jev key at console.typesafe.ai (early access), put `TYPESAFE_API_KEY=` in
`~/.paperclip/instances/default/.env`, and restart.
