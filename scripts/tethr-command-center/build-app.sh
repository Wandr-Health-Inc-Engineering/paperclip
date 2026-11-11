#!/bin/bash
# Build "Tethr Command Center.app" — a native macOS shell around the local
# Command Center web UI. Requires the Swift toolchain (Xcode Command Line Tools:
# `xcode-select --install`). Node is still needed at RUN time (the app boots the
# zero-dep Node server as a child process); nothing here bundles Node.
#
#   ./build-app.sh
#
# Output: ./build/Tethr Command Center.app  (self-contained; the server + UI are
# copied into Contents/Resources, so the .app runs even if moved).

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Tethr Command Center"
BUILD="$DIR/build"
APP="$BUILD/$APP_NAME.app"
CONTENTS="$APP/Contents"

command -v swiftc >/dev/null 2>&1 || {
  echo "error: swiftc not found. Install the Xcode Command Line Tools:" >&2
  echo "       xcode-select --install" >&2
  exit 1
}

echo "→ Cleaning $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"

echo "→ Compiling Swift shell"
swiftc -O -swift-version 5 \
  -framework AppKit -framework WebKit \
  -o "$CONTENTS/MacOS/TethrCommandCenter" \
  "$DIR/macapp/main.swift"

echo "→ Writing Info.plist"
cp "$DIR/macapp/Info.plist" "$CONTENTS/Info.plist"

echo "→ Bundling server + UI (self-contained)"
mkdir -p "$CONTENTS/Resources/command-center"
cp "$DIR/server.mjs" "$CONTENTS/Resources/command-center/server.mjs"
cp -R "$DIR/public" "$CONTENTS/Resources/command-center/public"

echo "→ Rendering app icon (best-effort)"
ICON_OK=0
if swiftc -O -o "$BUILD/make-icon" "$DIR/macapp/make-icon.swift" 2>/dev/null \
   && "$BUILD/make-icon" "$BUILD/icon_1024.png" 2>/dev/null; then
  ICONSET="$BUILD/AppIcon.iconset"
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  make_size() { sips -z "$1" "$1" "$BUILD/icon_1024.png" --out "$ICONSET/$2" >/dev/null 2>&1 || true; }
  make_size 16   icon_16x16.png
  make_size 32   icon_16x16@2x.png
  make_size 32   icon_32x32.png
  make_size 64   icon_32x32@2x.png
  make_size 128  icon_128x128.png
  make_size 256  icon_128x128@2x.png
  make_size 256  icon_256x256.png
  make_size 512  icon_256x256@2x.png
  make_size 512  icon_512x512.png
  cp "$BUILD/icon_1024.png" "$ICONSET/icon_512x512@2x.png"
  if iconutil -c icns "$ICONSET" -o "$CONTENTS/Resources/AppIcon.icns" 2>/dev/null; then
    ICON_OK=1
  fi
  rm -rf "$ICONSET" "$BUILD/make-icon" "$BUILD/icon_1024.png"
fi
[ "$ICON_OK" = 1 ] && echo "  icon: ok" || echo "  icon: skipped (using the generic app icon)"

echo "→ Ad-hoc signing + clearing quarantine"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign skipped)"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo
echo "Built: $APP"
echo "Open with:  open \"$APP\""
