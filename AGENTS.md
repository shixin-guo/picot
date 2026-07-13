# Picot

## Product

**Picot** is a local desktop GUI for the Pi coding agent. It is a Tauri app that bundles its own `pi` runtime — there is no separate install of `pi` to manage.

### Architecture

Tauri wraps the web UI. A Rust `PiManager` (`src-tauri/src/pi_manager.rs`) spawns one `pi --mode rpc` subprocess per workspace, each on its own port, using the embedded pi binary shipped in `src-tauri/resources/pi/` (downloaded by `scripts/fetch-pi-binary.js` from pi-mono releases at the version pinned in `scripts/pi-version.json`). Each workspace gets its own OS window. Workspaces are opened via the native folder picker ("Open Folder"); clicking it opens or focuses a workspace window. Multi-project, multi-agent, no terminal required.

```
Picot .app
  resources/
    public/                       (frontend)
    extensions/embedded-server.mjs (HTTP + WS server, runs inside pi)
    pi/<bun-compiled pi binary + assets>
  Rust PiManager
    spawn pi --mode rpc --extension embedded-server.mjs  (project A, :3001)
    spawn pi --mode rpc --extension embedded-server.mjs  (project B, :3002)
    OS Window per project  →  WebView  →  localhost:300X
  Tauri IPC commands wired through public/tauri-bridge.js
```

Tauri IPC commands (invoked via `window.tauriNative` in `public/tauri-bridge.js`):
- `cmd_open_workspace(cwd)` — spawn pi for a workspace, open a window
- `cmd_new_session(port)` — create a new session in a running pi
- `cmd_switch_session(port, sessionPath)` — resume a historical session
- `cmd_stop_instance(port)` — kill a pi process
- `cmd_pick_folder()` — native folder picker

### Goals

- Local desktop GUI: all projects and agents visible in one app
- Multi-project: each project has its own window, isolated working directory, session history, and running agent
- Multi-agent: spawn new agents per project; switch between sessions without leaving the app
- Multi-task: a `pi --mode rpc` process can only drive **one active session at a time** (switching/forking inside one process *replaces* the active session — the old `.jsonl` is preserved on disk, but it stops being the live, running session). So every concurrently-running session structurally needs its own `pi` process. Picot handles this without spawning OS windows: both "+ New Session" (header) and "start new chat" (sidebar project tile) spawn a fresh **headless** pi for the target cwd and navigate the current window's WebView to it. The previously-attached pi process keeps running in the background (PiManager retains it; reachable from the running-instances list / launcher / sidebar). Net effect: no new OS window, no interruption of the previously-running session, and you can still run multiple agents in parallel against the same project.
- Visualization: streaming chat, tool-call cards, thinking blocks, token/cost tracking per session
- Fully self-contained desktop app: zero dependency on the user's PATH / shell environment / globally installed pi

### Constraints

- Frontend: vanilla JS, no framework (`public/`)
- Backend: Rust (Tauri) wraps + manages process lifecycle; Node.js extension (`embedded-server.ts`) implements the HTTP + WS surface the WebView talks to
- PI integration: always via embedded `pi --mode rpc` subprocess — never re-implement PI runtime logic
- Session history and working directory are isolated per project/port
- The embedded pi version is the source of truth: `pi --version` shown in the UI comes from `PI_STUDIO_PI_VERSION` (set by Rust at spawn time, populated from `scripts/pi-version.json`). A user-installed pi on `$PATH` is irrelevant and never touched.
- User extensions under `~/.pi/agent/extensions/` and `<workspace>/.pi/extensions/` are still auto-loaded by the embedded pi (embedding doesn't disable user extensions).

### PI references

- RPC protocol: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/rpc.md`
- SDK: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md`
- Session format: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- JSON mode: `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/json.md`

---

# Agent working notes

Conventions for any coding agent working in this directory.

## Package manager

Use **Bun** exclusively. Never run `npm install` or `npm ci` — this would create a stray `package-lock.json` that drifts from `bun.lock` and confuses CI (`bun install --frozen-lockfile`).

```bash
bun install --frozen-lockfile   # install deps
bun run <script>                # run package.json scripts
```

## Common commands

```bash
bun run dev              # fetch embedded pi binary, then start tauri dev (hot reload)
bun run test             # vitest run + check-tauri-permissions
bun run test:watch       # vitest in watch mode
bun run check:rust       # cargo check + clippy + fmt (use after every Rust edit)
bun run fetch:pi         # download the locked pi binary into src-tauri/resources/pi/
bun run build:extensions # compile extensions/embedded-server.ts → dist/embedded-server.mjs
bun run build            # full release build (runs prebuild: fetch:pi + build:extensions)
```

Single test file: `bun run vitest run public/settings-save-status.test.js`

## Linting & Formatting

This project uses [Biome](https://biomejs.dev/) for JS/TS linting and formatting.

After every frontend or extension edit, run the check before declaring the work done:

```bash
bun run check         # lint + format check (read-only, shows violations)
bun run check:fix     # auto-fix all safe issues
bun run lint          # lint only
bun run format        # format check only
bun run format:fix    # auto-fix formatting
```

### Rules

- **Always** run `bun run check` after editing any `.js` / `.ts` file under `public/` or `extensions/`.
- Only mark the task complete if `bun run check` exits 0 (or all remaining violations are intentional and documented).
- Prefer `bun run check:fix` over manual reformatting — Biome is the source of truth for style.

## Module Design

The frontend (`public/`) is vanilla JS with **no framework**. Keep it modular:

- **One concern per file.** Each module owns a single responsibility (e.g. WebSocket client, session sidebar, file browser, theme switching). Do not add unrelated logic to an existing file just because it is convenient.
- **Avoid growing `app.js`.** `app.js` is the entry point / orchestrator. New feature logic belongs in a dedicated module that `app.js` imports, not inline in `app.js` itself.
- **New file threshold.** If a feature adds more than ~50 lines of logic, extract it into its own module (e.g. `public/my-feature.js`) and import it from the appropriate entry point.
- **No shared-state side-effects at import time.** Modules should export functions/classes; side-effects that mutate global state should be triggered explicitly by the caller, not at module load.
- **Naming.** Use kebab-case filenames that match the single responsibility (`session-sidebar.js`, `file-browser.js`, `workspace-actions.js`).

## Architecture authority

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the authoritative source for product
architecture, feature invariants, lifecycle rules, security boundaries, and
feature-specific validation. Before changing any UI behavior, persistence,
workspace I/O, or cross-process communication, read the applicable architecture
section and the design documents it links. Do not duplicate those detailed
contracts in this guide.

## Architecture map

[`ARCHITECTURE.md`](ARCHITECTURE.md) is the canonical map of the Rust host,
embedded server, vanilla-JS frontend, transport paths, startup sequence,
persistence model, and feature ownership. Read it before selecting a module or
adding a new communication path.

This guide intentionally keeps only repository-wide operating rules. Put
feature-specific invariants, module indexes, and design links in
`ARCHITECTURE.md`, then update that document whenever the implementation
materially changes.

## Bumping the embedded pi version

1. Edit `scripts/pi-version.json` → `version`.
2. `bun run fetch:pi` (re-downloads the platform tarball, replaces `src-tauri/resources/pi/`).
3. Smoke test: `./src-tauri/resources/pi/pi --version` and `bun run dev`.
4. Commit `scripts/pi-version.json`. Do **not** commit `src-tauri/resources/pi/`; it is gitignored.

## Embedded pi: how it ends up inside the .app

End users never run `fetch:pi`. The flow that puts `pi` inside the shipped bundle is:

1. **Pre-build hook.** `package.json` `prebuild` runs `bun run fetch:pi` before `tauri build`. Downloads the platform tarball into `src-tauri/resources/pi/` (idempotent; skipped if `.version` matches). Bun honors npm-style `pre*` / `post*` lifecycle hooks for `bun run`.
2. **Tauri before-hooks.** `tauri.conf.json` `build.beforeBuildCommand` and `build.beforeDevCommand` BOTH run `bun run fetch:pi` first, so even invoking `tauri build` / `tauri dev` directly (no `bun run build`) still guarantees the binary is present.
3. **Tauri bundling.** `tauri.conf.json` `bundle.resources` maps `./resources/pi` → `pi`, so the entire pi runtime tree is copied into `<App>.app/Contents/Resources/pi/` at package time.
4. **Last-line guard (build.rs).** `src-tauri/build.rs` PANICS at compile time if `resources/pi/<bin>` is missing in a release profile. This prevents `cargo build --release` (or any IDE that bypasses bun) from silently producing a .app with no pi inside. Override only for local experiments via `PI_STUDIO_SKIP_BIN_CHECK=1`.

Net effect: there is no path that ships a Picot release without the embedded pi binary. End users get a self-contained app — no PATH lookups, no `bun run fetch:pi`, no manual install of pi.

## Post-fix verification (Rust / Tauri)

After every edit under `src-tauri/` (or any Rust fix), run the lint+check script before declaring the work done. It catches compile-time errors (e.g. `E0282`, `E0061`, Tauri v1→v2 API drift, deprecated APIs) without producing a binary, so it is much faster than `tauri build`.

```bash
bun run check:rust
# or directly
bash scripts/check-rust.sh
```

`scripts/check-rust.sh` runs, in order:

1. `cargo check --all-targets` — type/borrow/API signature check (~1–5s).
2. `cargo clippy --all-targets -- -D warnings` — lints, warnings as errors.
3. `cargo fmt --check` — advisory only; prints a hint if formatting drifts, but does not fail the script.

### Rules

- **Never** run `tauri build` / `cargo build` just to verify a fix — use `bun run check:rust` instead. Per project policy, full builds are not used for verification.
- After editing any `*.rs` file under `src-tauri/`, run `bun run check:rust` and only mark the task complete if it exits 0.
- When upgrading Tauri or its plugins, run the script first to surface any deprecation warnings before touching feature code.

## Auto-updater

Picot uses the Tauri v2 updater plugin to fetch new releases from GitHub. The runtime side lives in `public/tauri-bridge.js` + `public/app.js` (Settings → General → Updates), and the build side is wired into `.github/workflows/release.yml` via the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. See `docs/AUTO_UPDATER.md` for the one-time signing-key setup and how `latest.json` flows from CI → GitHub release → installed app.

## Tests

Vitest tests live in `public/` as `*.test.js` files (jsdom environment). The full `bun run test` also runs `scripts/check-tauri-permissions.js` to validate Tauri capability permissions.
