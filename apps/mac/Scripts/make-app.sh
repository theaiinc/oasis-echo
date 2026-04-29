#!/usr/bin/env bash
# Bundle the SwiftPM executable into a .app so launchctl/Finder treat
# it as a proper app (Info.plist, LSUIElement, mic permissions prompt).
#
# Usage:
#   ./Scripts/make-app.sh                          (release build, ad-hoc signed)
#   ./Scripts/make-app.sh debug                    (debug build, ad-hoc signed)
#
# Environment overrides (used by .github/workflows/mac-release.yml,
# also useful locally when you have a Developer ID cert installed):
#   OASIS_VERSION         CFBundleShortVersionString to write into Info.plist
#                         (e.g. "0.2.0"). Defaults to whatever Info.plist already has.
#   OASIS_BUILD_NUMBER    CFBundleVersion to write into Info.plist (e.g. a CI run number).
#                         Defaults to existing.
#   OASIS_CODESIGN_IDENTITY
#                         Codesign identity. Set to a Developer ID Application
#                         identity (e.g. "Developer ID Application: Acme Inc (TEAMID)")
#                         to enable Hardened Runtime + entitlements + timestamp,
#                         producing a binary suitable for notarization. If unset
#                         or "-", we ad-hoc sign — fine for local dev, but not
#                         distributable without users hitting Gatekeeper.

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
ENTITLEMENTS="OasisEcho.entitlements"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/OasisEcho"
cp Info.plist "$APP/Contents/Info.plist"

# Optional version override — convenient for tagged release builds.
if [[ -n "${OASIS_VERSION:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $OASIS_VERSION" "$APP/Contents/Info.plist"
fi
if [[ -n "${OASIS_BUILD_NUMBER:-}" ]]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $OASIS_BUILD_NUMBER" "$APP/Contents/Info.plist"
fi

# Codesign. Two modes:
#   - Real Developer ID identity → Hardened Runtime + entitlements + timestamp.
#     Required for notarization and quarantine-free distribution.
#   - Empty / "-"                 → ad-hoc. Local dev only; users will hit
#     "OasisEcho.app cannot be opened" Gatekeeper warnings.
SIGN_IDENTITY="${OASIS_CODESIGN_IDENTITY:--}"
if [[ "$SIGN_IDENTITY" == "-" || -z "$SIGN_IDENTITY" ]]; then
  echo "→ ad-hoc signing (local dev only — not distributable)"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
else
  echo "→ Developer ID signing as: $SIGN_IDENTITY"
  codesign --force \
           --options runtime \
           --timestamp \
           --entitlements "$ENTITLEMENTS" \
           --sign "$SIGN_IDENTITY" \
           "$APP"
  # Verify the signature matches notarization requirements before we
  # ever upload it; catches missing flags here, not 30 minutes later
  # when notarytool rejects the staple.
  codesign --verify --strict --verbose=2 "$APP"
  spctl --assess --type execute --verbose=2 "$APP" || \
    echo "  (spctl assessment may show 'rejected' until the bundle is notarized)"
fi

echo "Built $APP"
echo "Open with:  open $APP"
