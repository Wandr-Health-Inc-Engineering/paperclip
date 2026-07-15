# Tethr Command Center

A local, double-clickable viewer/manager for the **00 Tethr** Google Drive folder —
the same idea as the Wandr Social Command Center, but for Tethr's deliverables. Read
the Markdown files nicely and organize the folder (new folder, rename, move, archive)
**without opening the Tethr web app**.

It operates directly on the synced folder on disk, so what you see is exactly what's in
Google Drive, and your changes sync back.

## Run it

```bash
./start.command        # double-click in Finder, or run in a terminal
```

That starts a tiny local server and opens `http://localhost:4848`. Requires **Node ≥ 20**
(no other dependencies). To stop it: close the terminal, or `pkill -f tethr-command-center`.

## What it does

- **Read** — click any file; Markdown renders (headings, tables, code, front-matter). Other
  text files show raw; binaries prompt you to open them in Finder/Drive.
- **Organize** — New folder, Rename, Move (into any folder), Archive.
- **Archive = soft delete** — "deleted" items move to `99 Archive`, never hard-deleted.

## Safety

- Binds **loopback only** (`127.0.0.1:4848`) — not reachable off this machine.
- Every path is **confined to the 00 Tethr folder**; traversal (`../`) is stripped.
- Single-writer: if it's already running, a second launch just opens the browser.

## Config

- `TETHR_MIRROR_DIR` — the folder to manage (defaults to the value in your Paperclip
  instance `.env`, then the known `00 Tethr` path).
- `TETHR_CC_PORT` — port (default `4848`).
