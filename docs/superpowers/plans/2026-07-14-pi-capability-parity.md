# Picot Native Runtime Implementation Plan

Status: **Approved design; implementation not started**

Companion design:
[`2026-07-14-pi-capability-parity-design.md`](../specs/2026-07-14-pi-capability-parity-design.md)

Research baseline:
[`pi-0.80.3-built-in-capability-inventory.md`](../../research/pi-0.80.3-built-in-capability-inventory.md)

**Goal:** Replace per-Pi web servers and duplicated runtime handling with one Rust Host using native Pi
0.80.7 RPC, then ship the architecture and all approved parity features together.

**Architecture:** A single Rust Host owns HTTP/WebSocket, authorization, local data, process lifecycle,
and a `PiRpcBridge` per process. Frontend feature modules cross one `RuntimeGateway` seam and render
reducer-based per-session stores. The bundled extension contains only namespaced Pi-owned gap adapters.

**Out of scope:** import, gist sharing, encrypted remote transport, session indexing/FTS, arbitrary Pi
TUI rendering.

---

## Phase 0: Freeze contracts and decisions

### Task 1: Record architecture decisions

**Files:**

- Add ADRs under `docs/adr/` for Host/runtime ownership, identity/lifecycle, and remote security.
- Update `CONTEXT.md` only if the new domain language needs to be recorded.

- [ ] Record single Rust Host and no per-Pi TCP listeners.
- [ ] Record one process/one live session, suspend/resume, and source-preserving fork/clone.
- [ ] Record protocol v2 hard cut, stable IDs, mutation idempotency, and snapshot recovery.
- [ ] Record QR/device-token remote access and the accepted lack of transport encryption.
- [ ] Record Pi-owned versus Picot-owned data and behavior.

Commit: `docs: record native runtime architecture decisions`

### Task 2: Freeze Pi 0.80.7 and generate the contract matrix

**Files:**

- Keep `scripts/pi-version.json` at approved `0.80.7`.
- Add `scripts/smoke-pi-rpc.js`.
- Add `tests/fixtures/pi-rpc/0.80.7/`.

- [ ] Run `bun run fetch:pi` and assert the bundled binary reports 0.80.7.
- [ ] Enumerate native command, event, thinking-level, queue, and extension-UI contracts.
- [ ] Capture stable representative JSONL frames without model catalog or credential data.
- [ ] Smoke `get_state`, `get_commands`, prompt acceptance/abort, queue, and clean shutdown.
- [ ] Add a dedicated Bun script; do not add the binary smoke test to every unit-test run.

Commit: `test: freeze pi 0.80.7 rpc contract`

## Phase 1: Characterize product behavior before replacement

### Task 3: Protect multi-session and navigation invariants

**Files:**

- Extend Rust tests around `broker_ws.rs`, `pi_manager.rs`, and `main.rs`.
- Extend frontend tests for session switching, background streaming, unread state, and workspace actions.

- [ ] Characterize foreground/background routing and ambiguous-route rejection.
- [ ] Characterize new/resume session navigation and refresh behavior.
- [ ] Characterize session history, file browser, cost dashboard, packages, model/auth settings, and
  remote/mobile entry.
- [ ] Add a two-window/two-session scenario that detects event contamination.
- [ ] Record intended behavior, not current bugs such as successful no-op settings.

Commit: `test: characterize picot runtime behavior`

## Phase 2: Build the single Rust Host

### Task 4: Create Host server and router modules

**Files:**

- Add `src-tauri/src/host_server.rs`.
- Add `src-tauri/src/host_router.rs`.
- Modify `src-tauri/src/main.rs`.
- Add Rust tests through the router interface.

- [ ] Bind one local HTTP/WebSocket server for the app lifetime.
- [ ] Serve static frontend assets from the Host.
- [ ] Separate runtime, Host-native, data, and remote-auth route namespaces.
- [ ] Add strict request/body/frame limits and structured errors.
- [ ] Expose the one Host origin to every Tauri window.
- [ ] Keep the legacy architecture selectable only by a development startup flag.

Commit: `feat(host): add single picot host server`

### Task 5: Move window navigation to the Host origin

**Files:**

- Modify Rust window creation/navigation.
- Add `public/app-router.js` and tests.
- Modify workspace/session navigation modules.

- [ ] Implement launcher, session, and settings URL routes using opaque IDs.
- [ ] Replace cross-port page navigation with History API navigation.
- [ ] Recover a route on reload without sessionStorage port hints.
- [ ] Render explicit not-found/stopped/deleted states without selecting another session.
- [ ] Atomically replace a temporary new-session URL with the formal Pi session ID.

Commit: `feat(navigation): add stable workspace and session routes`

## Phase 3: Establish identities and Picot metadata

### Task 6: Add SQLite metadata store

**Files:**

- Add `src-tauri/src/metadata_store.rs` and migrations/tests.
- Add the chosen SQLite dependency to `src-tauri/Cargo.toml`.

- [ ] Store stable workspace IDs, UI metadata, suspend policy, paired-device/token hashes, and schema
  version.
- [ ] Keep session content, Pi auth/settings/trust out of SQLite.
- [ ] Add atomic migrations, corruption diagnostics, backup/reset behavior, and restrictive file
  permissions.
- [ ] Migrate existing Picot UI preferences once where appropriate.
- [ ] Prove database reset cannot alter Pi sessions or workspace files.

Commit: `feat(metadata): add picot sqlite store`

### Task 7: Replace path/port routing with opaque identities

**Files:**

- Add or refactor Rust runtime registry modules.
- Modify browser route/state types and tests.

- [ ] Introduce `workspaceId`, `sessionId`, temporary session ID, and `instanceId`.
- [ ] Keep canonical paths only inside the Host registry.
- [ ] Validate workspace/session/instance agreement on every command.
- [ ] Eliminate feature-module use of `sourcePort`, `foregroundPort`, and session path as identity.
- [ ] Add stale-instance, replaced-instance, and cross-workspace rejection tests.

Commit: `refactor(runtime): introduce stable runtime identities`

## Phase 4: Build native Pi process transport

### Task 8: Add `PiRpcBridge`

**Files:**

- Add `src-tauri/src/pi_rpc_bridge.rs` and tests.
- Modify `src-tauri/src/pi_manager.rs`.

- [ ] Pipe Pi stdin/stdout and retain stderr diagnostics.
- [ ] Parse strict LF-delimited JSONL with bounded frames.
- [ ] Correlate native IDs and Host requests.
- [ ] Reject pending requests on timeout, stop, or crash.
- [ ] Classify Pi frames as responses, runtime events, and extension UI requests.
- [ ] Add a fake/in-memory process adapter for deterministic tests.
- [ ] Run `bun run check:rust` after every Rust edit.

Commit: `feat(runtime): add native pi rpc bridge`

### Task 9: Add `RuntimeCoordinator`

**Files:**

- Add `src-tauri/src/runtime_coordinator.rs` and tests.
- Refactor `pi_manager.rs` toward process mechanics behind the coordinator.

- [ ] Enforce one process to one live session.
- [ ] Implement start, resume, attach, stop, crash, and readiness state transitions.
- [ ] Bind formal session ID after first persistence without changing instance ID.
- [ ] Attach a monotonic event sequence per instance.
- [ ] Expose authoritative runtime snapshots.
- [ ] Ensure no process receives identity-replacing `new_session` or `switch_session`.

Commit: `feat(runtime): add session runtime coordinator`

### Task 10: Implement suspend/resume and crash safety

**Files:**

- Modify runtime coordinator, metadata settings, session UI state, and tests.

- [ ] Never suspend visible, working, queued, retrying, compacting, or dialog-blocked instances.
- [ ] Suspend background idle instances after 30 minutes.
- [ ] Keep at most eight background idle instances, suspending LRU excess.
- [ ] Resume with the same session ID and a new instance ID.
- [ ] On crash, restore persisted session only; never replay unknown prompts/tools.
- [ ] Surface accepted/incomplete mutations as outcome unknown.

Commit: `feat(runtime): add safe suspend resume and crash recovery`

## Phase 5: Implement Broker protocol v2

### Task 11: Replace broker frames atomically

**Files:**

- Replace `src-tauri/src/broker_ws.rs` protocol implementation and tests.
- Modify Host WebSocket routing.

- [ ] Add strict v2 handshake and reject mismatches.
- [ ] Add runtime request/response/event/snapshot frames.
- [ ] Add separate Host/data/auth frame families.
- [ ] Route responses only to the requesting client.
- [ ] Broadcast runtime events with stable target identity and sequence.
- [ ] Remove active-port fallback and all port-based upstream connections.
- [ ] Do not implement v1 translation or silent fallback.

Commit: `feat(protocol): replace broker with protocol v2`

### Task 12: Add mutation acceptance and idempotency

**Files:**

- Modify RuntimeCoordinator/Broker modules and tests.

- [ ] Require idempotency keys for prompt, steer, follow-up, compact, bash, fork, clone, navigation,
  and live-setting mutations.
- [ ] Cache bounded recent accepted keys per instance.
- [ ] Distinguish rejected, accepted, completed, failed-after-acceptance, and outcome-unknown.
- [ ] Never auto-retry a non-repeatable mutation.
- [ ] Allow safe automatic retry for declared read-only requests.
- [ ] Redact command contents from structured diagnostics.

Commit: `feat(protocol): add mutation idempotency`

## Phase 6: Build the frontend runtime and state model

### Task 13: Add `RuntimeGateway`

**Files:**

- Add `public/runtime-gateway.js` and tests.
- Refactor `public/websocket-client.js` and `public/transport.js`.

- [ ] Implement request, subscribe, snapshot, and capabilities.
- [ ] Keep runtime and dangerous Host operations in separate interfaces.
- [ ] Normalize native Pi errors/events at the gateway seam.
- [ ] Reject every pending request correctly on disconnect.
- [ ] Add an in-memory adapter used by feature tests.
- [ ] Prove reconnect cannot resolve an old request against a new instance.

Commit: `feat(frontend): add runtime gateway`

### Task 14: Add per-session reducer stores

**Files:**

- Add `public/session-store.js`, selectors, and tests.
- Add workspace/application stores only where state ownership requires them.

- [ ] Model lifecycle, active branch, streaming, tools, queues, retry/compaction, dialogs,
  model/thinking/context/cost.
- [ ] Make reducers pure and immutable.
- [ ] Hydrate from snapshots through explicit actions.
- [ ] Detect sequence gaps and request a snapshot.
- [ ] Update background stores without touching foreground DOM.
- [ ] Keep effects in orchestrator modules, not reducers.

Commit: `feat(frontend): add sequenced session stores`

### Task 15: Split `app.js` into render/effect modules

**Files:**

- Refactor `public/app.js`.
- Add focused lifecycle, chat, session, settings, and notification modules/tests.

- [ ] Replace mutable globals with selectors and explicit orchestration.
- [ ] Make DOM a projection of store state.
- [ ] Preserve IME, multiline, image paste/drop, tool rendering, history, and background indicators.
- [ ] Delete tests that inspect past a module interface after equivalent seam-level tests exist.
- [ ] Keep every new frontend concern under the repository's module-size conventions.

Commit: `refactor(frontend): render from session stores`

## Phase 7: Move the Host data plane out of the extension

### Task 16: Port static and read-only data endpoints to Rust

**Files:**

- Add focused Rust modules for session listing/search, cost scans, files, health, and model/package data.
- Add router-level and module-level tests.

- [ ] Preserve current scan-based behavior; do not add SQLite indexing/FTS.
- [ ] Stream/parse JSONL read-only and tolerate unknown entry types.
- [ ] Restrict file access to registered workspace roots.
- [ ] Preserve session deletion safety and current cost calculations.
- [ ] Preserve remote/mobile access through the one Host.
- [ ] Compare old/new endpoint fixtures before cutover.

Commit: `feat(host): move picot data plane to rust`

## Phase 8: Replace the embedded server with a bridge extension

### Task 17: Extract `PicotBridgeExtension`

**Files:**

- Add focused files under `extensions/` for trust, tree navigation, reload, OAuth, and events.
- Replace `extensions/embedded-server.ts` entry behavior.
- Update extension build and tests.

- [ ] Remove HTTP, static serving, WebSocket, port allocation, instance registry, and duplicate native
  command/event handling.
- [ ] Register only namespaced `picot.*` adapters over Pi-owned methods.
- [ ] Publish a capability description for every bridge operation.
- [ ] Prefer native RPC whenever 0.80.7 supports the behavior.
- [ ] Prove prompt expansion, queue, compaction, and session writing are never implemented here.

Commit: `refactor(extensions): replace embedded server with picot bridge`

## Phase 9: Trust, settings, and remote authorization

### Task 18: Implement blocking Project Trust

**Files:**

- Add `extensions/project-trust.ts`.
- Add Host routing and frontend trust UI/tests.

- [ ] Enter `trusting` before a workspace can accept prompts.
- [ ] Support trust once, trust and remember, open untrusted, and cancel.
- [ ] Use Pi `trust.json`; do not store trust in SQLite.
- [ ] Default to untrusted on timeout/disconnect/no UI.
- [ ] Show loaded/ignored project resources and persistent trust status.
- [ ] Prove project extensions cannot execute before approval.

Commit: `feat(security): gate workspaces with project trust`

### Task 19: Add typed three-scope settings

**Files:**

- Add Rust Pi settings store and tests.
- Refactor frontend settings modules.

- [ ] Read effective values with Global/Project/Pi-default source metadata.
- [ ] Apply Current Session changes through native RPC.
- [ ] Atomically merge Project/Global defaults while preserving unknown keys.
- [ ] Disable project writes for untrusted workspaces.
- [ ] Label restart-required values.
- [ ] Replace the cosmetic auto-compaction control without migrating its fake state.

Commit: `feat(settings): add current project and global scopes`

### Task 20: Add QR remote authorization

**Files:**

- Add Host remote-auth module, SQLite device records, QR endpoint/UI, and tests.

- [ ] Keep remote access user-controlled and preserve existing LAN binding behavior.
- [ ] Generate single-use five-minute pairing tokens.
- [ ] Exchange QR pairing token for a revocable long-term device token.
- [ ] Store only token hashes in SQLite.
- [ ] Add device listing/revoke and token expiry/rotation rules.
- [ ] Restrict remote clients to approved runtime/session operations.
- [ ] Reject folder picker, app open, packages, updater, workspace deletion, and other dangerous Host
  operations remotely.
- [ ] Display an explicit unencrypted-LAN warning.

Commit: `feat(remote): add qr device authorization`

## Phase 10: Native prompt, slash, queue, and runtime controls

### Task 21: Use native prompt processing

**Files:**

- Modify chat effect/composer modules and tests.

- [ ] Send text/images through native Pi `prompt` exactly once.
- [ ] Render local acceptance and native lifecycle without duplicate messages.
- [ ] Handle dropped, rejected, failed-after-acceptance, and unknown delivery states.
- [ ] Restore skills, prompt templates, and extension-command preprocessing.

Commit: `feat(chat): use native pi prompt pipeline`

### Task 22: Add formal slash command syntax

**Files:**

- Replace `public/skill-slash-command.js` with a unified command module and tests.

- [ ] Merge Picot built-in actions with native extension/prompt/skill discovery.
- [ ] Display type, source, scope, and capability state.
- [ ] Reject unknown slash commands.
- [ ] Transform `//text` to literal `/text`.
- [ ] Prevent streaming-incompatible commands from becoming ordinary prompt text.

Commit: `feat(chat): add unified slash commands`

### Task 23: Replace the browser queue

**Files:**

- Add `public/message-queue.js` and tests.
- Modify composer UI and settings.

- [ ] Idle Enter = prompt; working Enter = steer; working Alt+Enter = follow-up.
- [ ] Render queue state only from native events/snapshots.
- [ ] Support `one-at-a-time` and `all` independently.
- [ ] Define abort restore/clear actions without duplicate delivery.
- [ ] Recover queue state after reconnect.

Commit: `feat(chat): use native steer and follow-up queues`

### Task 24: Complete compaction, retry, thinking, bash, and stats

**Files:**

- Add focused runtime-control modules and tests.

- [ ] Use real compact/custom-instruction and auto-compaction commands.
- [ ] Add auto-retry control, retry status, and abort-retry.
- [ ] Derive thinking levels from 0.80.7/model capabilities.
- [ ] Add native user bash and abort-bash.
- [ ] Do not simulate `!!` unless Pi exposes a safe no-context primitive.
- [ ] Replace custom stats with native IDs, messages, tools/results, tokens/cache, cost, and context.

Commit: `feat(runtime): complete native runtime controls`

## Phase 11: Extension UI and OAuth

### Task 25: Implement all RPC-safe extension UI

**Files:**

- Add `public/extension-ui-host.js` and tests.
- Refactor `public/dialogs.js`.
- Add Host routing/cancellation tests.

- [ ] Support select, confirm, input, editor, notify, status, string widget, title, and editor prefill.
- [ ] Route blocking UI by extension/session/instance/owning client.
- [ ] Queue dialogs per session and show pending state for background sessions.
- [ ] Cancel on timeout, disconnect, process stop, or session close.
- [ ] Escape all extension content and never log response values.
- [ ] Report TUI-only operations as unsupported.

Commit: `feat(extensions): add session-bound extension ui`

### Task 26: Add Pi-owned OAuth login/logout

**Files:**

- Add `extensions/oauth.ts` and generic auth UI/tests.

- [ ] Enumerate OAuth providers from Pi.
- [ ] Reuse Pi callbacks for browser URL, device code, input, progress, cancellation, and timeout.
- [ ] Store credentials only through Pi `AuthStorage`.
- [ ] Refresh model availability after login/logout.
- [ ] Keep credentials out of browser storage, SQLite, events, and logs.
- [ ] Report providers that cannot operate headlessly instead of copying their protocol.

Commit: `feat(auth): add pi oauth workflows`

## Phase 12: Tree, fork, clone, and remaining approved UX

### Task 27: Add first-class session tree navigation

**Files:**

- Add `public/session-tree.js`, bridge operation, snapshot refresh, and tests.

- [ ] Render full tree, labels, branches, compactions, summaries, and active leaf.
- [ ] Keep chat view limited to the active branch.
- [ ] Require idle state and offer summary/no-summary/cancel.
- [ ] Call Pi-owned `ctx.navigateTree()` through `picot.navigateTree`.
- [ ] Replace active-branch store from snapshot after success.
- [ ] Preserve state if Pi or an extension cancels/fails.

Commit: `feat(sessions): add tree navigation`

### Task 28: Add source-preserving fork and clone

**Files:**

- Modify RuntimeCoordinator, bridge operations, session UI, and Rust/JS tests.

- [ ] Require source idle and stable session/leaf identity.
- [ ] Create a new process and new session without replacing source identity.
- [ ] Use Pi-owned fork/clone behavior only.
- [ ] Keep source process, queue, route, and UI unchanged.
- [ ] Clean up failed bootstrap instances and temporary artifacts through Pi-owned behavior.
- [ ] Stop at an architecture review gate if safe source-preserving behavior cannot be proven.

Commit: `feat(sessions): add concurrent fork and clone`

### Task 29: Complete reload, help, changelog, and editor conveniences

**Files:**

- Add focused command/help/editor modules and tests.

- [ ] Reload through `ctx.reload()`/native capability and refresh commands/resources.
- [ ] Show embedded Pi 0.80.7 changelog/version.
- [ ] Replace TUI hotkeys with Picot keyboard/help UI.
- [ ] Add `@` file fuzzy selection and Tab path completion.
- [ ] Add external editor through an approved local Host operation.
- [ ] Preserve IME, multiline, paste, images, and dragged file paths.

Commit: `feat(commands): complete approved command and editor parity`

## Phase 13: Atomic cutover and legacy deletion

### Task 30: Switch the product to the new Host

**Files:**

- Modify production startup/configuration.
- Remove the development flag from release builds.

- [ ] Make single Host/Broker v2 the only release path.
- [ ] Verify no Pi process binds a TCP port.
- [ ] Verify all windows and remote clients use the Host origin.
- [ ] Refuse protocol mismatch instead of falling back.
- [ ] Preserve a development-only legacy selector only until Task 31 completes.

Commit: `feat(runtime): cut over to native host architecture`

### Task 31: Delete legacy architecture

**Files:**

- Delete per-Pi HTTP/WebSocket server and duplicate command/event code.
- Remove port allocation/routing, `/api/rpc`, embedded `/ws`, cross-port navigation, and stale tests.

- [ ] Delete `PI_STUDIO_PORT` and per-process web-server setup.
- [ ] Delete broker upstream reconnect and active/source-port routing.
- [ ] Delete fake settings and duplicate runtime handlers.
- [ ] Delete legacy event aliases and compatibility branches.
- [ ] Replace shallow legacy tests with tests through Host, RuntimeGateway, and RuntimeCoordinator seams.
- [ ] Confirm the deletion test: removed modules' complexity does not reappear across callers.

Commit: `refactor(runtime): remove legacy embedded transport`

## Phase 14: Single-release verification

### Task 32: Automated verification

- [ ] Run `bun run check`.
- [ ] Run `bun run test`.
- [ ] Run `bun run check:rust`.
- [ ] Run `bun run build:extensions`.
- [ ] Run the Pi 0.80.7 RPC smoke harness.
- [ ] Run multi-client privacy, routing, idempotency, sequence-gap, trust, QR auth, extension UI,
  OAuth, suspend/crash, queue, tree, fork/clone, settings-scope, and URL-reload suites.
- [ ] Do not use a full Tauri build merely as a verification shortcut.

### Task 33: Manual platform and failure matrix

- [ ] macOS, Windows, Linux: launch, trust/deny, prompt, images, tools, abort, queues, model/thinking,
  compaction/retry, bash, stats, settings.
- [ ] Multiple workspaces and multiple sessions concurrently.
- [ ] Idle suspension, LRU suspension, resume, crash, and outcome-unknown recovery.
- [ ] Tree navigation and source-preserving fork/clone.
- [ ] User/project skills, prompts, extensions, reload, extension dialogs, and OAuth providers.
- [ ] Remote/mobile QR pairing, revoke, reconnect, and forbidden Host-operation attempts.
- [ ] Confirm the unencrypted LAN warning is visible.
- [ ] Confirm secrets and prompt contents are absent from diagnostics.

### Task 34: Documentation and release readiness

- [ ] Rewrite product architecture documentation and diagrams.
- [ ] Document one-process/one-session, suspend, URL routes, queue semantics, trust, slash `//`, tree,
  extension compatibility, OAuth, QR security, and crash recovery.
- [ ] Clearly list deferred import, share, encryption, and indexing.
- [ ] Update the capability inventory with implemented status against Pi 0.80.7.
- [ ] Publish release notes warning that internal v1 endpoints are removed.

Commit: `docs: document native runtime architecture`

## Completion definition

The release is complete only when:

1. Every approved capability is implemented through native Pi RPC, a namespaced thin bridge, or an
   explicit Picot Host workflow.
2. Import, sharing, encrypted remote transport, indexing, and TUI-only rendering are clearly deferred.
3. No successful no-op, unreachable handler, duplicate runtime path, port-based identity, automatic
   mutation retry, or silent protocol fallback remains.
4. The entire automated and manual matrix passes before the single product cutover ships.
