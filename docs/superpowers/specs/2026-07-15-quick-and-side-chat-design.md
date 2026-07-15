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

### Ephemeral instance identity

The host generates an opaque, page-lifetime `ephemeralInstanceId`. The frontend
never treats a port as a durable identity. Host metadata includes:

```text
ephemeralInstanceId
kind: side-chat | quick-chat
owner: workspace broker/window
port
cwd
child process
temporary-directory ownership, when applicable
```

The owning broker/window is the isolation and quota boundary. A frontend request
cannot create or close an ephemeral instance owned by another workspace window.
The host enforces the five-Side-Chat and one-Quick-Chat limits even when the
frontend disables the corresponding controls. An approved Quick Chat replacement
may temporarily hold the old and candidate processes at the same time; this is
an atomic replacement reservation, not a second user-visible Quick Chat, and no
unrelated create request may use it to bypass the quota.

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

The host creates a unique empty directory under the OS temporary directory and
starts the process with the equivalent of:

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

Normal close, process exit, workspace-window close, and application exit all
remove the host record and broker route. Quick Chat additionally removes its
temporary directory. On startup, Picot may remove only directories that contain
Picot's own Quick Chat ownership marker and are not associated with a live Picot
process; it must not scan or delete unrelated temporary content.

## Broker Protocol and Routing

Ephemeral lifecycle commands extend the existing `broker_control` surface:

- create Side Chat;
- create or replace Quick Chat;
- close one ephemeral instance; and
- query whether a known ephemeral instance is still alive when reconnecting.

Requests use the broker's existing request/result correlation pattern. The
frontend supplies a kind and request ID, not an arbitrary executable, cwd,
port, environment, or Pi flag list.

Commands destined for Pi carry `ephemeralInstanceId`. The broker resolves that
ID to the owned upstream and forwards the inner Pi command without changing
`active_port`. Upstream events carry the same ID and kind in their
`broker_event` envelope. Events without an ephemeral ID continue through the
existing main-session path unchanged.

The ephemeral command surface rejects normal session-lifecycle operations such
as switching or resuming a persisted session, forking into session history,
creating a persisted session, and exporting session history. Quick Chat's New
Chat control is the only Quick Chat reset path. Skills, prompt templates,
compaction, model/thinking changes, abort, and extension commands remain subject
to Pi's normal `--no-session` behavior.

The broker unregisters dead ephemeral routes. Duplicate close requests are
idempotent and cannot close a port that has been reused by another instance.
Direct WebView-to-ephemeral-port WebSockets are explicitly outside this design.

## Embedded Server Behavior

The embedded server continues to expose the process-scoped HTTP/WS surface that
Picot requires. When the ephemeral environment marker is present, it must:

- publish its instance ID and kind to the broker handshake/event metadata;
- skip the normal instance-registry entry used by `/api/instances`;
- skip session-title and persisted-session side effects; and
- retain prompt, abort, model, thinking-level, extension-UI, event, health, and
  usage behavior required by the temporary chat UI.

The marker changes Picot integration behavior, not Pi runtime semantics. It must
not turn the embedded extension into an external Pi implementation.

## Frontend Module Boundaries

The feature must not add its business logic to `public/app.js`.

### `public/ephemeral-chat-runtime.js`

Owns one ephemeral chat's connection-facing state: instance ID, Pi command
correlation, message streaming, tool events, model and thinking state, image
attachments, usage, disconnect state, and abort behavior. It consumes filtered
broker events and emits view state. It contains no session switching, history
loading, background-session routing, or persistence.

### `public/ephemeral-chat-view.js`

Creates an element-scoped message area, compact usage/status row, and composer.
It reuses `WebSocketClient` event conventions, `MessageRenderer`,
`ToolCardRenderer`, Markdown, image processing, dialogs, and voice-input
primitives without duplicating global element IDs. Multiple views can remain
alive while only one right-panel view is visible.

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

### File Preview/Edit integration

`FilePreviewPanel` may render file tabs and transient content tabs in one tab
bar. Side Chat tabs are not inserted into persisted `FileTabState`. File dirty
state, renderer teardown, saved tab order, and workspace-root isolation remain
file-only responsibilities.

Activating a Side Chat unmounts or hides the active file renderer according to
the existing file-tab contract and hides file-only toolbar controls. Activating
a file restores those controls. Closing or collapsing the entire panel preserves
all open tabs and ephemeral processes.

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
LAN/mobile clients hide it because they cannot own or clean up local Pi
processes through the native broker lifecycle.

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
              |          |
              +------> failed
```

Visibility is orthogonal. Switching tabs, selecting a file, collapsing the
panel, or minimizing Quick Chat does not transition the runtime toward closed.

Closing an empty temporary chat is immediate. Closing a chat with messages, or
one that is streaming, requires a localized confirmation explaining that the
conversation is not saved and cannot be recovered. Confirming a streaming close
requests abort before terminating the process. Cancel leaves both UI and
runtime unchanged.

An ordinary workspace-window close request presents one aggregate confirmation
when any owned ephemeral chat contains messages; it never presents one dialog
per chat. After confirmation, the host closes every owned ephemeral instance.
Forced process or OS termination can only perform best-effort cleanup and cannot
guarantee a confirmation. This guard composes with the existing unsaved-file
close guard so the window never opens competing confirmation dialogs.

Quick Chat's New Chat uses replacement semantics. After confirmation, Picot
starts the new process and waits for readiness before closing the old one. If
creation fails, the existing Quick Chat and its visible content remain intact.

No ephemeral runtime, tab title, unread state, window geometry, or message is
persisted across application restart.

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
effects. This is the accepted consequence of preserving Pi's normal global
extension behavior.

The empty temporary cwd prevents intentional access to the current user
workspace through Picot's cwd selection, but it is not an OS sandbox or a
filesystem permission boundary. Side Chat has the same workspace and trust
surface as the main Pi process. Picot must not describe either mode as a security
sandbox.

## Failure and Recovery

- A creation request has a visible pending state and cannot be duplicated by
  repeated clicks.
- A creation failure shows a localized inline error and Retry action without
  creating a false tab or history item.
- A transient broker/upstream disconnect preserves rendered content and uses
  the existing bounded reconnect behavior.
- If the host reports that the child remains alive, the runtime may rebind to
  the same ephemeral ID.
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
- host-side quota and owner enforcement;
- transactional Quick Chat replacement without a general quota bypass;
- broker routing by ephemeral ID without changing `active_port`;
- event tagging and isolation between main chat and multiple Side Chats;
- idempotent close and port-reuse safety;
- no-proxy health checks, readiness failure cleanup, and window-level cleanup;
- safe creation and deletion of only Picot-owned Quick Chat directories.

### Embedded server tests

- ephemeral metadata is published to the broker;
- chat RPC and events remain available;
- `--no-session` creates no session file;
- ephemeral processes do not enter the normal instance registry;
- automatic session-title and history side effects are skipped; and
- Quick Chat reports no active tools while global non-tool resources remain
  available according to Pi behavior.

### Frontend tests

- creation, switching, and independent streaming for multiple Side Chats;
- five-instance limit and repeated-click suppression;
- Unicode-safe first-prompt tab title and tooltip;
- tab overflow, active visibility, streaming, and unread states;
- file/Side-Chat switching without file-state or process loss;
- close confirmation, abort-before-close, and failed-close recovery;
- Quick Chat non-modal behavior, New Chat transactional replacement,
  minimize/restore paths, unread state, geometry bounds, and focus restoration;
- event filtering by ephemeral ID so main and temporary chats cannot cross;
- session-lifecycle command rejection on every ephemeral route;
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
8. The feature is localized, keyboard accessible, and does not regress the
   existing main chat, session routing, sidebar regions, file editor, or mobile
   surface.

## Open Questions

None. Material product and architecture decisions are resolved in this design.
