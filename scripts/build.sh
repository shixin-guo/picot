#!/usr/bin/env bash
#
# Picot Local Build Script
#
# Builds Picot artifacts on the local machine for internal QA. Does NOT
# touch git, does NOT bump versions, does NOT push tags, does NOT publish
# a release. Public release remains the job of:
#   - scripts/release.sh
#   - .github/workflows/release.yml
#
# Usage:
#   ./scripts/build.sh [platform]
#
# Platforms:
#   mac-arm      Apple Silicon DMG (aarch64-apple-darwin)
#   mac-intel    Intel Mac DMG, cross-compiled on Apple Silicon hosts
#   windows      Bare .exe + zip, cross-compiled via MinGW (no MSI)
#   current      Detect host OS + arch, dispatch to the matching builder
#
# Prerequisites:
#   - macOS host (or Linux for windows cross only)
#   - Rust via rustup (NOT Homebrew — Homebrew rust breaks cross-compile)
#   - Bun (project uses Bun only; never npm/pnpm)
#   - For windows: MinGW (`brew install mingw-w64`) and the
#     x86_64-pc-windows-gnu rustup target (auto-installed on first run)
#
# Scope:
#   - macOS: ad-hoc signed only (signingIdentity: "-" in tauri.conf.json).
#     No Apple Developer cert, no notarization. Gatekeeper will block the
#     first launch; right-click Open to bypass.
#   - Windows: bare .exe + zip. No MSI (requires Windows host tools).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Augment PATH so the locally-installed `tauri` shim
# (node_modules/.bin/tauri) is resolvable. `bun run` does this
# automatically; a direct shell invocation does not.
if [ -d "$PROJECT_ROOT/node_modules/.bin" ]; then
    export PATH="$PROJECT_ROOT/node_modules/.bin:$PATH"
fi
if [ -d "$HOME/.cargo/bin" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# Tauri CLI v2 reads $CI and forwards it as `--ci`. The v2 CLI accepts
# only `true`/`false` for --ci, but many CI environments set `CI=1`,
# which the parser rejects with: "invalid value '1' for '--ci'".
# Local builds are not CI, so unset unconditionally.
unset CI

# ---------- Logging ----------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ---------- Prereqs ----------

check_requirements() {
    log_info "Checking requirements..."

    if ! command -v bun >/dev/null 2>&1; then
        log_error "bun is not installed. Install: https://bun.sh"
        exit 1
    fi

    if ! command -v cargo >/dev/null 2>&1; then
        log_error "cargo is not installed. Install Rust via rustup: https://rustup.rs"
        exit 1
    fi

    if ! command -v rustup >/dev/null 2>&1; then
        log_error "rustup is not installed. Homebrew rust breaks cross-compile; use rustup."
        exit 1
    fi

    if [ "$BUILD_PLATFORM" = "windows" ]; then
        if ! command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
            log_error "MinGW is required for Windows cross-compilation."
            log_info "Install with: brew install mingw-w64 (macOS) or apt install mingw-w64 (Linux)"
            exit 1
        fi
        if ! command -v zip >/dev/null 2>&1; then
            log_error "zip is required to package the Windows artifact."
            exit 1
        fi
    fi

    if [ "$BUILD_PLATFORM" = "mac-arm" ] || [ "$BUILD_PLATFORM" = "mac-intel" ]; then
        if [ "$(uname -s)" != "Darwin" ]; then
            log_error "macOS builds must run on macOS (or use a remote macOS host)."
            exit 1
        fi
    fi

    log_info "All requirements satisfied."
}

# ---------- Deps ----------

# Picot uses Bun exclusively (see AGENTS.md). Never npm/pnpm.
install_deps() {
    log_info "Installing dependencies (bun)..."
    bun install --frozen-lockfile
}

# Mirrors tauri.conf.json's beforeBuildCommand. Run explicitly so the
# pre-build hooks also fire when the script shells out to `tauri build`
# (Tauri fires beforeBuildCommand only on direct `tauri` CLI invocations).
run_picot_prebuild() {
    log_info "Fetching embedded pi binary..."
    bun run "$PROJECT_ROOT/scripts/fetch-pi-binary.js"
    log_info "Building extensions bundle..."
    bun run "$PROJECT_ROOT/scripts/build-extensions.js"
}

# ---------- Builders ----------

# Copy the most recently built DMG from a builder's bundle dir to
# the repo root for easy distribution. Glob the bundle dir for the
# newest Picot_*.dmg, copy it, and log its sha256 so the user can
# verify integrity before sharing the file.
copy_dmg_to_root() {
    local bundle_dir="$1"
    local label="$2"
    local dmg
    dmg=$(ls -t "$bundle_dir"/dmg/Picot_*.dmg 2>/dev/null | head -n 1)
    if [ -z "$dmg" ]; then
        log_warn "No DMG found under $bundle_dir/dmg/ to copy."
        return 0
    fi
    cp "$dmg" "$PROJECT_ROOT/"
    local dest="$PROJECT_ROOT/$(basename "$dmg")"
    local sha
    sha=$(shasum -a 256 "$dest" | awk '{print $1}')
    log_info "Copied to repo root: $dest"
    log_info "  sha256: $sha"
    log_info "  arch:   $label"
}

# Apple Silicon host build.
build_mac_arm() {
    local target="aarch64-apple-darwin"
    log_info "Building for macOS Apple Silicon ($target)..."

    rustup target add "$target" 2>/dev/null || true
    PATH="$HOME/.cargo/bin:$PATH" tauri build --target "$target" --bundles dmg

    local bundle_dir="src-tauri/target/$target/release/bundle"
    log_info "macOS arm64 build completed."
    log_info "  DMG: $bundle_dir/dmg/Picot_*.dmg  (Picot.app is bundled inside)"
    log_info "Note: ad-hoc signed. Gatekeeper will block first launch; right-click Open to bypass."
    copy_dmg_to_root "$bundle_dir" "arm64"
}

# Intel Mac, cross-compiled from an Apple Silicon host.
build_mac_intel() {
    local target="x86_64-apple-darwin"
    log_info "Building for macOS Intel ($target)..."

    rustup target add "$target" 2>/dev/null || true
    PATH="$HOME/.cargo/bin:$PATH" tauri build --target "$target" --bundles dmg

    local bundle_dir="src-tauri/target/$target/release/bundle"
    log_info "macOS Intel build completed."
    log_info "  DMG: $bundle_dir/dmg/Picot_*.dmg  (Picot.app is bundled inside)"
    log_info "Note: ad-hoc signed. Gatekeeper will block first launch; right-click Open to bypass."
    copy_dmg_to_root "$bundle_dir" "x86_64"
}

# Universal (arm64 + x86_64) build. Tauri runs cargo for both archs
build_mac_universal() {
    local target="universal-apple-darwin"
    log_info "Building for macOS universal ($target)..."

    # Universal requires both arch targets to be installed. Add them
    # idempotently so a fresh dev box can build universal without a
    # prior single-arch build.
    rustup target add aarch64-apple-darwin 2>/dev/null || true
    rustup target add x86_64-apple-darwin 2>/dev/null || true

    PATH="$HOME/.cargo/bin:$PATH" tauri build --target "$target" --bundles dmg

    local bundle_dir="src-tauri/target/$target/release/bundle"
    log_info "macOS universal build completed."
    log_info "  DMG: $bundle_dir/dmg/Picot_*.dmg  (Picot.app is bundled inside, fat binary)"
    log_info "Note: ad-hoc signed. Gatekeeper will block first launch; right-click Open to bypass."
    copy_dmg_to_root "$bundle_dir" "universal"
}

# Windows cross-compile via MinGW. Bare .exe + zip, no MSI/NSIS (those
# bundlers require Windows host tools). Matches the palangent tradeoff.
build_windows() {
    local target="x86_64-pc-windows-gnu"
    log_info "Building for Windows ($target) via MinGW..."

    # The pi binary in resources/pi/ is host-platform. We need the
    # Windows pi binary for a Windows build. The .version marker
    # fetch-pi-binary.js uses for idempotency does not encode the
    # platform, so we must clear the directory before re-fetching
    # with PI_TARGET_PLATFORM=windows-x64 — otherwise the script
    # sees a matching version marker and skips, leaving the macOS
    # pi binary in place.
    # Tauri's beforeBuildCommand runs `bun run fetch:pi` without an env
    # override, which would re-fetch the host (mac) pi and clobber the
    # Windows binary we want. Exporting PI_TARGET_PLATFORM makes the
    # sub-process fetch honor our target. The fetch also runs once up
    # front (after clearing the stale host tree) so the very first
    # build gets the right binary even if Tauri's hook is a no-op.
    export PI_TARGET_PLATFORM=windows-x64
    log_info "Fetching Windows pi binary..."
    rm -rf "$PROJECT_ROOT/src-tauri/resources/pi"
    bun run "$PROJECT_ROOT/scripts/fetch-pi-binary.js"

    rustup target add "$target" 2>/dev/null || true
    export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="x86_64-w64-mingw32-gcc"
    # Workaround: src-tauri/build.rs uses cfg!(target_os = "windows")
    # to decide whether to look for `pi.exe` (Windows) or `pi` (host).
    # In a build.rs, cfg! reflects the HOST cfg, not the target — so
    # cross-compiling from macOS to Windows always evaluates to false,
    # and the panic guard looks for `pi` (which is the macOS binary).
    # We bypass the guard for the local cross-build: the script
    # explicitly fetches the Windows pi binary above and copies it
    # into the resource dir via Tauri's resource map, so we know it's
    # there. The guard's raison d'être (preventing developers from
    # forgetting `bun run fetch:pi`) doesn't apply to a script-driven
    # build. The proper fix is to read CARGO_CFG_TARGET_OS in
    # build.rs, which is a separate change.
    export PI_STUDIO_SKIP_BIN_CHECK=1
    # --no-bundle: NSIS/MSI bundlers require Windows host tools. Cross-
    # compiling from macOS only produces the bare .exe + side files.
    PATH="$HOME/.cargo/bin:$PATH" tauri build --target "$target" --no-bundle
    local release_dir="src-tauri/target/$target/release"

    # Verify the Windows pi binary made it into the build output. Tauri
    # copies src-tauri/resources/pi/ into the target's resource dir during
    # the build. If the file is a Mach-O (or anything other than a Windows
    # PE), something went wrong with the cross-platform fetch above.
    if [ ! -f "$release_dir/Picot.exe" ]; then
        log_error "Expected $release_dir/Picot.exe not found after build."
        exit 1
    fi

    local version
    version=$(node -p "require('./package.json').version")
    local zip_name="Picot_${version}_windows_x64.zip"
    # Zip only the runtime artifacts. The release dir also contains cargo
    # intermediates (build/, deps/, incremental/, examples/, *.d) which
    # are not needed at runtime and bloat the zip by ~250 MB.
    # Start from a clean archive: `zip -r` updates an existing zip in place
    # and `-x` only skips *adding* files — it does not remove entries already
    # baked into a stale zip. Delete first so repeated builds are idempotent
    # and no stray .DS_Store from a prior run survives.
    rm -f "$PROJECT_ROOT/$zip_name"
    (cd "$release_dir" && zip -r "$PROJECT_ROOT/$zip_name" \
        Picot.exe \
        WebView2Loader.dll \
        pi \
        extensions \
        public \
        -x '*.DS_Store' \
        -x '**/.DS_Store')

    log_info "Windows build completed."
    log_info "  Zip: $PROJECT_ROOT/$zip_name"
    log_info "  Contents: Picot.exe + bundled DLLs + embedded pi tree + extensions"
    log_info "Note: no MSI. Testers unzip and run Picot.exe directly."
}


# ---------- Help / parse ----------

show_help() {
    cat <<EOF
Picot Local Build Script

Builds Picot artifacts on the local machine for internal QA. Does NOT
publish a release; use scripts/release.sh + GitHub Actions for that.

Usage:
  ./scripts/build.sh [platform]

Platforms:
  mac-arm      Apple Silicon DMG (aarch64-apple-darwin)
  mac-intel    Intel Mac DMG (x86_64-apple-darwin), cross-compiled
  mac-universal  Universal DMG (arm64 + x86_64 fat binary)
  windows      Bare .exe + zip, cross-compiled via MinGW (no MSI)
  current      Detect host OS/arch and dispatch (default)

Examples:
  ./scripts/build.sh mac-arm
  ./scripts/build.sh mac-universal
  ./scripts/build.sh windows

Notes:
  - macOS artifacts are ad-hoc signed. Gatekeeper will block first launch;
    right-click Open to bypass.
  - Windows cross-build requires MinGW: brew install mingw-w64
  - Final artifacts are copied to the repo root for easy distribution
    (e.g. Picot_0.2.3_aarch64.dmg, Picot_0.2.3_windows_x64.zip).
  - The script never touches git, never creates tags, never pushes.
EOF
}

parse_args() {
    BUILD_PLATFORM="current"

    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help|help)
                show_help
                exit 0
                ;;
            mac-arm|mac-intel|mac-universal|windows|current)
                BUILD_PLATFORM="$1"
                shift
                ;;
            *)
                log_error "Unknown argument: $1"
                echo
                show_help
                exit 1
                ;;
        esac
    done
}

# ---------- Main ----------

main() {
    parse_args "$@"

    if [ "$BUILD_PLATFORM" = "current" ]; then
        case "$(uname -s)" in
            Darwin)
                case "$(uname -m)" in
                    arm64)  BUILD_PLATFORM="mac-arm" ;;
                    x86_64) BUILD_PLATFORM="mac-intel" ;;
                esac
                ;;
        esac
    fi

    check_requirements
    install_deps
    run_picot_prebuild

    case "$BUILD_PLATFORM" in
        mac-arm)         build_mac_arm ;;
        mac-intel)       build_mac_intel ;;
        mac-universal)   build_mac_universal ;;
        windows)         build_windows ;;
        *)
            log_error "Cannot determine platform (host OS: $(uname -s), arch: $(uname -m))."
            log_info "Pass an explicit platform: mac-arm | mac-intel | windows"
            exit 1
            ;;
    esac

    log_info "Build completed. Artifact ready for internal QA."
    log_info "Reminder: this script does NOT publish. Use scripts/release.sh for the public release."
}

main "$@"
