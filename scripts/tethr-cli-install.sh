#!/usr/bin/env bash
# Install the `tethr` terminal client as a command on your PATH.
#
# There is no npm package to install: tethr-cli.mjs is a single, zero-dependency
# Node script with its own shebang, so the file IS the executable. This just
# symlinks it into a bin directory. The only requirement is Node >= 20.
#
#   ./scripts/tethr-cli-install.sh                       # -> ~/.local/bin/tethr
#   ./scripts/tethr-cli-install.sh /usr/local/bin/tethr  # custom target (may need sudo)
#
# After installing, point it at a server with TETHR_URL (defaults to a local
# dev server on :3100/:5173). Remote access guide: LOCAL.md section 6.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tethr-cli.mjs"
DEST="${1:-$HOME/.local/bin/tethr}"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found — install Node >= 20 first (https://nodejs.org)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node $(node -v) found, but tethr needs Node >= 20." >&2
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
chmod +x "$SRC"
ln -sf "$SRC" "$DEST"
echo "Installed: $DEST -> $SRC"

BIN_DIR="$(dirname "$DEST")"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "$BIN_DIR is not on your PATH yet. Add it:"
    echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc && source ~/.zshrc"
    ;;
esac
echo
echo "Try it:  tethr /status"
echo "Remote:  export TETHR_URL=http://<server-host>:5173   (see LOCAL.md section 6)"
