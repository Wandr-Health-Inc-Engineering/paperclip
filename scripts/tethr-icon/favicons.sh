#!/bin/bash
# Render tethr's favicons and home-screen icons from the nebula mark
# (make-icon.swift, the same renderer as the desktop app icons) into ui/public/.
# macOS only: needs swiftc (Xcode Command Line Tools) and sips. favicon.svg is
# hand-drawn vector art in this folder's style and isn't touched here.
#
#   scripts/tethr-icon/favicons.sh

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC="$(cd "$DIR/../../ui/public" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

swiftc -O -o "$TMP/make-icon" "$DIR/make-icon.swift"
"$TMP/make-icon" "$TMP/tile.png" tile      # browser tabs: the rounded tile
"$TMP/make-icon" "$TMP/square.png" square  # home screens round the corners themselves

resize() { sips -z "$2" "$2" "$1" --out "$3" >/dev/null; }
resize "$TMP/tile.png" 16 "$PUBLIC/favicon-16x16.png"
resize "$TMP/tile.png" 32 "$PUBLIC/favicon-32x32.png"
resize "$TMP/tile.png" 48 "$TMP/favicon-48.png"
sips -s format ico "$TMP/favicon-48.png" --out "$PUBLIC/favicon.ico" >/dev/null
resize "$TMP/square.png" 180 "$PUBLIC/apple-touch-icon.png"
resize "$TMP/square.png" 192 "$PUBLIC/android-chrome-192x192.png"
resize "$TMP/square.png" 512 "$PUBLIC/android-chrome-512x512.png"
echo "Wrote favicons and home-screen icons to $PUBLIC"
