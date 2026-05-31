#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must run on macOS."
  exit 1
fi

cd "$ROOT_DIR"

# Mirror the `prebuild` lifecycle hook. The release script intentionally
# calls `tauri build` directly (not `bun run build`) so the lifecycle hook
# does NOT fire automatically. Reproduce it here so a release never ships
# with a stale or missing embedded pi binary / extension bundle.
echo "Fetching embedded pi binary (idempotent if version matches)..."
bun run "$ROOT_DIR/scripts/fetch-pi-binary.js"
echo "Building extensions bundle..."
bun run "$ROOT_DIR/scripts/build-extensions.js"

echo "Building macOS DMG via Tauri (standard bundler path)..."
PATH="$HOME/.cargo/bin:$PATH" tauri build --bundles dmg

DMG_PATH="$(ls -t "$BUNDLE_DIR"/*.dmg | head -n 1)"
if [[ -z "${DMG_PATH:-}" ]]; then
  echo "No DMG produced under $BUNDLE_DIR"
  exit 1
fi

echo "Inspecting DMG: $DMG_PATH"
MOUNT_OUTPUT="$(hdiutil attach "$DMG_PATH" -nobrowse -readonly)"
MOUNT_POINT="$(printf '%s\n' "$MOUNT_OUTPUT" | rg '/Volumes/' | awk '{print $NF}' | head -n 1)"

cleanup() {
  if [[ -n "${MOUNT_POINT:-}" ]] && mount | rg -q "$MOUNT_POINT"; then
    hdiutil detach "$MOUNT_POINT" >/dev/null
  fi
}
trap cleanup EXIT

APP_PATH="$(ls -d "$MOUNT_POINT"/*.app | head -n 1)"
if [[ -z "${APP_PATH:-}" ]]; then
  echo "No .app found inside mounted DMG."
  exit 1
fi

SIGN_INFO="$(codesign -dvv "$APP_PATH" 2>&1 || true)"

if codesign --verify --deep --strict --verbose=2 "$APP_PATH" >/dev/null 2>&1; then
  echo "Code signature integrity: OK"
else
  echo "ERROR: signature appears broken or incomplete."
  echo "$SIGN_INFO"
  exit 1
fi

SPCTL_OUTPUT="$(spctl -a -vv "$APP_PATH" 2>&1 || true)"
if ! printf '%s' "$SPCTL_OUTPUT" | rg -q 'rejected'; then
  echo "ERROR: unexpected Gatekeeper assessment."
  echo "$SPCTL_OUTPUT"
  exit 1
fi

if printf '%s' "$SPCTL_OUTPUT" | rg -qi 'sealed resource is missing or invalid|damaged'; then
  echo "ERROR: Gatekeeper reports damaged/invalid sealed resources."
  echo "$SPCTL_OUTPUT"
  exit 1
fi

echo "Gatekeeper assessment indicates a blocked but not damaged app."
echo "$SPCTL_OUTPUT"
echo
echo "Publish this DMG directly. Do not modify the .app after bundling."
