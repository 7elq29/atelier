#!/usr/bin/env bash
# macOS dev only: duplicate Electron.app as Atelier.app so Dock + menu show "Atelier"
# (app.setName alone does not change the Dock tooltip while running Electron.app).
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/node_modules/electron/dist"
SRC_APP="$DIST/Electron.app"
APP="$DIST/Atelier.app"
MARKER="$APP/.electron-version"
ELECTRON_PKG="$ROOT/node_modules/electron/package.json"

if [[ ! -d "$SRC_APP" ]]; then
  echo "ensure-atelier-electron-mac: Electron.app not found, skipping" >&2
  exit 0
fi

WANT_VER=""
if [[ -f "$ELECTRON_PKG" ]]; then
  WANT_VER="$(node -p "require('$ELECTRON_PKG').version" 2>/dev/null || true)"
fi

needs_copy=0
if [[ ! -d "$APP" ]]; then
  needs_copy=1
elif [[ -n "$WANT_VER" && ( ! -f "$MARKER" || "$(cat "$MARKER")" != "$WANT_VER" ) ]]; then
  rm -rf "$APP"
  needs_copy=1
fi

if [[ "$needs_copy" == 1 ]]; then
  echo "ensure-atelier-electron-mac: installing $APP (Electron $WANT_VER)"
  cp -R "$SRC_APP" "$APP"
  mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/Atelier"
  PLIST="$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleName Atelier" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Atelier" "$PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Atelier" "$PLIST"
  printf '%s' "$WANT_VER" >"$MARKER"
fi

ICON_ICNS="$ROOT/build/icon.icns"
if [[ -f "$ICON_ICNS" && -d "$APP" ]]; then
  cp "$ICON_ICNS" "$APP/Contents/Resources/icon.icns"
  PLIST="$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Set :CFBundleIconFile icon" "$PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string icon" "$PLIST"
fi

# When sourced (npm run dev), export for electron-vite spawn.
export ELECTRON_EXEC_PATH="$APP/Contents/MacOS/Atelier"
