#!/usr/bin/env bash
# Bundle the SwiftPM executable into a .app so launchctl/Finder treat
# it as a proper app (Info.plist, LSUIElement, mic permissions prompt).
# Usage:  ./Scripts/make-app.sh         (release build)
#         ./Scripts/make-app.sh debug   (debug build)

set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG="${1:-release}"
if [[ "$CONFIG" == "release" ]]; then
  swift build -c release
  BIN=".build/release/OasisEcho"
else
  swift build
  BIN=".build/debug/OasisEcho"
fi

APP="OasisEcho.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OasisEcho"
cp Info.plist "$APP/Contents/Info.plist"

# Ad-hoc sign so Core Audio / Speech frameworks accept us locally.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true

echo "Built $APP"
echo "Open with:  open $APP"
