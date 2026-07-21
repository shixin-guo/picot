# Terminal Panel Design

## Status

The product, interaction, process-lifecycle, transport, persistence, and security
choices in this document were approved in conversation with Dr. Lin on
2026-07-21. Implementation has not started.

References:

- [`docs/terminal-panel.jpg`](../../terminal-panel.jpg) defines the Terminal
  Panel's visual direction and tab-bar hierarchy.
- [`docs/terminal-panel-architecture.md`](../../terminal-panel-architecture.md)
  analyzes Codux's terminal implementation and informed the separation between
  PTY ownership, terminal state, and rendering.
- [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) defines Picot's current host,
  broker, embedded-server, WebView, owner-capability, and workspace-transition
  boundaries.
- [`docs/engineering-lessons.md`](../../engineering-lessons.md) defines the
  required cross-boundary and visual verification criteria.

The behavior in this document is authoritative where the reference image does
not specify behavior.

## Goal

Add a native-owner-only Terminal Panel to Picot. The panel sits below the
right-hand workspace content, spans the chat, File Preview, and File Browser
columns, and provides multiple terminal tabs for the current workspace.

Each terminal tab owns a real local shell running in a PTY. Terminal processes
continue running when their panel is collapsed and when the owning window
navigates to another workspace. Returning to the workspace restores the
terminal screen from an in-memory checkpoint and replays output produced while
the workspace was not visible.

The first version supports macOS and Windows. Windows uses Git Bash as its
default shell profile because the company environment requires Git for Windows.

## Confirmed Product Decisions

| Concern | Decision |
| --- | --- |
| PTY implementation | Rust `portable-pty` |
| Terminal renderer | Bundled `xterm.js` in the existing vanilla-JS WebView |
| Host transport | Existing authenticated broker WebSocket |
| Workspace model | One Terminal Panel per workspace within its native window owner |
| Tab model | Multiple tabs; one independent PTY per tab |
| Quota | 5 tabs/workspace; 15 live/reserved PTYs globally |
| Initial state | Panel is collapsed; no PTY is created until first expansion |
| Collapse behavior | Hides the panel without terminating any PTY |
| Cross-session behavior | Switching Pi chat sessions does not affect terminals |
| Cross-workspace behavior | PTYs remain running in the background and reattach on return |
| Restart behavior | Restore tab metadata, but create fresh shells from workspace root |
| Last shell cwd | Not tracked or restored |
| Screen restoration | xterm checkpoint plus sequence-numbered Rust output journal |
| Remote access | Forbidden for LAN, mobile, and unauthenticated browser clients |
| macOS default | User's valid default shell, with safe system-shell fallback |
| Windows default | Git Bash; missing Git Bash produces guidance rather than a silent fallback |
| Alternative Windows profiles | PowerShell and Command Prompt are manually selectable |
| Live-tab close | Always confirms before terminating the shell and descendants |
| App/window close | One owner-scoped summary confirmation, then process-tree cleanup |

## Non-goals

- Codux's GPUI renderer, terminal split-tree layout, floating terminal windows,
  remote-host viewport ownership, Kitty graphics, or restored native processes
- Direct reuse or copying of GPLv3 Codux terminal source
- More than one visible Terminal Panel for the same workspace
- Arbitrary horizontal or vertical splitting inside the Terminal Panel
- Reattaching to a shell process after Picot itself exits
- Persisting terminal output, command history, environment variables, or the
  shell's last working directory to disk
- Exposing terminal creation, input, output, or metadata to LAN/mobile clients
- Letting the WebView choose an executable, argument vector, environment, cwd,
  owner, workspace path, or host process identifier
- Shell integration injection for cwd or command-state detection in the first
  version
- Accurately detecting whether a live shell is currently at a prompt; all live
  PTYs use the same close confirmation

## Architecture Choice

Picot uses the Codux-like separation of a native PTY owner from the terminal
view, but does not copy Codux's implementation:

```text
WebView xterm.js
    ⇅ owner-scoped terminal frames
BrokerWs
    ⇅ internal bounded terminal queue
TerminalManager
    ⇅ raw bytes / resize / lifecycle
portable-pty
    ⇅
local shell
```

Rust owns every shell and PTY. The WebView owns ANSI parsing, screen state,
selection, IME behavior, clipboard interaction, accessibility, and painting
through xterm.js. This avoids implementing a second terminal emulator and
canvas renderer while retaining native process ownership and cross-platform PTY
behavior.

Terminal traffic uses the existing broker WebSocket. It does not pass through
`extensions/embedded-server.ts`, does not enter a Pi process, and does not add a
stable Tauri command. A dedicated terminal WebSocket was rejected because it
would add a port, authentication surface, and lifecycle path. Tauri commands and
events were rejected because host operations other than bootstrap currently use
the authenticated broker boundary.

The broker must schedule Terminal output through an independent bounded,
low-priority queue. Pi chat/control frames have priority, so a noisy terminal
cannot starve agent streaming or session routing even though both share one
physical WebSocket.

## Component Boundaries

### Rust host

#### `terminal_manager.rs`

`TerminalManager` owns the PTY processes and is the only module allowed to
spawn, write to, resize, restart, or terminate a terminal. Its responsibilities
are:

- reserve quota before spawn and release quota after terminal cleanup;
- resolve the current authenticated owner and canonical workspace root;
- resolve a server-defined shell profile into an executable and fixed arguments;
- spawn a PTY with the canonical workspace root as cwd;
- run output-reader and exit-watcher tasks;
- batch output, assign sequence numbers, and publish events;
- resize only when dimensions changed;
- terminate the full process tree idempotently; and
- expose owner/workspace summaries to the broker and window-close coordinator.

It does not parse ANSI output, infer shell cwd, or interpret checkpoint bytes.

#### `terminal_registry.rs`

`TerminalRegistry` stores owner-scoped in-memory state. A terminal identity is:

```text
(ownerId, canonicalWorkspaceRoot, terminalId, generation)
```

`terminalId` is an opaque random identifier. `generation` increments every time
a tab starts or restarts a PTY. Commands carrying an old generation cannot
write to, resize, checkpoint, or terminate a replacement process.

Registry state transitions are serialized per owner/workspace:

```text
restored-metadata -> creating -> running -> exited
                         |           |
                         v           v
                       failed <--- closing
```

Every non-closing tab record, including failed and exited tabs, consumes one of
the workspace's five tab slots. `creating`, `running`, and `closing` PTYs consume
the global live-process quota. Create follows reserve/spawn/commit semantics so
simultaneous requests cannot exceed either limit. Failed spawn releases the
global live-process reservation but leaves a visible failed tab record in its
workspace slot so it can be retried or closed.

The registry is partitioned by owner even if two owners refer to the same
canonical path. Terminals are never transferred between native windows.

#### `terminal_output.rs`

Each running terminal has:

- a monotonically increasing `u64` output sequence;
- the latest accepted xterm checkpoint and its watermark;
- a journal of output strictly after that watermark;
- a bounded live-output queue;
- the highest frontend acknowledgement; and
- a `historyGap` flag when continuity can no longer be retained.

The module stores opaque bytes and metadata only. It does not run a terminal
emulator in Rust.

#### `terminal_state_store.rs`

The state store writes a versioned JSON document to the platform application
configuration directory as `terminal-state.json`. Writes use a temporary file
and atomic replacement. Corrupt or unsupported files are quarantined/ignored
with a logged error; they do not block Picot startup.

Persisted state is keyed by canonical workspace root and contains only:

- ordered tab descriptors;
- active tab identifier;
- server-defined shell profile identifier;
- stable display label;
- last expanded panel height; and
- schema version.

It does not contain PTY output, checkpoints, process identifiers, exit output,
environment values, dynamic OSC titles, or last cwd. Automatic OSC titles may
be shown while a process is alive, but only the stable profile-derived display
label is persisted.

The panel always starts collapsed after app restart. On its first expansion,
Picot recreates all persisted tabs as fresh shells rooted at the workspace and
shows a one-time notice that previous processes were not restored. If no
metadata exists, first expansion creates one default-profile tab.

### Broker

`broker_ws.rs` authenticates the client and derives owner/workspace context from
`VerifiedClientContext`. Terminal handlers ignore any owner, cwd, workspace,
port, pid, executable, or arguments supplied by a payload. Remote clients and
clients that have not completed native capability verification receive a
fail-closed authorization error before registry lookup.

Terminal events are delivered only to the current authenticated connection for
the owning native window. They are not broadcast to other native windows or
forwarded upstream to Pi.

### WebView

#### `terminal-panel.js`

Owns panel DOM, tab bar, collapse/expand behavior, horizontal resizer, profile
menu, exit/error/restart states, close confirmations, background activity
presentation, i18n refresh, and destruction.

#### `terminal-client.js`

Owns the broker protocol, request correlation, terminal identity/generation,
sequence validation, acknowledgements, checkpoint submission, reconnect, and
workspace detach/reattach transactions. It does not own visual DOM.

#### `terminal-tab.js`

Owns one xterm instance and its Fit and Serialize addons. It translates xterm
input and size events into client calls, applies snapshots and output bytes,
tracks the last applied sequence, and destroys all xterm listeners/resources
idempotently.

#### `terminal-preferences.js`

Owns display-only preferences that do not determine terminal process identity.
Host state remains authoritative for tab metadata. No process-sensitive state
is written to localStorage or cookies.

`app.js` only constructs these modules and forwards existing workspace and
window-close lifecycle events. Terminal business logic must not be added inline
to `app.js`.

## Broker Protocol

Terminal frames use JSON envelopes on the current broker connection. Raw PTY
input, output, and checkpoint data are Base64 encoded so invalid UTF-8 and
control bytes survive round trips exactly.

Representative client commands are:

```text
terminal_list
terminal_create { profileId }
terminal_input { terminalId, generation, dataBase64 }
terminal_resize { terminalId, generation, cols, rows }
terminal_checkpoint { terminalId, generation, watermark, snapshotBase64 }
terminal_ack { terminalId, generation, sequence }
terminal_close { terminalId, generation }
terminal_restart { terminalId, generation, profileId }
terminal_activate { terminalId, generation }
terminal_reorder { orderedTerminalIds }
terminal_set_panel_height { heightPx }
```

`profileId` is an enum resolved by Rust. There is no arbitrary command profile.
Commands include a request ID and receive one success/error response. Terminal
identity and generation are required for mutating an existing tab.

Representative host events are:

```text
terminal_snapshot
terminal_output
terminal_exited
terminal_failed
terminal_activity
terminal_quota_changed
```

A `terminal_output` event contains terminal identity, generation, first/last
sequence, and `dataBase64`. Output generated in one PTY reader batch remains in
order. Events from different tabs may interleave.

The protocol enforces explicit per-frame limits. Oversized input, resize floods,
invalid Base64, invalid dimensions, stale generations, and unknown profile IDs
return errors without mutating terminal state. Resize dimensions are bounded to
valid PTY `u16` values and a practical configured maximum.

## PTY Spawn Profiles

### Common behavior

- cwd is the owner's canonical current workspace root;
- command and arguments are passed as an executable plus argument array, never a
  shell-concatenated string;
- Picot's existing enhanced PATH is inherited;
- `TERM=xterm-256color` and `COLORTERM=truecolor` are set;
- secrets are not added to logs or protocol events; and
- the initial PTY size comes from FitAddon, with a safe fallback while layout is
  unavailable.

### macOS

The default profile uses the user's absolute `$SHELL` path if it exists, is a
regular executable file, and is an accepted installed shell. Invalid values
fall back to `/bin/zsh`, then `/bin/bash`. The shell starts interactively using
arguments appropriate to the resolved shell without interpolating user text.

### Windows

The default profile is Git Bash. Detection checks, in order:

1. Git for Windows installation data from the registry;
2. the installation root derived from a discovered `git.exe`; and
3. known standard Git for Windows installation directories.

Picot launches Git's `bin/bash.exe` with `--login -i`. It must not launch
`git-bash.exe`, which is intended to create a separate MinTTY window.

If Git Bash is absent, default terminal creation fails visibly with company
installation guidance and a profile chooser. It does not silently substitute
PowerShell. Users may explicitly create or restart a tab with the PowerShell or
Command Prompt profile.

## I/O, Ordering, and Backpressure

### Input

xterm `onData` output is encoded and sent with terminal identity and generation.
Rust verifies ownership and generation before writing bytes. Input has a bounded
per-frame size and is serialized per terminal so concurrent UI actions cannot
reorder writes.

### Output

A dedicated reader task consumes PTY output. Before publication, Rust:

1. increments the terminal's sequence;
2. appends the bytes to the output journal when required for recovery;
3. coalesces output for up to approximately 8–16 ms or 32 KiB; and
4. submits the batch to the terminal-specific broker queue.

The exact timer may be tuned from profiling, but ordering, byte limits, and chat
priority are contractual. The broker never drops Pi control/chat frames. If a
terminal delivery queue saturates, it coalesces pending delivery and asks that
tab to resynchronize from the retained journal rather than silently dropping
bytes. Queue saturation alone does not set `historyGap`; that flag is reserved
for data that exceeded the checkpoint/journal memory bounds and can no longer
be reconstructed.

### Resize

FitAddon computes rows and columns from the visible panel. The frontend sends
only changed dimensions and debounces continuous drag/resize activity by 100 ms,
matching the purpose of Codux's PTY resize debounce. Rust ignores duplicate
sizes. Expansion and tab activation force one immediate fit after the xterm
container has measurable bounds.

## Checkpoints and Reattachment

A terminal screen exists only in xterm.js, so continuity across WebView
navigation uses a checkpoint-plus-journal protocol.

### Checkpoint creation

While attached, the frontend periodically checkpoints a terminal after output
activity. An explicit workspace transition always awaits a final checkpoint
before navigation commit:

1. SerializeAddon serializes the screen and up to 2,000 scrollback lines.
2. The tab captures `lastAppliedSequence` as the checkpoint watermark.
3. The client submits snapshot bytes and watermark.
4. Rust accepts the checkpoint only if owner, generation, and watermark are
   valid, then discards journal data at or below the watermark.
5. Output that races after serialization receives a greater sequence and remains
   in the journal.

A checkpoint is limited to 2 MiB. If 2,000 lines exceed the limit, the frontend
retries with progressively smaller scrollback windows and finally the visible
screen. Rust never parses or executes the snapshot.

### Reattachment

When the owner returns to a workspace:

1. `terminal_list` returns tab descriptors, generations, checkpoints,
   checkpoint watermarks, available journals, and gap state.
2. The tab creates a new xterm instance.
3. It writes the serialized checkpoint first.
4. It applies journal batches only when the next sequence is exactly
   `lastAppliedSequence + 1`.
5. It acknowledges the applied watermark and enters live mode.

Duplicate sequences are ignored. A forward gap pauses normal replay and asks
for a fresh terminal snapshot response; it does not blindly append later bytes.
Because Rust intentionally does not parse ANSI, a gap that exceeded retained
history cannot be reconstructed. In that case the client restores the newest
available state/tail, sets a persistent per-tab warning that some background
output was not retained, and resumes live operation.

Each tab retains at most a 2 MiB checkpoint and 4 MiB of post-checkpoint journal.
The global manager also enforces an aggregate memory bound so 15 noisy terminals
cannot allocate without limit. Hitting either bound sets `historyGap`; it never
terminates the shell automatically.

### Unexpected disconnect

Periodic checkpoints bound data loss if a WebView crashes or reloads without a
clean transition. Broker reconnect must list and reattach existing terminal
generations before permitting create actions, preventing duplicate shells.

## Layout and Visual Contract

The left workspace/session sidebar remains full height. The existing right-hand
workspace becomes a vertical stack:

```text
app-layout
├── workspace/session sidebar
└── workspace
    ├── header
    └── workspace-stack
        ├── workspace-content
        │   ├── chat
        │   ├── optional File Preview
        │   └── File Browser
        ├── terminal horizontal resizer
        └── Terminal Panel
```

The upper `workspace-content` preserves its current horizontal behavior. The
Terminal Panel spans the entire width beneath chat, File Preview, and File
Browser; it never extends under the left sidebar.

### Panel sizing

- collapsed by default;
- expanded default height: 30% of available right-workspace content;
- minimum expanded height: 160 px;
- maximum expanded height: 70%;
- a horizontal separator supports pointer drag and keyboard adjustment;
- the separator exposes `aria-orientation="horizontal"`, current value, and
  min/max values;
- the last height is persisted per workspace; and
- collapsing does not change the saved expanded height.

A native-only Terminal icon in the existing workspace header toggles the panel.
The panel-level close icon also collapses it. Neither action terminates a PTY.

### Tab bar

The reference image establishes a single 36 px tab row:

- the active tab has a rounded highlighted background;
- inactive tabs are flat;
- each tab has a terminal icon and a truncated text label;
- a live dynamic title from xterm `onTitleChange` may replace the visible label
  for the current process but is rendered with `textContent` and is not
  persisted;
- terminal-triggered clipboard reads/writes are disabled; copy and paste require
  an explicit user gesture, and detected links open only through Picot's safe
  native external-link path;
- a close control appears on tab hover/focus;
- middle-click uses the same close action and confirmation as the close control;
- `+` creates a tab using the default profile;
- a compact adjacent profile menu creates Git Bash, PowerShell, or Command
  Prompt tabs where available; and
- the far-right panel `×` only collapses the panel.

Tab labels, order, selected tab, profile, and status survive panel collapse.
Keyboard focus follows ARIA tab-list behavior, including roving tab index.

### Terminal body and states

The active xterm fills all remaining panel space. Non-active xterm instances are
retained but hidden and refit when activated.

Visible states include:

- creating;
- running;
- restoring checkpoint/output;
- exited with exit code when available;
- failed to start with Retry, profile selection, and Close;
- history incomplete due to journal overflow; and
- restarted after Picot relaunch, explicitly stating that the previous process
  was not restored.

All labels, tooltips, errors, and accessible names use Picot i18n. Shell output
and OSC titles are untrusted data and never enter `innerHTML`.

### Background visibility

A workspace row with background live terminals shows a terminal icon and count.
New output while the workspace is detached sets a non-flashing activity dot.
Returning to that workspace and viewing the relevant tab clears its activity
state. The indicator must not expose command output or terminal titles.

LAN/mobile and non-native pages do not render the Terminal toggle, panel, tab
metadata, or activity indicators.

## User Actions and Lifecycle

### First expansion

If no persisted descriptors exist, expanding creates one default terminal. If
persisted descriptors exist after app restart, first expansion recreates them as
fresh shells from workspace root, subject to the five-tab quota. The panel shows
one clear restart notice; it does not replay output from the previous app run.

### Creating tabs

Creation reserves quota before spawning. At five tab records in the workspace,
or fifteen globally live/reserved PTYs, create controls are disabled with an
accessible reason. Failed and exited tabs continue occupying workspace tab slots
until closed, but do not consume the global live-process quota. Picot never
evicts or kills an existing terminal to make room.

### Closing a tab

A live PTY always prompts: closing terminates the shell and its child processes.
Confirmation identifies the tab without rendering untrusted terminal text as
HTML. Cancel leaves the PTY untouched. Confirm transitions the generation to
closing, terminates the process tree, waits for/records exit best-effort, removes
the tab, and releases quota. An already exited or failed tab closes without the
live-process warning.

Closing the final tab leaves an empty panel with a create action. It does not
implicitly create another shell until requested.

### Restarting a tab

Restart increments generation before accepting new input. Late output, exit,
resize, or checkpoint events from the old generation are ignored. Restart uses
the existing profile unless the user explicitly selects another profile and
always starts from workspace root.

### Workspace navigation

Switching Pi sessions in one workspace has no terminal effect. During a
cross-workspace transition:

1. freeze terminal create/close/reorder actions;
2. checkpoint all running visible-workspace tabs;
3. commit the existing host workspace transition;
4. detach the previous workspace UI while its PTYs continue running;
5. attach the destination workspace's registry partition; and
6. unfreeze after snapshot/journal reconciliation.

A cancelled transition restores the prior interactive state. A failed
checkpoint does not silently kill PTYs; it reports reduced recovery confidence
and lets the existing workspace-transition policy decide whether navigation can
continue.

### Window and application close

Terminal Panel registers with the existing `window-close-coordinator` as a
versioned close-risk participant. If any owner terminal is live, the one summary
dialog states how many shells will be terminated. Approval freezes terminal
input, checkpoints no further state, terminates all terminal process trees for
the owner, and only then approves close. Cancel restores interaction.

Window destruction performs final idempotent owner cleanup even if the WebView
did not respond. Application exit calls `kill_all` for every terminal. Cleanup
uses Unix process groups and Windows Job Objects or an equivalent verified
process-tree mechanism so child servers do not survive the owning terminal.

## Security Boundary

Terminal is arbitrary local code execution by design, so native owner
verification is mandatory rather than a UI-only feature flag.

- Only a broker connection authenticated as the current native window owner can
  call terminal commands or receive terminal events.
- Authorization is derived from `VerifiedClientContext`; payload owner,
  workspace, cwd, port, pid, executable, and argument fields are ignored or
  rejected.
- The current canonical workspace root is taken from host-owned window state.
- A tab ID is meaningful only inside its owner/workspace partition.
- `terminalId + generation` prevents stale pages from controlling replacements.
- Remote, LAN, mobile, unverified, and timed-out clients fail closed.
- Shell profiles are fixed host definitions; there is no arbitrary executable
  protocol.
- Input, output, title, exit text, checkpoint bytes, and persisted JSON are
  treated as untrusted and bounded.
- Checkpoints are returned only to the same owner/workspace and are erased on
  owner destruction or app exit.
- Terminal output and snapshots never enter logs, telemetry, instance APIs, Pi
  messages, cookies, localStorage, or on-disk state.
- xterm and addons are bundled as same-origin frontend assets; no CDN or remote
  script is allowed.
- Capability values never enter terminal frames, errors, logs, or persisted
  state.

Codux is GPLv3. Picot may use its architecture as a reference, but this feature
must not copy `codux-terminal-core`, `codux-terminal-pty`, GPUI renderer code, or
other Codux source without a separate explicit licensing decision. Direct
upstream dependencies must have licenses compatible with Picot's distribution
policy and be recorded through the normal dependency review.

## Error Handling

- **Default shell missing:** keep a failed tab, explain the missing profile, and
  offer allowed alternatives.
- **Git Bash missing:** show company installation guidance; do not silently make
  PowerShell the default.
- **PTY spawn failure:** release the live quota reservation, preserve a
  retryable failed tab, and log a sanitized cause.
- **PTY read/write failure:** transition to exited/failed and expose a sanitized
  user-visible error.
- **PTY exits:** preserve output and exit code; offer Restart and Close.
- **Broker disconnect:** disable input, reconnect, list existing generations,
  restore them, and only then re-enable input.
- **Stale generation:** reject it without affecting the current PTY.
- **Invalid or oversized frame:** reject the request without closing unrelated
  terminals or broker clients unless abuse policy requires it.
- **Output journal overflow:** keep the shell running, set `historyGap`, and show
  a persistent incomplete-history warning.
- **Checkpoint too large:** retry with less scrollback, then fall back to the
  visible screen.
- **Corrupt state file:** ignore or quarantine it, start without restored tabs,
  and report a sanitized diagnostic.
- **Partial process-tree termination failure:** keep close pending for bounded
  retries, report failure, and run final owner cleanup.

No path silently swallows an error or reports continuity that cannot be proven.

## Performance and Resource Bounds

- five non-closing tab records per workspace and fifteen live/reserved PTYs
  globally;
- 2 MiB maximum checkpoint per tab;
- 4 MiB maximum post-checkpoint journal per tab;
- an explicit aggregate Terminal memory limit enforced by Rust;
- bounded input/output frames and terminal queues;
- 8–16 ms or 32 KiB output batching target;
- 100 ms resize debounce;
- Pi chat/control broker frames take priority over Terminal output; and
- no automatic process termination solely because output is noisy.

Exact aggregate limits and queue lengths must be constants covered by tests, not
unbounded container defaults.

## Testing and Acceptance Evidence

### Rust unit tests

- owner/workspace partition isolation;
- native versus remote authorization;
- atomic five-tab-per-workspace and fifteen-live-PTY-global quota under
  concurrent creates;
- reserve/spawn/commit rollback;
- terminal generation rejection of stale commands/events;
- sequence ordering, acknowledgement trimming, checkpoint watermark validation,
  journal overflow, and `historyGap`;
- shell-profile resolution and argument-array construction;
- Git Bash registry/path discovery with injected filesystem/registry adapters;
- versioned state serialization, atomic replacement, corrupt-state recovery, and
  prohibition of output/checkpoint fields;
- idempotent close, owner cleanup, and exit watcher behavior; and
- broker scheduling that prioritizes Pi frames over terminal floods.

### Real PTY integration tests

Tests use real local shell processes, not mocked E2E behavior:

- input/output and exit code;
- UTF-8/CJK text and control bytes;
- resize propagation;
- restart generation;
- process-tree termination with a spawned descendant; and
- macOS shell and Windows Git Bash/ConPTY paths on their respective CI runners.

### Frontend tests

- collapsed initial state and lazy first creation;
- reference-image tab-bar DOM contract;
- tab create, activate, reorder, close confirmation, exited close, and restart;
- profile menu availability and Git Bash missing state;
- 30% default height, 160 px minimum, 70% maximum, pointer drag, and keyboard
  resizing;
- panel collapse retaining tab instances;
- strict snapshot-before-journal replay;
- duplicate suppression, sequence-gap pause, overflow warning, reconnect, and
  stale-generation rejection;
- workspace detach/reattach and background activity count;
- restored metadata creating fresh shells from workspace root;
- i18n live switching, untrusted title rendering through `textContent`, ARIA tab
  behavior, focus restoration, and reduced-motion behavior; and
- remote capability absence hiding all terminal DOM.

xterm is wrapped behind a small injectable adapter so jsdom tests assert Picot
behavior rather than xterm internals.

### Real application verification

Because this feature changes visible layout and the browser/host boundary, unit
tests are insufficient. Required release evidence includes:

1. a real Picot browser/Tauri screenshot compared with
   `docs/terminal-panel.jpg` for tab hierarchy and controls;
2. zsh/bash smoke tests on macOS;
3. Git Bash, PowerShell, and Command Prompt smoke tests on Windows;
4. ANSI 16/256/true-color, Unicode/CJK, IME, selection/copy/paste, resize, and
   long-output checks;
5. run a long command, switch workspace, return, and verify checkpoint plus
   background output continuity;
6. force journal overflow and verify the explicit incomplete-output warning;
7. close a tab/window with a descendant server and verify no process remains;
8. verify LAN/mobile clients cannot discover or invoke terminal commands; and
9. flood terminal output while a Pi response streams and verify chat remains
   responsive.

After JS/TS and Rust changes, run:

```text
bun run test
bun run check
bun run check:rust
```

Picot policy forbids using a full Tauri/Cargo build merely as verification.

## Required Architecture Documentation Update

Implementation must update `ARCHITECTURE.md` with:

- the TerminalManager process model;
- the owner-scoped broker Terminal protocol;
- background workspace retention and window-close cleanup;
- checkpoint/journal recovery and its bounded-gap behavior;
- persisted metadata versus intentionally non-persisted output;
- macOS/Windows shell-profile rules; and
- the native-only arbitrary-code-execution security boundary.

The final architecture text must not imply that Terminal traffic passes through
Pi or `embedded-server.ts`.
