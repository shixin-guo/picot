# Module split and modularization plan

This plan reduces the largest Picot source files and prevents new work from making them larger. The goal is not line-count golf; the goal is deeper modules with narrow responsibilities, stable interfaces, and smaller files that are easier for humans and agents to navigate.

## Current large-file inventory

Generated with source-only paths, excluding generated/dependency/worktree artifacts:

| Lines | File | Primary concern |
| ---: | --- | --- |
| 2644 | `public/style.css` | Global reset, layout, many feature styles |
| 1636 | `src-tauri/src/host_data.rs` | Host data API, filesystem/session/workspace queries |
| 1435 | `src-tauri/src/host_server.rs` | HTTP/WebSocket server, routing, protocol dispatch |
| 1430 | `public/index.html` | App shell plus all modal/settings/composer markup |
| 1195 | `extensions/pi-chat-src/extension-entry.ts` | Pi chat extension command/event implementation |
| 1089 | `public/native/app.js` | Native app bootstrap and orchestration |
| 976 | `public/native/session-sidebar.js` | Session grouping, persistence, rendering, interactions |
| 836 | `src-tauri/src/main.rs` | Tauri setup, commands, lifecycle wiring |
| 735 | `public/native/cost-dashboard-render.js` | Cost dashboard rendering |
| 700 | `src-tauri/src/native_pi_manager.rs` | Pi subprocess lifecycle and RPC supervision |
| 672 | `public/native/settings-config.js` | Settings config UI/data binding |
| 653 | `public/components/super-agent-runtime.js` | Super-agent runtime component |
| 599 | `public/native/session-sidebar.css` | Session sidebar styles |
| 564 | `public/native/cost-dashboard.css` | Cost dashboard styles |
| 559 | `public/components/super-agent-runtime.test.js` | Super-agent runtime tests |
| 546 | `src-tauri/src/pi_launch.rs` | Bundled Pi path/launch resolution |
| 545 | `public/ui/message-renderer.js` | Chat message rendering |
| 509 | `public/native/session-sidebar.test.js` | Sidebar tests |

## Success criteria

1. New feature code normally lands in a focused module, not in existing large files.
2. `public/native/app.js` remains an orchestrator only: imports modules, wires dependencies, and owns app-level lifecycle.
3. CSS is organized by feature/component and imported by `public/style.css`; `style.css` contains only reset, global layout, and imports.
4. Rust files expose small modules around data access, protocol routing, process lifecycle, and Tauri commands.
5. Any file above 500 lines has an explicit reason to stay large or an active extraction plan.
6. Refactors are behavior-preserving and covered by existing/new tests.

## Guardrails for future work

- Do not add unrelated logic to a file just because it already has nearby DOM elements or state.
- If a change adds more than about 50 lines to an existing file, first consider a new module.
- If the target file is already over 500 lines, prefer extraction before extension.
- Keep side effects out of module top-level code. Export `setup*`, `create*`, or class APIs and call them from the orchestrator.
- Prefer small dependency objects over importing global mutable state.
- Move tests with the behavior they verify; split test files when the implementation splits.

## Proposed frontend module boundaries

### `public/native/app.js`

Current role: bootstrap, dependency creation, DOM lookup, routing, runtime event handling, composer/model state, settings/sidebar/file-browser wiring.

Target role: app composition root only.

Extract in this order:

1. **DOM references**
   - New module: `public/native/app-dom.js`
   - Exports: `getAppDom()`
   - Owns all `document.getElementById` / `querySelector` calls and required-element validation.

2. **Model and thinking selection**
   - Existing related module: `public/native/thinking-effort-control.js`
   - New module if needed: `public/native/model-selector.js`
   - Owns model dropdown state, context window selection, thinking level state.

3. **Runtime event handling**
   - New module: `public/native/runtime-event-controller.js`
   - Exports: `createRuntimeEventController(deps)`
   - Owns frame/event dispatch, message rendering calls, token/cost updates, queue rendering hooks.

4. **Session bootstrap/navigation coordination**
   - New module: `public/native/session-bootstrap-controller.js`
   - Owns provisional target reconciliation, store creation/reduction wiring, route replacement, navigation generation.

5. **Composer orchestration**
   - Existing modules: `composer-submit.js`, `composer-images.js`, `composer-slash-menu.js`
   - New module: `public/native/composer-controller.js`
   - Owns composer setup across submit, slash commands, images, queued messages, abort/send button state.

Expected result: `app.js` drops below ~350 lines and reads as a dependency graph.

### `public/native/session-sidebar.js`

Current role: localStorage persistence, cache, grouping/sorting, rendering, event handling, load retries, cross-project open behavior.

Extract in this order:

1. **Persistence and cache**
   - New module: `public/native/session-sidebar-storage.js`
   - Exports localStorage helpers, cache read/write, favorites/archive/unread state helpers.

2. **Grouping and sorting**
   - New module: `public/native/session-sidebar-model.js`
   - Exports pure functions: normalize sessions, group projects, sort sections, derive visible sessions.

3. **Rendering**
   - New module: `public/native/session-sidebar-render.js`
   - Exports render functions that accept view models and callbacks.

4. **Interactions**
   - New module: `public/native/session-sidebar-actions.js`
   - Owns rename, archive/favorite toggles, load-more, retry, project collapse, cross-project open.

Expected result: `session-sidebar.js` becomes a ~250-line controller class that composes storage/model/render/actions.

### `public/style.css` and feature CSS

Current role: imports plus remaining global and feature styles.

Target role: CSS entrypoint, reset, global shell layout only.

Extract in this order:

1. **App shell/layout**
   - New module: `public/app-shell.css` or `public/native/app-shell.css`
   - Contains `.app-layout`, `.main`, base panels, header/input area layout.

2. **Composer styles**
   - New module: `public/native/composer.css`
   - Contains chat form, input, buttons, model dropdown if not already separated.

3. **Shared primitives already in design system**
   - Move reusable button/card/panel rules into `public/design-system.css` if they are generic.
   - Keep feature-specific rules in feature CSS.

4. **Remaining feature blocks**
   - Move each clearly labeled section into the matching feature stylesheet.

Expected result: `style.css` is mostly imports plus reset/base rules and stays below ~400 lines.

### `public/index.html`

Current role: complete app shell markup, all overlays/modals/settings panels.

Target role: minimal static app shell with feature templates kept close to their feature.

Options, in preferred order:

1. **HTML `<template>` sections**
   - Keep templates in `index.html` only when they are tiny and shared.
   - Move large feature templates to JS render modules when behavior already owns rendering.

2. **Feature-owned DOM construction**
   - Settings, command palette, LAN QR, dialogs, package browser, and cost dashboard should own or validate their own markup in their setup modules.

3. **No framework requirement**
   - Use vanilla DOM helpers or template strings inside feature modules; do not introduce a frontend framework just to split HTML.

Expected result: `index.html` contains only persistent landmarks: sidebar root, header root, messages root, composer root, and overlay roots.

### Other frontend candidates

- `public/native/cost-dashboard-render.js`: split data shaping, chart/table rendering, and empty/error states.
- `public/native/settings-config.js`: split schema/model parsing, form rendering, save-status binding, and package-specific config editors.
- `public/components/super-agent-runtime.js`: split runtime state machine, UI rendering, and event adapters.
- `public/ui/message-renderer.js`: split message view model creation, markdown rendering integration, attachments/tool/thinking sub-renderers.

## Proposed Rust module boundaries

### `src-tauri/src/host_server.rs`

Current role: HTTP server bootstrap, WebSocket upgrade, host protocol frame parsing, request dispatch, runtime bridge.

Extract in this order:

1. `src-tauri/src/host_server/http.rs` — HTTP routes and static/bootstrap responses.
2. `src-tauri/src/host_server/ws.rs` — WebSocket accept loop, connection lifecycle, frame send/receive.
3. `src-tauri/src/host_server/protocol.rs` — request/response/event structs and serde helpers.
4. `src-tauri/src/host_server/dispatch.rs` — host RPC dispatch to data/control/runtime managers.

Keep `host_server.rs` as the public facade that constructs and starts the server.

### `src-tauri/src/host_data.rs`

Current role: workspace/session/file data queries, search, serialization, path handling.

Extract in this order:

1. `src-tauri/src/host_data/sessions.rs` — session list/read/search metadata.
2. `src-tauri/src/host_data/workspaces.rs` — workspace identity and project summaries.
3. `src-tauri/src/host_data/files.rs` — file tree/read operations and path safety.
4. `src-tauri/src/host_data/models.rs` — response structs and serialization models.

Keep `host_data.rs` as a facade exposing the existing public API where possible.

### `src-tauri/src/main.rs`

Current role: Tauri app setup, plugin/window/menu/lifecycle commands.

Extract in this order:

1. `src-tauri/src/tauri_commands.rs` — command handlers registered with Tauri.
2. `src-tauri/src/window_lifecycle.rs` — project/session window creation and focus behavior.
3. `src-tauri/src/app_setup.rs` — builder/plugin setup and managed state registration.

Keep `main.rs` as a short app entrypoint.

### `src-tauri/src/native_pi_manager.rs` and `src-tauri/src/pi_launch.rs`

- Split process spawning, environment construction, RPC IO loop, and shutdown policy into separate helpers only when changing that area.
- Keep public APIs stable to avoid wide Rust churn.

## Incremental execution plan

Each step should be a small PR/commit with tests/checks passing.

1. **Document and enforce direction**
   - Add this plan.
   - Update `AGENTS.md` with modularity rules and line-budget guardrails.

2. **Frontend composition root cleanup**
   - Extract `app-dom.js`.
   - Extract model/thinking selector or composer controller if touched by active work.
   - Run `bun run check` and relevant Vitest files.

3. **Session sidebar split**
   - Extract storage helpers first because they are low-risk and easy to test.
   - Extract pure grouping/sorting functions with unit tests.
   - Extract renderer last.
   - Run `bun run vitest run public/native/session-sidebar.test.js` and `bun run check`.

4. **CSS split**
   - Read `docs/DESIGN.md` before editing.
   - Move one labeled section at a time into feature CSS.
   - Run `bun run check` or focused design checks after each CSS batch.

5. **Rust host data/server split**
   - Create Rust submodules while preserving existing public functions.
   - Move models/pure helpers first, then IO/dispatch.
   - Run `bun run check:rust` after every Rust batch.

6. **HTML shell reduction**
   - Move feature-owned modal/overlay markup into the modules that own behavior.
   - Keep accessibility attributes and focus management intact.
   - Run UI smoke tests/manual smoke test for settings, sidebar, composer, dialogs.

7. **Long-tail files**
   - Split cost dashboard, settings config, super-agent runtime, message renderer when doing related feature work.
   - Avoid standalone churn unless the module has active bugs or planned feature work.

## Suggested review checklist

Before merging any future change, check:

- Did this add more than ~50 lines to an existing file? If yes, why not a new module?
- Did this add code to a file already above 500 lines? If yes, is there an extraction or documented exception?
- Is the module name aligned with a single responsibility?
- Are dependencies explicit through constructor/setup parameters?
- Are top-level side effects avoided?
- Are tests located near the behavior and split when the behavior was split?
- Were required checks run (`bun run check`, `bun run check:rust`, relevant Vitest tests)?
