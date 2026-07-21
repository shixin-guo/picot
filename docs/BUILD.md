# Picot Local Build Guide

## Overview

This guide covers **local-only** builds for internal QA. There are two
independent build paths in this project — keep them separate:

| Path | Purpose | Triggers | Output |
|---|---|---|---|
| **Local** (this doc) | Internal QA, fast iteration, test before release | `./scripts/build.sh <platform>` on your macOS box | DMG / exe+zip, ad-hoc signed |
| **Public release** | Signed installer, auto-updater artifacts, GitHub release | Push a `v*` tag → `scripts/release.sh` → GitHub Actions | Signed installers + `latest.json` |

**Never** use the local path for public distribution. The local DMG is
ad-hoc signed and will be Gatekeeper-rejected on first launch; the local
Windows zip has no MSI and no code signing. Both are for **internal
testing only**.

## Prerequisites

- **macOS host** (Apple Silicon recommended; Intel also works)
- **Bun** — Picot uses Bun exclusively. Never `npm`/`pnpm` here.
  Install: <https://bun.sh>
- **Rust via rustup** — **NOT** Homebrew. Homebrew rust breaks
  cross-compile to Windows with `E0463: can't find crate for 'std'`.
  Install: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- **For Windows builds only**: MinGW (`brew install mingw-w64`)

## Local macOS build

Build a DMG for the current host's architecture (Apple Silicon or Intel),
or a universal binary that runs on both:

```bash
./scripts/build.sh mac-arm         # Apple Silicon (aarch64-apple-darwin)
./scripts/build.sh mac-intel       # Intel Mac (x86_64-apple-darwin), cross-compiled
./scripts/build.sh mac-universal   # Universal: arm64 + x86_64 fat binary (recommended for distribution)
./scripts/build.sh                 # no arg = auto-detect host
```

**Output** (after every macOS build):

- **Repo root** (for easy distribution): `./Picot_<version>_<arch>.dmg`
  - `<arch>` is `aarch64` / `x86_64` / `universal`
  - Each build prints the sha256 of the copied file
- **Tauri target dir**: `src-tauri/target/<triple>/release/bundle/dmg/Picot_<version>_<arch>.dmg`

**Universal**: Tauri runs cargo for both `aarch64-apple-darwin` and
`x86_64-apple-darwin`, then `lipo`s them into a single fat binary inside
`Picot.app/Contents/MacOS/picot`. The resulting DMG works natively on
both Apple Silicon and Intel Macs. Universal builds take roughly 2× as
long as a single-arch build.

**Signing**: ad-hoc (`signingIdentity: "-"`). No Apple Developer
certificate, no notarization.
**First launch on macOS**: Gatekeeper will block the app because it is
not notarized. To open:

1. Right-click (or Control-click) the app inside the mounted DMG
2. Select **Open** from the context menu
3. Click **Open** in the dialog that warns about the unidentified developer
4. Subsequent launches work normally

If testers find this friction too high, distribute the `.app` directly
(extract from the DMG with `hdiutil` or `open` then drag) and have them
follow the same right-click Open procedure.

## Local Windows cross-build

Cross-compile a bare `.exe` + zip from a macOS host using MinGW:

```bash
./scripts/build.sh windows
```

**Output**: `<project-root>/Picot_<version>_windows_x64.zip`

**Contents**: `Picot.exe` + any bundled DLLs + embedded `pi/` tree +
compiled `extensions/`. Unzip and run `Picot.exe` directly.

**Limitations** (deliberate — matches palangent's local-build tradeoff):
- **No MSI installer** — MSI requires building on actual Windows
  (NSIS/MSI bundlers depend on Windows host tools). Testers get a bare
  `.exe` + zip; they unzip and run.
- **No code signing** — MinGW cross-compile does not produce signed
  binaries. Windows SmartScreen may warn on first launch.
- **No auto-updater artifacts** — `latest.json` and `.sig` files are
  produced only by the GH Actions public-release workflow.

## What `scripts/build.sh` does

1. Verifies `bun` / `cargo` / `rustup` (and `x86_64-w64-mingw32-gcc` for Windows)
2. `bun install --frozen-lockfile`
3. `bun run fetch:pi` (downloads/verifies embedded `pi` binary)
4. `bun run build:extensions` (compiles `extensions/embedded-server.ts`)
5. `rustup target add <target>` (idempotent)
6. `tauri build` with the right target / bundler flags
7. Windows: `zip` the release-dir contents

It never touches git, never creates tags, never pushes.

## Troubleshooting

### `error: invalid value '1' for '--ci'`

The Tauri CLI v2 reads the `$CI` environment variable and forwards it as
`--ci`. v2 only accepts `true`/`false`, but many CI environments set
`CI=1` (numeric). `scripts/build.sh` unsets `CI` internally; if you
invoke `tauri` directly, `unset CI` first.

### `error[E0463]: can't find crate for 'std'` (Windows cross)

You have Homebrew's rust shadowing rustup. Verify:

```bash
which rustc   # should be /Users/you/.cargo/bin/rustc
```

If it shows `/opt/homebrew/bin/rustc` (Apple Silicon) or
`/usr/local/bin/rustc` (Intel), unlink Homebrew rust:

```bash
brew unlink rust
```

### MinGW missing

```bash
brew install mingw-w64
```

`scripts/build.sh` fail-fasts with this hint if the compiler is absent.

### `tauri: command not found`

`scripts/build.sh` adds `node_modules/.bin` to `PATH` automatically. If
you invoke `tauri` directly in a fresh shell, either use `bunx tauri …`
or run from `bun run` (which adds `.bin` to PATH automatically).
### DMG is empty / `.app` not found

Tauri's macOS bundler cleans `bundle/macos/` after creating the DMG.
The `.app` lives inside the DMG, not next to it. This is normal.

### Windows zip contains a Mach-O `pi/pi` instead of a Windows `pi.exe`

`src-tauri/build.rs` uses `cfg!(target_os = "windows")` to choose between
looking for `pi.exe` (Windows) and `pi` (host). In a `build.rs`, `cfg!`
always reflects the **host** OS, not the build target — so the panic
guard is unreachable when cross-compiling from macOS to Windows. The
script works around this by:

1. `export PI_TARGET_PLATFORM=windows-x64` before invoking `tauri`, so
   Tauri's `beforeBuildCommand` (`bun run fetch:pi`) re-fetches the
   Windows pi binary instead of the host-arch one.
2. `export PI_STUDIO_SKIP_BIN_CHECK=1` to bypass the buggy panic
   guard. The script explicitly copies the Windows pi binary into the
   target resource dir, so the guard's raison d'être (preventing
   developers from forgetting `bun run fetch:pi`) does not apply.

**If you upgrade or clean `src-tauri/resources/pi/`, re-run
`./scripts/build.sh windows` to re-fetch the Windows binary. The
`.version` marker used for idempotency does not encode the platform.**
The proper long-term fix is to read `CARGO_CFG_TARGET_OS` in `build.rs`
instead of `cfg!()`.

## Public release

For signed installers, auto-updater artifacts, and the GitHub release:

- `scripts/release.sh` — bumps version, creates `v*` tag, pushes
- `.github/workflows/release.yml` — builds per-platform installers on
  `macos-latest`, `macos-14`, `windows-2022`, `windows-11-arm` runners
- `docs/AUTO_UPDATER.md` — updater key setup and flow
