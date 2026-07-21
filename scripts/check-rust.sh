#!/usr/bin/env bash
# Run Rust type-check + clippy lint on the Tauri crate.
# Use after every fix to catch compile-time errors (E0282, E0061, deprecated v1 APIs, etc.)
# before invoking `tauri build`.

set -euo pipefail

export PATH="$HOME/.cargo/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/../src-tauri/Cargo.toml"

if ! command -v cargo >/dev/null 2>&1; then
  echo "error: cargo not found in PATH (looked under \$HOME/.cargo/bin)" >&2
  exit 127
fi

echo "==> cargo check (all targets)"
cargo check --manifest-path "$MANIFEST" --all-targets

echo "==> cargo clippy (warnings as errors)"
cargo clippy --manifest-path "$MANIFEST" --all-targets -- -D warnings

echo "==> cargo test (unit)"
if ! cargo test --manifest-path "$MANIFEST" --quiet; then
    echo "    unit tests failed" >&2
    exit 1
fi

if cargo fmt --version >/dev/null 2>&1; then
    echo "==> cargo fmt --check (advisory)"
    if ! cargo fmt --manifest-path "$MANIFEST" --check >/dev/null 2>&1; then
        echo "    formatting drift detected; run 'cargo fmt --manifest-path $MANIFEST' to fix"
    fi
fi

echo "==> all rust checks passed"
