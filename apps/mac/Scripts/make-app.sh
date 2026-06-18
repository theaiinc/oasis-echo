#!/usr/bin/env bash
# Bundle the SwiftPM executable into a .app so launchctl/Finder treat
# it as a proper app (Info.plist, LSUIElement, mic permissions prompt).
#
# Usage:
#   ./Scripts/make-app.sh                          (release build, ad-hoc signed)
#   ./Scripts/make-app.sh debug                    (debug build, ad-hoc signed)
#
# Preserves the .app bundle across rebuilds (no rm -rf) so the file-system
# identity stays the same. Only updates the binary + Info.plist in place.
#
# Environment overrides (used by .github/workflows/mac-release.yml):
#   OASIS_VERSION         CFBundleShortVersionString (e.g. "0.2.0")
#   OASIS_BUILD_NUMBER    CFBundleVersion (e.g. CI run number)
#   OASIS_CODESIGN_IDENTITY
#     Set to a Developer ID Application cert to enable Hardened Runtime
#     + entitlements + timestamp for notarization. Unset or "-" → ad-hoc.

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

# Create bundle structure if first run; otherwise just update in place
# so the file-system identity (inode, path) is preserved.
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OasisEcho"
cp Info.plist "$APP/Contents/Info.plist"

# Optional version override for tagged release builds.
if [[ -n "${OASIS_VERSION:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $OASIS_VERSION" "$APP/Contents/Info.plist"
fi
if [[ -n "${OASIS_BUILD_NUMBER:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $OASIS_BUILD_NUMBER" "$APP/Contents/Info.plist"
fi

# Sign — ad-hoc by default. Self-signed certs aren't trusted by
# Gatekeeper on macOS 14+, which breaks AX TCC. Ad-hoc is simpler.
# The AppleScript paste fallback (Automation → System Events) persists
# across builds because it's tied to bundle ID, not the signing cert.
SIGN_IDENTITY="${OASIS_CODESIGN_IDENTITY:--}"
if [[ "$SIGN_IDENTITY" == "-" || -z "$SIGN_IDENTITY" ]]; then
  echo "→ ad-hoc signing (local dev only)"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
else
  echo "→ Developer ID signing as: $SIGN_IDENTITY"
  codesign --force \
           --options runtime \
           --timestamp \
           --entitlements "$ENTITLEMENTS" \
           --sign "$SIGN_IDENTITY" \
           "$APP"
  codesign --verify --strict --verbose=2 "$APP"
  spctl --assess --type execute --verbose=2 "$APP" || \
    echo "  (spctl may show 'rejected' until notarized)"
fi

echo "Built $APP"
echo "Open with:  open $APP"
