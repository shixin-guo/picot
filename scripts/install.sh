#!/usr/bin/env bash
# Picot installer — macOS & Linux
# Usage:  curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash
# Or:     curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash -s -- --version v0.3.0
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
REPO="shixin-guo/picot"
GITHUB_API="https://api.github.com/repos/${REPO}/releases"
GITHUB_DL="https://github.com/${REPO}/releases/download"
APP_NAME="Picot"

# ── Colors ────────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="\033[1m"; GREEN="\033[1;32m"; YELLOW="\033[1;33m"
  RED="\033[1;31m"; CYAN="\033[1;36m"; RESET="\033[0m"
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; CYAN=""; RESET=""
fi

info()    { printf "  ${CYAN}•${RESET} %s\n" "$*"; }
success() { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
warn()    { printf "  ${YELLOW}⚠${RESET} %s\n" "$*"; }
error()   { printf "  ${RED}✗${RESET} %s\n" "$*" >&2; }
header()  { printf "\n${BOLD}%s${RESET}\n" "$*"; }

die() { error "$*"; exit 1; }

# ── Argument parsing ──────────────────────────────────────────────────────────
PINNED_VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v) PINNED_VERSION="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: install.sh [--version <tag>]"
      echo "  --version  Install a specific release tag (e.g. v0.3.0). Defaults to latest."
      exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

# ── Dependency check ──────────────────────────────────────────────────────────
need_cmd() { command -v "$1" &>/dev/null || die "Required command not found: $1"; }
need_cmd curl
need_cmd uname

# ── Detect OS & arch ──────────────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  *)      die "Unsupported operating system: $OS. Use install.ps1 for Windows." ;;
esac

case "$ARCH" in
  x86_64|amd64)     ARCH_NORM="x86_64" ;;
  arm64|aarch64)    ARCH_NORM="arm64"  ;;
  *)                die "Unsupported architecture: $ARCH" ;;
esac

# ── Detect Linux package manager ──────────────────────────────────────────────
PKG_MGR=""
if [ "$PLATFORM" = "linux" ]; then
  if command -v apt-get &>/dev/null; then
    PKG_MGR="apt"
  elif command -v dpkg &>/dev/null; then
    PKG_MGR="dpkg"
  elif command -v dnf &>/dev/null; then
    PKG_MGR="dnf"
  elif command -v yum &>/dev/null; then
    PKG_MGR="yum"
  elif command -v rpm &>/dev/null; then
    PKG_MGR="rpm"
  else
    die "No supported package manager found (apt/dpkg/dnf/yum/rpm)."
  fi
fi

# ── Resolve version ───────────────────────────────────────────────────────────
header "🎯  ${APP_NAME} Installer"
if [ -n "$PINNED_VERSION" ]; then
  VERSION="$PINNED_VERSION"
  info "Using pinned version: ${VERSION}"
else
  info "Fetching latest release from GitHub..."
  VERSION="$(curl -fsSL "${GITHUB_API}/latest" | grep '"tag_name"' | head -1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$VERSION" ] || die "Failed to fetch latest release version."
  info "Latest version: ${VERSION}"
fi

# Strip leading 'v' for use in filenames
VER="${VERSION#v}"

# ── Build download URL ────────────────────────────────────────────────────────
case "$PLATFORM" in
  macos)
    case "$ARCH_NORM" in
      arm64)  FILENAME="${APP_NAME}_${VER}_aarch64.dmg" ;;
      x86_64) FILENAME="${APP_NAME}_${VER}_x64.dmg"     ;;
    esac
    ;;
  linux)
    case "$PKG_MGR" in
      apt|dpkg)
        case "$ARCH_NORM" in
          x86_64) FILENAME="${APP_NAME}_${VER}_amd64.deb"  ;;
          arm64)  FILENAME="${APP_NAME}_${VER}_arm64.deb"  ;;
        esac
        ;;
      dnf|yum|rpm)
        case "$ARCH_NORM" in
          x86_64) FILENAME="${APP_NAME}-${VER}-1.x86_64.rpm"  ;;
          arm64)  FILENAME="${APP_NAME}-${VER}-1.aarch64.rpm" ;;
        esac
        ;;
    esac
    ;;
esac

DOWNLOAD_URL="${GITHUB_DL}/${VERSION}/${FILENAME}"

# ── Download ──────────────────────────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

DEST="${TMPDIR}/${FILENAME}"

header "⬇️   Downloading"
info "URL: ${DOWNLOAD_URL}"
info "File: ${FILENAME}"

if ! curl -fL --progress-bar -o "$DEST" "$DOWNLOAD_URL"; then
  die "Download failed. Check your internet connection or try --version with a valid tag."
fi
success "Downloaded ${FILENAME}"

# ── Install ───────────────────────────────────────────────────────────────────
header "📦  Installing"

case "$PLATFORM" in
  macos)
    MOUNTPOINT="$(mktemp -d)"
    info "Mounting disk image..."
    hdiutil attach -quiet -nobrowse -mountpoint "$MOUNTPOINT" "$DEST"

    APP_SRC="$(find "$MOUNTPOINT" -maxdepth 1 -name "*.app" | head -1)"
    [ -n "$APP_SRC" ] || die "No .app found in DMG."

    APP_DEST="/Applications/${APP_NAME}.app"

    if [ -d "$APP_DEST" ]; then
      warn "Removing existing installation at ${APP_DEST}..."
      rm -rf "$APP_DEST"
    fi

    info "Copying ${APP_NAME}.app to /Applications..."
    cp -R "$APP_SRC" "$APP_DEST"

    hdiutil detach -quiet "$MOUNTPOINT" || true
    rm -rf "$MOUNTPOINT"

    # Remove the quarantine bit so Gatekeeper does not block the first launch.
    # Picot uses ad-hoc signing (not Apple-notarized). Files downloaded via
    # curl still receive the com.apple.quarantine xattr from macOS, which
    # causes the "app can't be opened" / Privacy & Security prompt on first
    # launch. Stripping it here means the app opens directly without any
    # manual "Open Anyway" step in System Settings.
    info "Removing macOS quarantine attribute..."
    xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

    success "Installed ${APP_NAME}.app to /Applications"
    ;;

  linux)
    case "$PKG_MGR" in
      apt)
        info "Installing with apt..."
        sudo apt-get install -y "$DEST"
        ;;
      dpkg)
        info "Installing with dpkg..."
        sudo dpkg -i "$DEST"
        ;;
      dnf)
        info "Installing with dnf..."
        sudo dnf install -y "$DEST"
        ;;
      yum)
        info "Installing with yum..."
        sudo yum localinstall -y "$DEST"
        ;;
      rpm)
        info "Installing with rpm..."
        sudo rpm -U --force "$DEST"
        ;;
    esac
    success "Installed ${APP_NAME}"
    ;;
esac

# ── Done ──────────────────────────────────────────────────────────────────────
printf "\n${GREEN}${BOLD}✓ ${APP_NAME} ${VERSION} installed successfully!${RESET}\n\n"

case "$PLATFORM" in
  macos) info "Launch it from /Applications/${APP_NAME}.app or Spotlight." ;;
  linux) info "Launch it by running: picot  (or search in your app menu)" ;;
esac

printf "\n"
