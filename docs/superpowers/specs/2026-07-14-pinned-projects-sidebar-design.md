# Pinned Projects Sidebar Design

## Status

The interaction design was approved in conversation with Dr. Lin on 2026-07-14
and revised after an architecture review. This document defines the sidebar
hierarchy, workspace quick info, and Pin behavior. Implementation has not
started.

## Goal

Keep the session sidebar usable as Pi history grows. Show all historical
workspaces without expanding every session list, let users Pin important
workspaces or sessions, and expose useful workspace metadata on demand.

## Scope

The sidebar contains four ordered, foldable regions:

1. `RECENT`
2. `PINNED`
3. `PROJECTS`
4. `ARCHIVED`

`RECENT` keeps its existing meaning and persistence: the five sessions most
recently opened by the user. `PROJECTS` combines Pi session history with current
running instances so a newly opened workspace appears before its first session
is persisted. `PINNED` replaces session Favourites and accepts both workspace and
session Pins. `ARCHIVED` retains its existing independent region.

## Non-goals

- A database or Rust-managed Pin store
- Changing how Pi writes session history
- Removing or redesigning session archive behavior
- Eager Git inspection for every historical workspace
- Persisting new `PINNED` or `PROJECTS` fold state across page reloads; the
  existing persisted `ARCHIVED` fold state remains unchanged

## Sidebar Hierarchy

Every rendered region header is a real button or exposes equivalent button
semantics, `aria-expanded`, and pointer, Enter, and Space activation. Region and
workspace folding changes disclosure only; it never triggers session selection
or quick-info loading.

### RECENT

`RECENT` stays first, keeps at most five sessions, and uses the existing
cross-port MRU cookie. It starts expanded and supports pointer, Enter, and Space
folding. Sessions may also appear in `PINNED` and `PROJECTS`. To preserve current
behavior, the section is omitted when none of its stored entries resolve to a
session.

### PINNED

`PINNED` starts expanded. It groups all entries by workspace.

- A pinned workspace starts expanded and shows all of its non-archived sessions.
- A workspace with only pinned sessions shows only those sessions.
- If both a workspace and one of its sessions are pinned, the workspace Pin wins
  and the session appears once among the workspace's full session list.
- A pinned item remains in `PROJECTS`; duplication across regions is intentional.

Pinned workspace groups remember manual folding during the page lifecycle. A
reload restores the expanded default.

New Pins appear first. Explicitly pinned workspaces follow workspace Pin order.
Session-only workspace groups follow the order of their first pinned session.
An explicitly pinned workspace shows sessions in the timestamp order supplied by
its project; a session-only group follows session Pin order.

The `PINNED` header always renders. When expanded without Pins, it shows a short,
localized empty-state hint. An unresolved Pin remains visible as an unavailable
row with an Unpin action; refresh never silently removes it.

### PROJECTS

`PROJECTS` starts expanded. It merges `/api/sessions` projects with live
`/api/instances` entries by normalized workspace path. A running workspace that
has no persisted session appears with a zero count. When its first session is
written, the history project replaces the provisional live entry without moving
or duplicating the workspace row. If the user closes a zero-session workspace
before sending a prompt, it disappears because neither Pi history nor a running
instance records it; this design does not add a separate workspace registry.

Each workspace starts folded, showing only its folder name and non-archived
session count. Expanding a workspace reveals its sessions. Manual workspace fold
state survives sidebar rerenders during the page lifecycle; a reload restores
the folded default. A history workspace remains visible with a zero count when
all of its sessions are Archived; those sessions remain available only in
`ARCHIVED`.

Provisional-to-history reconciliation transfers the workspace's page-lifetime
fold state and current quick-info target to the history ID. It must not collapse
an expanded group or close a card merely because the stable ID became available.

Workspace order follows most-recent activity: the newest session timestamp for a
history project and `startedAt` for a live-only workspace. A stable workspace ID
breaks ties. Replacing a provisional live entry with its first history project
preserves the existing row position for that render, preventing a visible jump.

The existing incremental session disclosure remains available inside an expanded
workspace when its session count exceeds the configured initial limit.

If the merged history and running-instance model contains no workspaces, the
sidebar keeps the existing localized Open Project empty state instead of
rendering an empty `PROJECTS` header. The always-visible `PINNED` region remains
above that empty state.

### ARCHIVED

`ARCHIVED` remains last and preserves its existing persisted fold state; first
use starts folded. Archived sessions appear only in this region. Archiving an
individually pinned session removes that session Pin. When a pinned workspace
contains an archived session, the workspace stays pinned but omits that session.
Unarchiving restores the session under the pinned workspace. The section is
omitted when there are no archived sessions, preserving current behavior.

## Pin Interactions

Hovering or focusing a session row exposes Pin/Unpin and Archive buttons. A
pinned session keeps its Pin affordance visible. The existing context menu also
offers Pin/Unpin, but it is not the only entry point.

Workspace quick info contains the workspace Pin/Unpin button. The control updates
the cookie and all duplicate workspace or session renderings immediately.

Pin actions never open, switch, or create a session. Fold actions never count as
session access and therefore never modify `RECENT`.

## Pin Persistence

Picot stores Pin state in a cookie shared by all `localhost` workspace ports:

```json
{
  "v": 1,
  "workspaces": [
    {
      "id": "history:<pi-session-directory-name>",
      "path": "/absolute/workspace/path"
    }
  ],
  "sessions": ["/absolute/session/file.jsonl"]
}
```

Workspace identity and display path are separate:

- A history project uses `history:<dirName>`, where `dirName` is the stable Pi
  session-directory name returned by `/api/sessions`.
- A zero-session running workspace uses `path:<normalized-absolute-path>` as a
  provisional ID.
- When a history project later resolves to the same normalized path, the Pin
  store replaces the provisional ID with the history ID without changing its
  position.
- Path comparison resolves `.` and `..` segments and repeated or trailing path
  separators, but conservatively preserves case and does not resolve symlinks.
  Differently spelled symlink paths therefore remain separate in the first
  version. `path` retains the original display spelling.

`public/pinned-items.js` owns parsing, normalization, migration, and writes. It:

- accepts only valid workspace records and non-empty session identifiers;
- removes duplicates while preserving order;
- percent-encodes the JSON value;
- uses `Path=/`, `SameSite=Lax`, and the same long lifetime as `RECENT`;
- keeps the encoded cookie at or below 3,800 bytes; and
- reads the newest cookie value immediately before each mutation.

Unlike an MRU list, Pins never evict older items. If a new Pin would exceed the
limit, the module rejects the mutation, preserves the existing cookie, and
returns a typed capacity error for localized UI feedback.

The cookie uses last-write-wins semantics. Two windows that mutate Pins at the
same instant may lose one intermediate update, matching the accepted `RECENT`
trade-off. The next action reads and rewrites a valid state.

Cookie sharing does not produce browser events. `pinned-items.js` compares the
serialized cookie on window focus, on `visibilitychange`, before each sidebar
render, and once per second while the document is visible. It dispatches a Pin
state event only when the value changes. The sidebar preserves its scroll and
fold state while applying that event. This gives local Picot windows
near-real-time convergence without a database or broker message.

Pin state is scoped to the desktop WebView's `localhost` browser profile. LAN or
remote browsers use a different cookie origin and do not share desktop Pins.

On first load in each origin, the module performs a best-effort migration of the
`pi-studio-favourites` localStorage value visible to that origin. Browser
security prevents one port from enumerating localStorage owned by past ports, so
the design does not claim a complete global migration. A successful merge marks
only the current origin as migrated. A capacity failure preserves the old value,
includes those legacy sessions in that origin's in-memory `PINNED` rendering,
and shows a localized warning. It retries after a later Unpin frees space. It
never silently discards or hides a saved session.

An incomplete `/api/sessions` response never mutates Pin persistence. A Pin that
does not resolve remains stored and renders as unavailable with an explicit
Unpin action. Only an explicit Unpin, a successful Picot session deletion, or the
archive action for an individually pinned session removes a Pin. This rule
prevents transient filesystem and JSONL parsing failures from destroying user
state.

## Workspace Quick Info

Hovering or focusing a workspace header opens a card that remains open while the
pointer moves between the header and card. The card positions itself beside the
sidebar and clamps itself to the viewport. Pointer opening uses a 120-millisecond
hover-intent delay, cancelled on leave; keyboard focus opens it immediately.
Escape closes a keyboard-opened card and returns focus to its workspace header
when focus was inside the card.

The first row contains the folder icon and folder name, with the Pin/Unpin icon
button aligned at the far right as shown in the prototype. The button exposes a
localized accessible name and `aria-pressed` state.

The card uses the prototype's compact visual structure:

1. folder icon, folder name, and Pin/Unpin control;
2. conversation icon with the localized total-thread count, including Archived
   sessions;
3. folder icon with the full workspace path; and
4. after a separator, a Git-branch icon with the remote repository name when
   Git metadata provides one.

The card never shows visible field labels, repository type, current branch, or
detached HEAD state. The metadata endpoint may still return those fields for
server-side classification and future explicit product requirements, but the
first version's compact card renders only the repository name. This exactly
matches the approved prototype.

Each `PROJECTS` workspace-header count remains the non-archived count. Quick info
labels its count as total through the localized count text so the two values
cannot be mistaken for the same metric.

For a non-Git workspace, the card omits the Git row and retains the folder,
count, path, and Pin control. A Git error degrades in the same way and never
disables Pinning.

The frontend caches positive and negative Git results by workspace path for 30
seconds. A request sequence or abort mechanism prevents a response for an old
hover target from replacing the current card.

The card treats folder names, paths, repositories, branches, and API errors as
untrusted text. It creates text nodes or assigns `textContent` and DOM
properties; it never interpolates those values into `innerHTML`. Tests use paths,
remotes, and branch labels containing HTML metacharacters to enforce this rule.

The reusable `PINNED` and `PROJECTS` workspace-group renderer applies the same
rule to folder names, paths, session titles, tooltips, and accessible labels.

## Workspace Metadata API

The embedded server adds `GET /api/workspace-info?workspaceId=<encoded-id>`.
`URLSearchParams` encodes and decodes the ID. The server resolves
`history:<dirName>` through the current Pi session-directory list and resolves a
provisional `path:<normalized-absolute-path>` only when the path matches a
running instance. It rejects arbitrary filesystem paths and unknown IDs.

The route uses `execFile`-style argument arrays and never invokes a shell. The
whole metadata request has a 3-second deadline, and each Git command inherits
the remaining time and has a 64-KiB output limit. Commands set
`GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`; they perform no network
operation. The route collects repository root, remote URL, branch, Git directory,
and common Git directory, then derives repository/worktree status. It returns
structured JSON:

```json
{
  "isGit": true,
  "repository": "owner/repository",
  "kind": "worktree",
  "branch": "feature/sidebar",
  "detachedAt": null
}
```

Repository-name parsing supports HTTPS URLs, `ssh://` URLs, and SCP-style SSH
remotes such as `git@github.com:owner/repository.git`. It strips a trailing
`.git`. The route prefers `origin`; without `origin`, it selects the first remote
in lexical order. Unsupported remote formats and repositories without remotes
fall back to the repository-root folder name.

On detached HEAD, `branch` is `null` and `detachedAt` contains the short commit
SHA. The API retains those values for Git classification, but the compact
quick-info card deliberately omits branch and detached-HEAD rows.

Non-Git workspaces return `isGit: false` with a successful HTTP response. Unknown
workspace identifiers return a client error. Unexpected Git or filesystem
failures return a bounded error without command output, environment details, or
unrelated paths.

Closing or replacing a quick-info card cancels its frontend request. The route
MUST support the standard Fetch `AbortSignal` supplied by Bun's adapter; Node
EventEmitter lifecycle events are optional compatibility behavior, never a
requirement of the adapter contract. Closing a request aborts the active Git
child; the overall deadline is the fallback. Rapid traversal therefore does not
accumulate abandoned Git processes.

The route stays separate from `/api/sessions`. Listing many workspaces must not
spawn Git processes or delay the main session response.

## Module Boundary

- `public/pinned-items.js` owns the Pin cookie and Favourites migration.
- `public/workspace-projects.js` owns workspace identity normalization and the
  pure merge of session-history projects with running instances.
- `public/workspace-quick-info.js` owns card lifecycle, metadata loading, caching,
  focus, and pointer transitions.
- `public/sidebar-workspace-group.js` builds the reusable workspace/session group
  used by `PINNED` and `PROJECTS`.
- `public/session-sidebar.js` composes the four regions, preserves fold state,
  and relays Pin actions. It does not absorb the new identity, persistence,
  quick-info, or workspace-group rendering logic.
- `extensions/embedded-server.ts` exposes only the restricted metadata route.
- `public/app.js` wires modules and existing callbacks; it contains no Pin store,
  quick-info rendering, or Git parsing logic.

The implementation updates `ARCHITECTURE.md` with the Pin cookie, metadata route,
module ownership, and security boundary.

## Internationalization

Every Picot-authored string uses `t(...)` or the existing `data-i18n` attributes.
Both `public/locales/en.json` and `public/locales/zh.json` receive matching keys.
Required concepts include:

- Pinned and Projects region titles;
- Pin workspace, Unpin workspace, Pin session, and Unpin session;
- Repository and Worktree types;
- detached HEAD;
- session-count forms;
- loading Git information;
- Pin capacity failure;
- empty Pinned section;
- unavailable pinned workspace and session;
- partial Favourites migration;
- quick-info accessibility labels; and
- workspace metadata failure when user-visible feedback is necessary.

The UI interpolates counts through the i18n layer. It never builds English
phrases by concatenating translated fragments. Folder names, repository names,
branches, session titles, and paths remain verbatim. Locale changes update open
quick-info cards, section headers, tooltips, and action labels without resetting
fold state or Pin state.

## Search

Sidebar search applies to all four regions. It matches session titles and
workspace names. Matching a session under a folded `PROJECTS` workspace reveals
the matching row for the duration of the search without changing the stored fold
state. Clearing search restores the user's prior fold state.

Duplicate session rows keep active, unread, streaming, archived, and Pin states
synchronized by session file path.

## Error Handling

- Malformed Pin cookies load as an empty normalized state and remain recoverable.
- Cookie read or write failures leave the last in-memory state usable and show a
  localized error only after a user action fails.
- Pin capacity errors preserve all previous Pins.
- Missing projects and sessions remain unresolved Pins; refresh never deletes
  them.
- Quick-info Git failures preserve basic workspace information and Pin actions.
- Stale quick-info responses never update a newer target.
- A `/api/sessions` failure preserves the last committed sidebar model and
  exposes the existing retry path.
- A `/api/instances` failure still commits fresh history data. It retains
  previously known provisional live workspaces until a successful instance
  response confirms they have stopped; on first load, it simply has no
  provisional entries.

## Verification

Pin-store tests cover malformed input, normalization, deduplication, mixed
workspace/session Pins, exact capacity rejection, no eviction, concurrent-style
read-before-write behavior, cross-window refresh events, provisional-to-history
workspace migration, unresolved Pin retention, and safe current-origin
Favourites migration.

Sidebar tests cover:

1. region order and fold controls;
2. unchanged five-item `RECENT` behavior;
3. folded `PROJECTS` workspaces by default;
4. zero-session running workspaces, all-Archived history workspaces, activity
   ordering, and first-session reconciliation;
5. expanded pinned workspaces and the empty Pinned state;
6. Pin ordering, pinned-session grouping, and workspace-level deduplication;
7. unresolved Pin rows and explicit cleanup;
8. Archived exclusion, persisted Archived folding, and archive-triggered Unpin;
9. duplicate active, unread, streaming, and Pin state;
10. session and workspace Pin controls plus inert rendering of HTML-like labels;
11. search revealing matches without changing fold state; and
12. English and Chinese key parity and live locale updates.

Quick-info and extension tests use temporary real Git repositories and linked
worktrees. They cover remote parsing, missing remotes, branches, worktree
detection, detached HEAD, timeouts, output bounds, non-Git directories,
unknown-ID rejection, inert rendering of HTML-like metadata, cached failures,
stale responses, hover intent, viewport clamping, focus, Escape, and an open
card surviving a Pin-triggered sidebar rerender. Route tests exercise both the
Node EventEmitter path and the Bun Fetch-adapter `AbortSignal` path, including an
already-aborted request.

Final verification runs focused Vitest files, `bun run test`, and `bun run check`.
Manual verification covers light and dark themes, long workspace lists, large
session groups, cross-window Pin updates, a full-cookie failure, narrow desktop
windows, popup boundaries, keyboard operation, and live locale switching. When a
prototype image defines the popup, capture the real card and compare its visible
rows, icons, separators, labels, truncation, and Pin state against that image.
