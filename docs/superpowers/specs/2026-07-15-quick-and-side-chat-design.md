# Quick Chat and Side Chat Design

## Status

The product and interaction design was approved in conversation with Dr. Lin on
2026-07-15 and revised after an architecture review. This document defines
ephemeral chats that use Pi's `--no-session` mode. Implementation has not
started.

Reference prototypes:

- [`docs/quick-chat-no-session.png`](../../quick-chat-no-session.png)
- [`docs/side-chat.png`](../../side-chat.png)
- [`docs/side-chat-in-file-panel.png`](../../side-chat-in-file-panel.png)

The prototypes establish visual direction. The behavior in this document is
authoritative where a prototype differs, notably the absence of Quick Chat
history and the support for multiple Side Chats.

## Goal

Let users ask temporary questions without adding context to, replacing, or
persisting the current Pi session.

- **Side Chat** uses the current workspace and Pi's normal workspace tools, but
  has an isolated in-memory context.
- **Quick Chat** uses no user workspace and exposes no tools. It is a temporary,
  general-purpose conversation in a floating dialog.

Both surfaces reuse Picot's existing chat presentation while remaining outside
Pi session history and Picot's session navigation.

## Confirmed Product Decisions

| Concern | Side Chat | Quick Chat |
| --- | --- | --- |
| Working directory | Current workspace | Unique empty Picot-owned OS temporary directory |
| Pi mode | `--no-session` | `--no-session --no-tools` |
| Built-in tools | Enabled | Disabled |
| Extension/custom tools | Enabled by normal Pi behavior | Disabled by `--no-tools` |
| Global extensions, skills, prompt templates, and settings | Loaded by Pi | Loaded by Pi |
| Workspace-local Pi resources | Loaded by Pi | Absent because the cwd is not a user workspace |
| Persistence | None | None |
| Same-window reload/navigation | Rebind from host/Pi memory | Rebind from host/Pi memory |
| Concurrent instances | Up to 5 per workspace window | 1 per workspace window |
| Presentation | Tabs in the File Preview/Edit panel | Non-modal floating dialog |
| Session navigation | Never appears | Never appears |

`--no-tools` was verified against the Picot-pinned Pi 0.80.6 behavior: it
disables built-in, extension, and custom tools while still allowing extensions
and other global resources to load. Picot does not reimplement Pi's resource
discovery or skill/prompt behavior.

## Non-goals

- Saving, resuming, exporting, Pinning, archiving, or listing an ephemeral chat
- A Quick Chat "Recent chats" list
- Moving messages between a temporary chat and a persisted session
- Sharing context between the main chat, Side Chats, or Quick Chat
- Reimplementing Pi session or resource-loading behavior in Rust or JavaScript
- Locking workspace files against concurrent edits by multiple Pi processes
- Supporting creation from LAN/mobile clients in the first version
- Restoring temporary chat content or layout after Picot restarts

## Architecture Choice

Each ephemeral chat runs in its own embedded `pi --mode rpc` process. The
process is owned by `PiManager`, and the existing broker multiplexes its traffic
over the workspace window's single WebSocket connection.

This preserves two current architecture invariants:

1. the WebView does not open a second real-time transport directly to a Pi
   process; and
2. host operations other than bootstrap continue to use `broker_control`
   instead of adding stable Tauri IPC commands.

Registering an ephemeral upstream with the broker must not change the broker's
normal `active_port`. Main-chat routing remains attached to the current persisted
session while ephemeral commands use an explicit ephemeral instance ID.

An iframe-based chat page is rejected because Picot owns the chat DOM and Pi
does not expose a web UI. Reusing the normal active-session broker route is also
rejected because it would replace or disturb the main chat, which is the failure
this feature is designed to prevent.

## Process Model

### Window owner and native capability

The host creates an opaque owner record for each native workspace window. The
owner is bound to that window label, its primary workspace process, and a
host-issued native capability. Reusing a window label after destruction creates
a new owner record and capability.

The capability is a 256-bit value generated from the operating system's
cryptographically secure random source. It is a bearer capability: trusted
WebView JavaScript may hold and submit it, but remote clients cannot guess or
derive it. This mechanism does not defend against malicious script that already
controls the same native WebView and is not an XSS sandbox.

`WebviewWindowBuilder::initialization_script()` injects the capability into the
native workspace WebView's main frame on every load and navigation. The value is
not placed in the HTTP query string, URL fragment, cookie, localStorage, or
sessionStorage. LAN/mobile pages are not constructed with this initialization
script and never receive the value.

The capability must not appear in QR/LAN URLs, `/api/instances`, logs, errors,
telemetry, broker events, progress frames, or diagnostics. The broker stores the
owner association in host memory, compares presented capabilities in constant
time without logging them, and revokes the record when the owning window is
destroyed.

### Ephemeral registry and identity

An `EphemeralRegistry` owns one in-memory partition per window owner. It uses a
single owner-scoped critical section for quota, replacement, close, and exit
transitions. A record is identified by `(ownerId, ephemeralInstanceId,
generation)`, never by port alone:

```text
ownerId
ephemeralInstanceId
generation
kind: side-chat | quick-chat
state: creating | ready | streaming | replacing | closing | failed
port, when allocated
cwd
creation order
child-process identity
Quick Chat temporary-directory path and ownership token, when applicable
```

The ID and registry are **window-lifetime**, not page-lifetime. They remain only
in host memory, survive a WebView reload or navigation in the same window, and
disappear on window destruction or application exit. No registry data is written
to Pi history, browser storage, a database, or an application state file.

The host enforces five Side Chats and one active Quick Chat per owner. Creating,
ready, replacing, and closing records occupy their slots until the registry
finishes the transition. A Quick Chat replacement may temporarily own the old
and candidate children under one atomic replacement reservation; unrelated
requests cannot use that reservation or start a second replacement.

### Atomic creation and replacement

Creation follows reserve/spawn/commit semantics:

1. The broker authenticates the native client and derives the owner from the
   capability binding; it does not accept owner, cwd, port, or workspace identity
   from the request payload.
2. Under the owner lock, the registry validates quota and reserves a new ID and
   generation in `creating` state.
3. The lock is released before directory creation, process spawn, or health
   checks.
4. After readiness, the registry compare-and-commits only if the same ID and
   generation is still reserved and the owner is not closing.
5. Cancellation, timeout, child exit, or a mismatched generation cleans only the
   candidate resources and cannot mutate a newer record or reused port.

Quick Chat replacement keeps the old record routable until the candidate
compare-and-commit succeeds. A concurrent close marks the owner/slot as closing,
cancels the candidate, and closes the old record. A second replace is rejected
as busy. If the old child exits while replacement is pending, the candidate may
still commit; if the candidate then fails, Quick Chat becomes failed/empty
rather than claiming that the old context was recovered.

### Side Chat spawn

The host, not the frontend, resolves and validates the current workspace cwd.
The process receives the normal embedded Pi environment plus an explicit
ephemeral kind and ID, and starts with the equivalent of:

```text
pi --mode rpc --no-session --extension <embedded-server>
```

No flags disable tools, extensions, skills, prompt templates, settings, or
context files. Project trust and workspace resource behavior remain Pi's normal
behavior.

### Quick Chat spawn

The host uses a secure temporary-directory API to create a unique, owner-private
directory such as `picot-quick-chat-<random>` beneath the canonical OS temporary
root. The registry holds its exact canonical path and random ownership token.
The process starts with the equivalent of:

```text
pi --mode rpc --no-session --no-tools --extension <embedded-server>
```

The temporary cwd is not derived from the current workspace. It prevents
workspace-local resources from being selected while leaving Pi's user-global
resource behavior intact. Picot does not pass `--no-extensions`, `--no-skills`,
`--no-prompt-templates`, or `--no-context-files`.

### Readiness and cleanup

Creation succeeds only after the embedded health endpoint is ready. Loopback
health checks use the repository's no-proxy client rule. A spawn error or
readiness timeout unregisters the upstream, terminates the child, and removes a
Quick Chat temporary directory before returning an error.

Each ephemeral child has an exit watcher carrying its owner, instance ID,
generation, port, and Quick Chat ownership token. Natural exit, explicit close,
health failure, window close, and application shutdown all use the same
generation-checked cleanup path. That path unregisters only the matching broker
route, removes only the matching registry record, and terminates only the
matching child.

Quick Chat cleanup additionally verifies that the stored canonical directory is
beneath the expected temporary root and that the record still owns it, then
deletes that exact directory. Port reuse, delayed exit notification, and stale
close requests cannot delete a newer record or directory.

Forced termination, a Picot crash, or an OS kill permits only best-effort
cleanup. The first version does **not** scan or delete temporary directories on
the next launch. Any crash residue is left to the operating system's temporary
directory policy. Picot never deletes a path that is not precisely owned by a
record in the current in-memory registry.

## Broker Protocol and Routing

### Client authentication and authorization

A newly accepted WebSocket is initially unauthenticated and is not yet added to
an owner subscription. Its first protocol frame, within a short timeout,
classifies it as either:

- `native`: presents the injected capability, which the broker validates and
  binds to exactly one owner; or
- `remote`: receives the existing LAN/mobile mirror policy but no native-window
  owner or ephemeral permissions.

An invalid presented capability is rejected generically and never falls back to
remote mode. A new authenticated connection for the same native window
supersedes its stale connection so reload/reconnect does not create duplicate UI
delivery.

The control handler receives a broker-created client context containing client
class and verified owner. It no longer infers "native" merely from the presence
of a host control handler. Missing, invalid, expired, remote, or owner-mismatched
requests to create, replace, close, list, or rebind ephemeral instances fail with
the same authorization response and do not reveal whether an ID exists.

The broker derives owner, primary workspace, and allowed cwd exclusively from
the verified binding. Request fields such as `workspaceId`, `sessionId`,
`sourcePort`, owner, cwd, port, and window label are routing hints at most and
are never authorization evidence.

### Lifecycle and message protocol

Authenticated ephemeral lifecycle commands extend the existing
`broker_control` surface:

- create Side Chat;
- create or replace Quick Chat;
- close one ephemeral instance; and
- list/rebind all ephemeral instances owned by the authenticated window; and
- update the minimal in-memory UI metadata needed across same-window reloads.

Requests use the broker's existing request/result correlation pattern. The
frontend supplies a kind and request ID, not an arbitrary executable, cwd,
port, environment, or Pi flag list.

Commands destined for Pi carry `ephemeralInstanceId`. After owner authorization,
the broker resolves `(owner, ID, generation)` to the upstream and forwards the
inner Pi command without changing `active_port`. Duplicate close requests are
idempotent. A cleanup operation unregisters an upstream only when ID, generation,
and port still match.

Main-session events retain their current LAN/mirror behavior. Ephemeral upstream
events are sent only to the authenticated native client bound to the matching
owner. They are never put through the all-client broadcast path, and remote or
other-window clients receive neither their contents nor existence metadata.

### Session-lifecycle deny policy

After resolving an ephemeral route, the broker inspects the structured inner RPC
command and rejects a named session-lifecycle deny set. It includes current and
equivalent future commands for persisted-session create, new/reset, switch,
resume, fork, tree/history replacement, and export. The policy is a deny set,
not a closed allowlist, so normal prompt, abort, model/thinking, compaction,
skills, prompt templates, and extension commands remain extensible.

The embedded server applies the same semantic deny policy when its ephemeral
marker is present, including session mutation REST handlers, as defense in
depth. A hidden UI control is never the enforcement boundary.

Quick Chat's New Chat is the only reset entry point that **Picot provides**.
Picot provides no reset entry point for Side Chat; users close it and create a
new one. The deny policy constrains Picot-controlled broker/RPC traffic, not code
inside a user-trusted global extension.

Direct WebView-to-ephemeral-port WebSockets are explicitly outside this design.

### Same-window rebind

After an authenticated native connection is established, the broker returns an
owner-scoped bootstrap snapshot containing non-secret descriptors in creation
order. It does not include capability, port, cwd, or another owner's data. The
frontend rebinds each runtime by ID and requests the embedded in-memory message
snapshot to rebuild content and the first-prompt title.

The runtime begins receiving owner-targeted events before requesting its
snapshot, queues those events until the snapshot is applied, and then replays
them using message/tool identity deduplication. This prevents a streaming delta
from being lost or rendered twice during reload.

Minimal UI state such as last active Side Chat and Quick Chat minimized/geometry
may be kept in the owner record and updated only by the authenticated client.
It remains host-memory-only. A page reload, WebView reload, development hot
reload, or native navigation restores live chats in the same window; another
window cannot list or rebind them. Application restart restores none.

## Embedded Server Behavior

The embedded server continues to expose the process-scoped HTTP/WS surface that
Picot requires. When the ephemeral environment marker is present, it must:

- publish its instance ID and kind to the broker handshake/event metadata;
- skip the normal instance-registry entry used by `/api/instances`;
- skip session-title and persisted-session side effects; and
- enforce the server-side session-lifecycle deny policy;
- retain prompt, abort, model, thinking-level, extension-UI, event, health, and
  usage behavior required by the temporary chat UI.

The marker changes Picot integration behavior, not Pi runtime semantics. It must
not turn the embedded extension into an external Pi implementation.

## Frontend Module Boundaries

The feature must not add its business logic to `public/app.js`.

### `public/ephemeral-chat-runtime.js`

Owns one ephemeral chat's connection-facing state: instance ID, Pi command
correlation, message streaming, tool events, model and thinking state, image
attachments, usage, disconnect state, and abort behavior. It consumes only
broker-authorized, owner-targeted events and emits view state. It contains no
session switching, history loading, background-session routing, or persistence.

### `public/ephemeral-chat-view.js`

Creates an element-scoped message area, compact usage/status row, and composer.
It reuses `WebSocketClient` event conventions, `MessageRenderer`,
`ToolCardRenderer`, Markdown, image processing, dialogs, and voice-input
primitives without duplicating global element IDs. Multiple views can remain
alive while only one right-panel view is visible.

The view has an idempotent `destroy()` contract. It destroys its
`MessageRenderer` and `ToolCardRenderer`, releases voice/image/dialog helpers,
removes DOM, pointer, keyboard, resize, and focus listeners, and makes later
runtime callbacks no-ops. Hiding, deactivating, collapsing, or minimizing a view
does not call `destroy()`.

`MessageRenderer` must store its scroll handler and gain an idempotent
`destroy()` that removes the handler and its locale subscription.
`ToolCardRenderer.destroy()` unsubscribes from locale changes, clears tool-card
state, and releases its container. Any reused voice, attachment, or dialog setup
helper must return an explicit cleanup function for the owning view.

The first implementation does not rewrite the main chat into this abstraction.
It shares stable lower-level renderers and keeps the main session-routing path
unchanged, reducing regression risk.

### `public/side-chat-manager.js`

Owns the collection of Side Chat runtimes and views, the five-instance limit,
tab titles, unread state, active Side Chat selection, creation, and close flows.
It integrates with the preview panel through an explicit transient-content-tab
interface.

### `public/quick-chat-dialog.js`

Owns the single Quick Chat runtime and view, non-modal dialog state, drag and
resize state machines, New Chat, minimize/restore behavior, the minimized chip,
and in-memory geometry.

### `public/window-close-coordinator.js`

Owns the only JavaScript window-close decision flow. File and ephemeral features
register risk/settlement participants; they do not install competing native
close dialogs. The coordinator also owns the single synchronous `beforeunload`
fallback used for dirty browser state during reload.

### File Preview/Edit integration

The panel uses a discriminated active-content model:

```text
activeContent = { kind: "file", id }
              | { kind: "transient", id }
              | null
```

`FileTabState` remains the only source of truth for file tabs and persistence.
`SideChatManager` remains the only source of truth for Side Chat runtimes,
titles, status, and view lifecycle. `FilePreviewPanel` owns only the combined tab
projection, visual order, active-content selection, and file renderer.

The panel exposes an explicit transient-tab adapter:

```text
registerTransientTab(descriptor)
updateTransientTab(id, visualState)
activateContent({ kind, id })
requestCloseTransientTab(id)
unregisterTransientTab(id)
showPanel()
hidePanel()
```

A descriptor supplies a stable ID, localized/default title, status indicator,
content element, `onActivate`, `onDeactivate`, and async `onRequestClose`
callbacks. It does not expose a Pi runtime or process handle to the panel.
Registration and updates are in-memory and never enter `FileTabState`.

Transitions follow these rules:

- file → transient: capture the file renderer value, preserve it in
  `FileTabState`, destroy/unmount only the file renderer, hide file-only toolbar
  controls, show the transient content, and call `onActivate`;
- transient → file: call `onDeactivate`, hide but do not destroy the transient
  content, then mount the selected file renderer and toolbar;
- transient → transient: deactivate/hide the old content and activate/show the
  new content without touching either runtime;
- panel hide/collapse: hide presentation only; no transient close callback or
  runtime destruction occurs;
- Side Chat tab close: await `onRequestClose`; remove and destroy the view only
  after confirmed host cleanup, while failure/cancel leaves the tab intact; and
- panel close: retain existing dirty-file settlement semantics, then hide the
  panel; it never closes Side Chats merely because they share the panel.

The header Files control continues to toggle the File tree and does not switch
or close the active panel tab. Selecting a file activates its file tab. The
header Side Chat control opens/restores the most recently active Side Chat or
collapses the panel when that chat is already visible; dirty files are untouched.

Tabs use roving tabindex: only the active tab is in the tab order. Left/Right
Arrow, Home, and End move and activate tabs across the combined visual order.
After closing the active tab, focus and activation move to the next tab on the
right, otherwise the previous tab; if no tabs remain, the panel hides and focus
returns to the relevant header control. Horizontal overflow keeps the focused
tab visible.

## Side Chat Interaction

### Entry and creation

A localized Side Chat button appears in the shared workspace header immediately
beside the existing Files button.

- With no Side Chat, it creates the first one and opens the right panel.
- With existing Side Chats, it opens the panel and restores the most recently
  active Side Chat without creating another process.
- If the panel already shows that Side Chat, pressing the header button again
  collapses the panel without destroying it.

The panel tab bar contains a distinct chat-plus control labeled "New Side Chat".
It creates additional Side Chats. It is disabled at five and explains the limit
in its tooltip/status text; it is not an ambiguous generic plus button.

### Tabs

Side Chat tabs appear before file tabs and preserve creation order. Drag
reordering is not part of the first version. Overflow scrolls horizontally, and
the active tab is scrolled into view.

The initial localized title is "Side Chat". After the first user message, the
title changes once to that prompt, with line breaks and repeated whitespace
collapsed and a Unicode-grapheme-safe visual truncation. The full normalized
prompt is available in a tooltip. The generated title is local UI state: it does
not call a model and is never persisted.

An inactive Side Chat shows a non-color-only streaming indicator. A completed
background response changes that to an unread indicator, cleared when the tab
is activated.

### Content and usage

The visible Side Chat mirrors main-chat rendering and composer controls,
including Markdown, thinking, tool cards, image attachment, commands, model,
thinking level, and voice input. A compact row exposes connection status,
context usage, and cost for the active Side Chat. Inactive tabs do not attempt
to display live usage in their labels.

Cost and token information belongs to the temporary runtime and disappears when
the Side Chat closes. This feature does not add a second global usage ledger;
any aggregate Usage behavior continues to follow Picot's existing data source.

## Quick Chat Interaction

### Sidebar toolbar

The sidebar gains a fixed toolbar between search and the foldable navigation
content. Open Folder, Quick Chat, Refresh, and similar global actions belong to
this toolbar. Quick Chat is not part of `RECENT`, `PINNED`, `PROJECTS`, or
`ARCHIVED`, and those regions retain their approved meanings and fold behavior.

The first version exposes the control only in a native Tauri workspace window.
LAN/mobile clients hide it, and the broker independently rejects all ephemeral
lifecycle, listing, rebind, and message requests from remote-class clients.

### Dialog

Each workspace window owns at most one Quick Chat. Its dialog:

- is non-modal and does not close when the user interacts with the main UI;
- opens centered at a sensible responsive size;
- can be moved by its title bar and resized from edges and corners;
- remains bounded so that a recovery affordance cannot be dragged completely
  outside the Picot content area; and
- remembers geometry only for the current workspace-window lifetime.

The title remains "Quick Chat". The title bar contains compact context and cost
information plus New Chat, minimize, and close controls. The body reuses the
main chat's messages, Markdown, thinking, image attachment, prompt templates,
skills, commands, model, thinking-level, and voice controls. Tool controls and
tool cards are absent because all tools are disabled.

The Quick Chat prototype's Recent chats column is deliberately omitted.

### Minimize and restore

Minimizing hides the dialog without changing the runtime. It can be restored
from either the sidebar Quick Chat button or a small floating chip at the lower
right of the main content, positioned so that it does not cover composer
controls. The chip is required because the sidebar itself can be collapsed.

The chip shows a reduced-motion-safe generating state and a non-color-only
unread state when a background response completes. Restoring the dialog clears
the unread state. The chip has no destructive close action.

### Focus and shortcuts

Opening or restoring focuses the Quick Chat's last meaningful control. Minimize
returns focus to its toolbar button when visible, otherwise to the main chat.
Closing returns focus to the control that opened it. With Quick Chat focused,
Escape aborts its active response before it can affect the main chat; Escape
does not close or minimize the dialog.

## Lifecycle and Destructive Actions

Each runtime follows these conceptual states:

```text
creating -> ready <-> streaming -> closing -> closed
    |          |           |
    +----------+---------> failed

ready(old) + creating(candidate) -> replacing -> ready(candidate) | ready(old)
failed(old) + creating(candidate) -> replacing -> ready(candidate) | failed(empty)
```

Visibility is orthogonal. Switching tabs, selecting a file, collapsing the
panel, or minimizing Quick Chat does not transition the runtime toward closed.

Closing an empty temporary chat is immediate. Closing a chat with messages, or
one that is streaming, requires a localized confirmation explaining that the
conversation is not saved and cannot be recovered. Confirming a streaming close
requests abort before terminating the process. Cancel leaves both UI and
runtime unchanged.

### Window close coordinator

Rust intercepts `WindowEvent::CloseRequested` before destruction, prevents the
initial close, and sends a targeted close request through the authenticated
owner's broker connection. `WindowEvent::Destroyed` remains final cleanup, not
the first chance to coordinate.

The JavaScript coordinator collects one immutable risk snapshot from its
participants: dirty file tabs and non-empty/streaming ephemeral chats. The flow
is serialized by request ID:

1. With no risk, the client immediately authorizes close.
2. With risk, one summary dialog describes unsaved files and the number of
   temporary chats that will be discarded. Cancel performs no save, discard,
   abort, process termination, or window close.
3. Continue invokes the file participant's existing Save/Discard/Cancel flow.
   Cancel or save failure keeps the window open, reports a recoverable error,
   and does not touch ephemeral runtimes.
4. Only after file settlement succeeds does the coordinator abort streaming
   ephemeral chats and request generation-checked owner cleanup.
5. Only after cleanup succeeds does the client send the authorized one-shot
   close approval. Rust consumes that approval and allows the next close event.

Only one close transaction may be active. Repeated OS close requests focus the
existing dialog. A failed phase keeps the window and coordinator usable for
retry; it never starts a competing confirmation.

`FilePreviewPanel` removes its private `beforeunload` registration and registers
its dirty-state participant with the coordinator. The coordinator owns one
synchronous `beforeunload` fallback for page reload/navigation. That fallback
guards dirty files only: ephemeral runtimes are window-lifetime and rebind after
reload. Browser `beforeunload` cannot replace the asynchronous native close
transaction.

If the native WebView is disconnected when Rust receives CloseRequested, the
host cannot save DOM-only file buffers. It presents one native fallback warning
that closing will discard unsaved UI state and temporary chats. Cancel retains
the window; confirm performs host-owned ephemeral cleanup and closes. Forced
process or OS termination remains best-effort and cannot guarantee confirmation.

Quick Chat's New Chat uses replacement semantics. After confirmation, Picot
starts the new process and waits for readiness before closing the old one. If
creation fails while the old child is alive, the existing Quick Chat and its
visible content remain intact. Close, replace, exit, and window-close races are
resolved by the registry generation rules rather than UI timing.

Same-window reload/rebind reconstructs live runtime content from Pi's in-memory
snapshot and host-memory UI metadata. No ephemeral runtime, tab title, unread
state, window geometry, or message is persisted across application restart.

## Concurrency and Workspace Files

Every Side Chat and the main chat can generate concurrently because each has a
separate Pi process. They can also read and modify the same workspace files.
Picot does not add a cross-agent file lock, serialize tool calls, or imply that
Side Chat is read-only.

The existing file-preview optimistic conflict detection remains authoritative
for unsaved editor buffers. Changes made directly by different Pi processes can
still race at the filesystem level. The UI should describe Side Chat as
context-isolated, not workspace-isolated.

## Security and Trust Boundary

Quick Chat is tool-free, not sandboxed. `--no-tools` removes all built-in,
extension, and custom tools from the model's active tool set. User-global
extensions are still trusted executable Pi code: initialization hooks, event
handlers, and explicitly invoked extension commands may perform their own side
effects, including calling Pi session APIs directly. Broker and embedded-server
deny policies cannot sandbox code already running inside the Pi process. This is
the accepted consequence of preserving Pi's normal global extension behavior.

The empty temporary cwd prevents intentional access to the current user
workspace through Picot's cwd selection, but it is not an OS sandbox or a
filesystem permission boundary. Side Chat has the same workspace and trust
surface as the main Pi process. Picot must not describe either mode as a security
sandbox or claim that it can prevent a user-trusted extension from changing
context. Product guarantees about reset and persisted-session commands apply to
Picot-provided UI and Picot-controlled broker/RPC traffic.

## Failure and Recovery

- A creation request has a visible pending state and cannot be duplicated by
  repeated clicks.
- A creation failure shows a localized inline error and Retry action without
  creating a false tab or history item.
- A transient broker/upstream disconnect preserves rendered content and uses
  the existing bounded reconnect behavior.
- After an authenticated reconnect, the frontend lists only its owner's live
  records and rebinds to the same ID/generation.
- If the process exited, old content remains readable but sending is disabled.
  The user can close it or start a new temporary chat; the UI must not call this
  a resumed conversation.
- Errors from prompt delivery, abort, model changes, extension UI, startup, and
  cleanup are logged with the instance ID and kind. User-facing errors remain
  concise and never expose arbitrary environment values.

## Internationalization and Accessibility

All labels, tooltips, statuses, confirmations, errors, empty states, and ARIA
labels use `t()` and exist in both `public/locales/en.json` and
`public/locales/zh.json`. The i18n completeness test includes every new module.

Locale changes update default Side Chat titles, Quick Chat chrome, and status
text immediately. A tab already titled from a user prompt preserves the user's
text. Dynamic strings are inserted through text-safe DOM APIs.

The shared tab bar uses `tablist`, `tab`, and `tabpanel` semantics with pointer,
Enter/Space, and keyboard tab-navigation support. Icon controls have localized
names. Streaming, unread, connection, and error states use accessible text/live
regions and do not rely on color alone.

The Quick Chat dialog uses non-modal dialog semantics. Dragging and resizing are
explicit, mutually exclusive state machines with complete pointer-cancel and
window-blur cleanup. Keyboard resize controls provide a non-pointer path. Motion
respects `prefers-reduced-motion`. WKWebView focus, drag, and resize behavior
requires manual desktop verification in addition to jsdom tests.

## Verification Strategy

### Host and broker tests

- exact Side Chat and Quick Chat Pi arguments and environment markers;
- no unbundled or PATH-resolved Pi binary;
- 256-bit host capability generation, native-only initialization injection, and
  revocation on window destruction;
- unauthenticated/native/remote handshake states, invalid-token rejection, and
  no capability leakage through URLs, events, logs, errors, or diagnostics;
- owner derivation from verified client context rather than request payload;
- rejection of native-only lifecycle commands from LAN/mobile and other owners
  without revealing whether an instance exists;
- owner-targeted ephemeral delivery while existing main-session LAN mirroring
  remains unchanged;
- host-side quota reservations and owner enforcement under concurrent requests;
- reserve/spawn/compare-and-commit behavior for create, close, child exit, and
  readiness failure;
- transactional Quick Chat replacement races: concurrent replace, close during
  replace, old-child exit, candidate failure, and window close;
- broker routing by ephemeral ID without changing `active_port`;
- generation-checked idempotent cleanup and delayed-exit/port-reuse safety;
- child-exit watcher removal of the exact registry record and upstream route;
- no-proxy health checks, readiness failure cleanup, and window-level cleanup;
- safe creation and deletion of only the current registry's exact Quick Chat
  directory on every normal close path; and
- application startup performs no stale Quick Chat directory scan or deletion.

### Embedded server tests

- ephemeral metadata is published to the broker;
- chat RPC and events remain available;
- `--no-session` creates no session file;
- ephemeral processes do not enter the normal instance registry;
- automatic session-title and history side effects are skipped; and
- ephemeral mode rejects Picot-controlled `new_session`, `switch_session`,
  resume, fork, history/tree replacement, export, and equivalent mutation
  requests while permitting non-lifecycle and extension commands;
- Quick Chat reports no active tools while global non-tool resources remain
  available according to Pi behavior.

### Frontend tests

- creation, switching, and independent streaming for multiple Side Chats;
- five-instance limit and repeated-click suppression;
- Unicode-safe first-prompt tab title and tooltip;
- tab overflow, active visibility, streaming, and unread states;
- transient-tab register/update/activate/close/unregister transitions and the
  `file | transient | none` active-content model;
- roving tabindex, Arrow/Home/End behavior, active-tab close focus, and overflow
  focus visibility;
- file/Side-Chat switching without file-state or process loss;
- close confirmation, abort-before-close, and failed-close recovery;
- one native window-close transaction coordinating dirty-file settlement before
  ephemeral cleanup, including cancel, save failure, retry, repeated close, and
  disconnected-WebView fallback;
- the centralized `beforeunload` fallback guards dirty file buffers without
  destroying window-lifetime ephemeral runtimes;
- Quick Chat non-modal behavior, New Chat transactional replacement,
  minimize/restore paths, unread state, geometry bounds, and focus restoration;
- same-window reload/navigation rebind from an authorized owner snapshot,
  including message/title reconstruction and cross-window rejection;
- `MessageRenderer`, `ToolCardRenderer`, and `EphemeralChatView` idempotent
  teardown, including no locale updates after destroyed Side Chats close;
- Quick Chat exposes one Picot-provided New Chat reset; Side Chat exposes none;
- runtime failure/reconnect states; and
- English/Chinese key completeness and live locale changes.

### Required regression and manual checks

Implementation must run focused tests first, then `bun run test`, `bun run
check`, and `bun run check:rust` for the files changed. It must also manually
exercise the real bundled Pi in the desktop Tauri WebView:

1. Main chat, five Side Chats, and Quick Chat can stream independently.
2. Side Chat can use workspace tools without adding main-session context.
3. Quick Chat can use global skills, prompt templates, extensions, and settings,
   while built-in, extension, and custom tools remain unavailable.
4. Closing all temporary chats creates no Pi session-history entry.
5. Temporary chats never appear in `RECENT`, `PINNED`, `PROJECTS`, `ARCHIVED`,
   or normal running instances.
6. File tabs and dirty buffers survive Side Chat switching and panel collapse.
7. Window close and application exit leave no owned Pi process or Quick Chat
   directory behind under normal shutdown.
8. Chinese and English UI, keyboard operation, pointer drag/resize, reduced
   motion, minimized restoration, and error recovery work in WKWebView.
9. Reloading or navigating the native WebView restores the same window's live
   ephemeral chats, while another native window and LAN/mobile clients cannot
   list, control, rebind, or receive them.
10. Closing a real Tauri window exercises the unified close coordinator without
    competing browser/native dialogs; disconnect fallback is also verified.
11. A previous-run Quick Chat temporary directory is not scanned or deleted on
    Picot startup.

## Acceptance Criteria

The feature is complete when all of the following are true:

1. A user can create up to five independent Side Chats in one workspace window.
2. Creating, opening, hiding, or using a Side Chat never replaces the main
   session or adds messages to it.
3. Side Chats share the File Preview/Edit panel with file tabs and preserve both
   file and chat state when switching.
4. A user can open one workspace-independent, tool-free Quick Chat, continue
   using the main UI behind it, minimize it, and restore it from both recovery
   affordances.
5. Temporary chat messages, titles, and layout are never persisted or listed as
   sessions.
6. Explicit destructive actions protect non-empty chats with the approved
   confirmation behavior.
7. Process, broker-route, and temporary-directory cleanup is bounded to the
   correct owner and succeeds on every normal lifecycle path.
8. Same-window page reload/navigation rebinds live chats without browser or
   filesystem persistence; application restart restores none.
9. Missing/invalid capability, another window, and LAN/mobile clients cannot
   discover, control, or receive an owner's ephemeral chats.
10. Picot-controlled persisted-session lifecycle commands are denied in both
    broker and embedded-server layers; no claim is made that Picot sandboxes
    user-trusted extension code.
11. The feature is localized, keyboard accessible, and does not regress the
   existing main chat, session routing, sidebar regions, file editor, or mobile
   surface.

## Open Questions

None. Material product and architecture decisions are resolved in this design.
