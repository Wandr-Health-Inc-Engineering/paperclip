# Tethr Command Center

A local, double-clickable viewer/manager for the **00 Tethr** Google Drive folder —
the same idea as the Wandr Social Command Center, but for Tethr's deliverables. Read
the Markdown files nicely and organize the folder (new folder, rename, move, archive)
**without opening the Tethr web app**.

It operates directly on the synced folder on disk, so what you see is exactly what's in
Google Drive, and your changes sync back.

Two ways to run it: a **native macOS app** (its own window, no browser) or the **browser**
version. Same UI and the same zero-dep server underneath — the native app just wraps it.

## Native app (recommended)

A real, standalone `Tethr Command Center.app` — its own window with no browser chrome,
holding the Tethr aesthetic (black/white, 2px borders, Finder-style tree + preview split).
It boots the server as a hidden child process on a private loopback port and shuts it down
when you quit.

```bash
./build-app.sh                              # build it → ./build/Tethr Command Center.app
open "build/Tethr Command Center.app"       # or double-click it in Finder
```

- **Build once** with `build-app.sh` — needs the Swift toolchain (Xcode Command Line Tools:
  `xcode-select --install`). **Running** the app still needs **Node ≥ 20** on the machine
  (the app doesn't bundle Node); it auto-finds Homebrew / nvm / Volta installs.
- Self-contained: the server + UI are copied into the `.app`, so you can drag it to
  `/Applications` or the Dock. Rebuild to pick up UI changes.
- First launch may show macOS Gatekeeper ("unidentified developer") — **right-click → Open**
  once, or the build already ad-hoc-signs + clears quarantine so it usually opens directly.
- The `Open Tethr Command Center.command` in the **00 Tethr** Drive folder opens this app if
  it's built (else falls back to the browser version).

## Browser version

```bash
./start.command        # double-click in Finder, or run in a terminal
```

That starts the same local server and opens `http://localhost:4848`. Requires **Node ≥ 20**
(no other dependencies). To stop it: close the terminal, or `pkill -f tethr-command-center`.

## What it does

- **Read** — click any file; Markdown renders (headings, tables, code, front-matter). Other
  text files show raw; binaries prompt you to open them in Finder/Drive.
- **Organize** — New folder, Rename, Move (into any folder), Archive.
- **Archive = soft delete** — "deleted" items move to `99 Archive`, never hard-deleted.

## Safety

- Binds **loopback only** (`127.0.0.1`) — not reachable off this machine.
- Every path is **confined to the 00 Tethr folder**; traversal (`../`) is stripped.
- Single-writer: if it's already running, a second launch just opens the browser.
- **Native app** adds no privilege — it's the same loopback server in a `WKWebView`, on a
  private random port. The child server is stopped when you quit; it also self-exits if the
  app is force-killed or crashes (via `TETHR_CC_PARENT_PID`), so nothing is left running.

## Config

- `TETHR_MIRROR_DIR` — the folder to manage (defaults to the value in your Paperclip
  instance `.env`, then the known `00 Tethr` path).
- `TETHR_CC_PORT` — port (default `4848`).
