# Picot agent guide

This file contains repository-wide development rules. Product architecture,
feature invariants, transport paths, security boundaries, and module ownership
live in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Read first

- Read the applicable `ARCHITECTURE.md` section and its linked design documents
  before changing UI behavior, persistence, workspace I/O, or cross-process
  communication.
- For Quick Chat or Side Chat work, read
  [`docs/superpowers/specs/2026-07-15-quick-and-side-chat-design.md`](docs/superpowers/specs/2026-07-15-quick-and-side-chat-design.md)
  and the temporary-chat architecture section.
- Before changing a browser/server adapter, popup/overlay, or shared-state
  rerender behavior, read and apply [`docs/engineering-lessons.md`](docs/engineering-lessons.md).
- **Before porting any feature-v3 feature**, read and follow
  [`docs/feature-v3-migration-playbook.md`](docs/feature-v3-migration-playbook.md).
  It documents the two-architecture identifier mapping, the verbatim-port
  protocol, and the seven most common pitfalls (missing CSS, missing backend
  routes, custom re-implementations that broke visual style, etc.).
- Update `ARCHITECTURE.md` when an implementation materially changes its
  architecture, invariants, lifecycle, security boundary, or validation
  contract. Changes to LAN access, cross-platform paths, or static serving also
  require the corresponding architecture update.

Tauri wraps the web UI. Rust starts a native `HostServer` plus a managed `pi --mode rpc` subprocess using the embedded pi binary shipped in `src-tauri/resources/pi/` (downloaded by `scripts/fetch-pi-binary.js` from pi-mono releases at the version pinned in `scripts/pi-version.json`). The WebView talks to the Rust host over `/v2/ws`; the host bridges runtime requests to Pi over stdio RPC.

```
Picot .app
  resources/
    public/                       (frontend)
    extensions/picot-bridge.mjs    (Picot-specific Pi commands)
    pi/<bun-compiled pi binary + assets>
  Rust HostServer + NativePiManager
    spawn pi --mode rpc --extension picot-bridge.mjs
    WebView  →  /v2/ws  →  HostServer  →  stdio RPC  →  pi
```

There are currently no custom Tauri IPC commands. Runtime, data, auth, and extension UI traffic goes through the native host protocol.

### Goals

- Local desktop GUI: all projects and agents visible in one app
- Multi-project: each project has its own window, isolated working directory, session history, and running agent
- Multi-agent: spawn new agents per project; switch between sessions without leaving the app
- Native runtime protocol: browser frames are routed by Rust over `/v2/ws`, then forwarded to the managed Pi process over stdio RPC.
- Visualization: streaming chat, tool-call cards, thinking blocks, token/cost tracking per session
- Fully self-contained desktop app: zero dependency on the user's PATH / shell environment / globally installed pi

### Constraints

- Frontend: vanilla JS, no framework (`public/`)
- Backend: Rust (Tauri) owns process lifecycle, the HTTP/WebSocket host, routing, and host data APIs
- PI integration: always via embedded `pi --mode rpc` subprocess — never re-implement PI runtime logic
- Session history and working directory are isolated per project/port
- The embedded pi version is the source of truth: `pi --version` shown in the UI comes from `PI_STUDIO_PI_VERSION` (set by Rust at spawn time, populated from `scripts/pi-version.json`). A user-installed pi on `$PATH` is irrelevant and never touched.
- User extensions under `~/.pi/agent/extensions/` and `<workspace>/.pi/extensions/` are still auto-loaded by the embedded pi (embedding doesn't disable user extensions).

### PI references

Docs ship inside the embedded pi runtime at `src-tauri/resources/pi/docs/` (populated by `bun run fetch:pi`; see "Bumping the embedded pi version" below). Prefer these repo-relative paths over any globally-installed `pi-coding-agent` — a global install may not exist on a given machine or may be a different version than the one pinned in `scripts/pi-version.json`.

- RPC protocol: `src-tauri/resources/pi/docs/rpc.md`
- SDK: `src-tauri/resources/pi/docs/sdk.md`
- Session format: `src-tauri/resources/pi/docs/session-format.md`
- JSON mode: `src-tauri/resources/pi/docs/json.md`

---

# Agent working notes

Conventions for any coding agent working in this directory.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

This repo uses the single-context domain docs layout: root `CONTEXT.md` plus ADRs under `docs/adr/`. See `docs/agents/domain.md`.

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
bun run build:extensions # compile picot-bridge and pi-chat extensions into extensions/dist/
bun run build            # full release build (runs prebuild: fetch:pi + build:extensions)
```

Single test file: `bun run vitest run public/settings-save-status.test.js`

## Searching the codebase

`src-tauri/target/` is a gitignored Rust build-artifact directory (like `node_modules`/`dist`) containing thousands of `.rcgu.o`/`.rlib` object files. `grep -r`/`rg` do not respect `.gitignore` by default, so a broad recursive search rooted at `src-tauri/` (instead of `src-tauri/src/`) will scan those binaries too — grep's binary-file heuristics can match embedded strings from dependencies and flood the output with thousands of meaningless object-file paths, burying the real hits and making the command look hung.

When grepping for source code, target the actual source directories directly — `public/`, `extensions/`, `src-tauri/src/` — never bare `src-tauri/`. Prefer `rg` (respects `.gitignore` by default) over `grep -r` when available.

When running `find` (or any other filesystem/code search command), scope it to this repo by default — root the search at the repo root or a specific subdirectory inside it (e.g. `find public -name '*.js'`, `find . -path ./src-tauri/target -prune -o -name '*.rs' -print`), never at `/`, `~`, or an unrelated ancestor directory. Only search outside the repo if the user explicitly asks for a global/system-wide search.

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

## Design system

Before editing CSS or UI controls, read [`docs/DESIGN.md`](docs/DESIGN.md). Use tokens from `public/style-theme.css` and primitives from `public/design-system.css`; do not add literal design dimensions. After CSS, UI markup, or inline-style changes, run `bun run check` (or focused `bun run check:design`).

## Module Design

The frontend (`public/`) is vanilla JS with **no framework**. Keep it modular. See [`docs/MODULE_SPLIT_PLAN.md`](docs/MODULE_SPLIT_PLAN.md) for the current large-file inventory and extraction roadmap.

### Rules

- **One concern per file.** Each module owns a single responsibility (e.g. WebSocket client, session sidebar, file browser, theme switching). Do not add unrelated logic to an existing file just because it is convenient.
- **Avoid growing orchestration files.** `public/native/app.js` and `src-tauri/src/main.rs` are composition roots / entrypoints. New feature logic belongs in dedicated modules that are imported and wired there, not implemented inline.
- **New file threshold.** If a feature adds more than ~50 lines of logic, extract it into its own module in the appropriate `public/native/<subdir>/` (e.g. `public/native/features/my-feature.js`) and import it from the appropriate entry point.
- **Large-file guardrail.** Before adding code to any file over 500 lines, first prefer extracting a focused module. If adding to the large file is still the smallest safe change, keep the addition minimal and mention the exception in the final response.
- **CSS by feature.** Do not keep adding feature styles to `public/style.css`. Put component/feature styles in a nearby stylesheet and import it from `style.css`; keep `style.css` for imports, reset, and global shell rules.
- **HTML by owner.** Avoid growing `public/index.html` with large feature markup. Prefer feature-owned DOM construction/templates in the module that owns the behavior, while preserving accessibility and focus management.
- **Rust facades.** For Rust, keep large public modules as thin facades when possible (`host_server.rs`, `host_data.rs`, `main.rs`) and move implementation into submodules grouped by protocol, data, routing, lifecycle, or commands.
- **No shared-state side-effects at import time.** Modules should export functions/classes; side-effects that mutate global state should be triggered explicitly by the caller, not at module load.
- **Naming.** Use kebab-case filenames for JS/CSS that match the single responsibility (`session-sidebar-storage.js`, `file-browser.css`, `workspace-actions.js`). Use Rust module names that describe the domain slice (`sessions`, `workspaces`, `protocol`, `dispatch`).

### Review checklist

- Did this add more than ~50 lines to an existing file? If yes, should it be a new module?
- Did this touch a file already over 500 lines? If yes, can a focused extraction happen first?
- Is the new module cohesive, with explicit dependencies passed via `setup*`, `create*`, or constructor parameters?
- Are tests split or added next to the behavior that moved?
- Were the required checks run (`bun run check` for JS/CSS/TS, `bun run check:rust` for Rust)?

## Architecture

Picot is a Tauri v2 app. The three main layers:

**1. Rust / Tauri (`src-tauri/`)** — process lifecycle, host protocol, and window management.

- `src-tauri/src/native_pi_manager.rs` — spawns and supervises native `pi --mode rpc` processes.
- `src-tauri/src/host_server.rs` — owns the HTTP/WebSocket host (`/v2/ws`, `/v2/bootstrap`) and dispatches protocol frames.
- `src-tauri/src/pi_launch.rs` — resolves the bundled pi binary and bundled Picot bridge extension.

**2. Frontend (`public/`)** — vanilla JS, no framework.

- `bootstrap-entry.js` + `native/app.js` — native host protocol entry point, wires up all native modules

`public/native/` is organized into domain subdirectories. Each directory owns its JS, CSS, and test files:

| Subdir | Responsibility |
| --- | --- |
| `transport/` | RPC adapters & gateways: `runtime-adapter`, `runtime-gateway`, `data-gateway`, `config-gateway`, `config-gateway-readiness`, `control-gateway` |
| `session/` | Session state, sidebar, navigation, search: `session-store`, `session-tree`, `session-sidebar`, `session-navigation`, `session-search-dialog` |
| `composer/` | Message input controls: `composer-images`, `composer-slash-menu`, `composer-submit`, `slash-commands`, `queued-messages` |
| `settings/` | Settings panel and all sub-panels: `settings-panel`, `settings-config`, `settings-toggles`, `settings-save-status`, `package-browse`, `cost-dashboard`, `thinking-effort-control` |
| `workspace/` | Header, project info, file browser: `project-header`, `header-open-app`, `workspace-actions`, `context-usage`, `file-browser` |
| `extensions/` | Extension UI, dialogs, command palette: `dialog`, `extension-ui-host`, `inline-extension-prompt`, `command-palette` |
| `features/` | Independent self-contained features: `app-updater`, `lan-qr`, `remote-auth`, `rpiv-todo-mirror` |
| `utils/` | Pure utilities (no DOM, no side-effects): `random-id`, `router`, `keyboard-shortcuts` |

CSS-only files without a JS pair (`sidebar.css`, `header.css`, `messages.css`, `composer.css`, `instance-swap.css`) stay at the `native/` root and are imported from `public/style.css`.

Cross-subdir import conventions:

- Files within the same subdir use `./foo.js`.
- Files importing from another subdir use `../other-dir/foo.js`.
- Files in a subdir importing from sibling `public/` folders use `../../ui/foo.js`, `../../themes.js`, etc. (one extra `../` vs the root-level `native/` equivalent).
- `ui/message-renderer.js`, `ui/markdown.js`, `ui/tool-card.js` — chat message rendering (dependency-free markdown, collapsible tool cards)
- `ui/context-viz.js`, `ui/conv-nav.js`, `ui/image-lightbox.js`, `ui/layout-insets.js`, `ui/resizable-panel.js` — chat layout/nav helpers (context bar, turn navigator, image zoom, scroll insets, resizable panels)
- `themes.js` — theme switching (6 built-in themes)

**Where to put a new `native/` module:** place it in the subdir whose responsibility best matches it. If a module is purely algorithmic/pure-function with no DOM, prefer `utils/`. If it spans two subdirs equally, prefer the subdir of its primary consumer.

**3. Pi bridge extensions (`extensions/`)** — TypeScript compiled into `extensions/dist/`.

- `picot-bridge.ts` runs inside Pi and exposes Picot-specific commands.
- `pi-chat` remains an optional bundled extension for chat integrations.

## Key data flows

- User action → `native/transport/runtime-gateway.js` → `/v2/ws` → `HostServer` → `NativePiManager` → Pi stdio RPC.
- Extension UI requests → Pi stdio RPC event → `HostServer` → `native/extensions/extension-ui-host.js` dialog host → response over `/v2/ws`.

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
bun install --frozen-lockfile
bun run dev
bun run test
bun run check
bun run check:rust
bun run build:extensions
```

Useful focused test form:

```bash
bun run vitest run public/settings-save-status.test.js
```

## Frontend and extension checks

Biome is the JS/TS formatter and linter.

```bash
bun run check       # lint, format, and design check
bun run check:fix   # safe automatic fixes
bun run lint
bun run format
bun run format:fix
```

After editing `.js` or `.ts` under `public/` or `extensions/`, run `bun run check`.

Picot uses the Tauri v2 updater plugin to fetch new releases from GitHub. The build side is wired into `.github/workflows/release.yml` via the `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets. See `docs/AUTO_UPDATER.md` for the one-time signing-key setup and how `latest.json` flows from CI → GitHub release → installed app.

## Module discipline

The WebView is vanilla JavaScript with no framework.

- Keep one concern per file; do not add unrelated logic for convenience.
- Keep `app.js` as an orchestrator. Put new feature logic in a dedicated module
  and import it explicitly.
- Extract a feature adding roughly 50 lines or more into its own module.
- Do not mutate shared state as an import side effect.
- Use kebab-case filenames that describe one responsibility.
- For loopback access, filesystem paths, static assets, or locale coverage,
  run the full `bun run test` suite before completion.

## Verification

- After Rust edits, run `bun run check:rust`; do not use `tauri build` or
  `cargo build` merely to verify a fix.
- After frontend or extension edits, run `bun run check`; run the focused test
  first, then the relevant broader suite.
- `bun run test` includes Vitest and Tauri capability validation.
- Do not claim completion with failing tests or undocumented intentional
  warnings.

## Embedded Pi version

The embedded binary is the only Pi runtime Picot launches; do not rely on a
user-installed `pi` from `$PATH`. To upgrade it, follow the verified procedure
in [`ARCHITECTURE.md`](ARCHITECTURE.md#如何读这个仓库): change
`scripts/pi-version.json`, run `bun run fetch:pi`, smoke-test the embedded
binary and `bun run dev`, then commit only the version pin—not
`src-tauri/resources/pi/`.
