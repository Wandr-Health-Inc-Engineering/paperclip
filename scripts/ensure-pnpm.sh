#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

install_deps=false
if [[ "${1:-}" == "--install" ]]; then
  install_deps=true
fi

pnpm_version() {
  node -p "require('./package.json').packageManager.split('@')[1]" 2>/dev/null || echo "9.15.4"
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v node >/dev/null 2>&1; then
    echo "ERROR: Node.js 20+ is required (see package.json engines)." >&2
    echo "Install Node from https://nodejs.org/ or use nvm/fnm." >&2
    exit 1
  fi

  local version
  version="$(pnpm_version)"

  if command -v corepack >/dev/null 2>&1; then
    echo "pnpm not found; activating pnpm@${version} via corepack..."
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@${version}" --activate
  fi

  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm is required but not available on PATH." >&2
    echo "Try: corepack enable && corepack prepare pnpm@${version} --activate" >&2
    echo "Or:  npm install -g pnpm@${version}" >&2
    exit 1
  fi
}

ensure_pnpm

if [[ "$install_deps" == true && ! -d node_modules ]]; then
  echo "node_modules missing; running pnpm install..."
  pnpm install
fi
