# RECENT Sessions Design

## Goal

Add a RECENT section to the left session sidebar. It shows the five sessions the user most recently opened across Picot workspace windows in the same browser profile.

## Scope

The section tracks user access, not session activity. A session enters RECENT only after Picot activates it. The history persists in a cookie shared by Picot's localhost workspace ports, survives restarts, and requires no Rust, broker-control, or embedded-server changes.

## Architecture

RECENT uses a cookie because workspace windows run on distinct `http://localhost:<port>` origins. Browser `localStorage` is partitioned by origin, but a cookie set with `Path=/` on `localhost` is shared across those ports. This matches the existing theme and language preference pattern.

### Persistent state

The browser stores an ordered JSON array under the new cookie key `picot-recent-sessions`:

```json
[
  "/absolute/path/to/session-a.jsonl",
  "/absolute/path/to/session-b.jsonl"
]
```

The serialized JSON is percent-encoded as the cookie value and written with `Max-Age` of ten years, `Path=/`, and `SameSite=Lax`. The first value is the most recently accessed session. The cookie stores no display data, timestamps, or project metadata. The sidebar always resolves a path from the current `/api/sessions` response.

The dedicated `recent-sessions.js` module owns cookie parsing, normalization, and persistence. It treats a missing, malformed, non-array, or non-string value as an empty history. It removes empty and duplicate paths, preserving first occurrence order, and retains at most five values.

Cookie values have a practical size limit. Before writing, the module omits any path that cannot fit by itself, then removes the oldest remaining values until the encoded cookie value is at most 3,800 bytes. This bound leaves room for the cookie name and attributes under common 4 KiB cookie limits.
Cookie reads and writes use the existing theme module's `try`/`catch` fallback pattern. A write failure leaves the current in-memory order intact and does not block sidebar rendering.

Cookie updates are synchronous and last-write-wins. Concurrent activity in two workspace windows can lose an intermediate MRU ordering update; the next access rewrites a valid five-entry list. This trade-off is intentional for a small navigation preference and avoids a new host-side persistence subsystem.

Each browser profile keeps its own RECENT cookie. A remote browser's session access does not alter the desktop WebView's RECENT list.

### Recording access

`SessionSidebar` imports the dedicated recent-session module and owns the in-memory RECENT order. `SessionSidebar.setActive(filePath)` remains the only recording entry point:

1. Ignore an empty path.
2. Call the module's synchronous record helper, which reads the latest cookie, de-duplicates the path, prepends it, caps the list, and writes only when the cookie value changes.
3. Replace the in-memory RECENT order with that returned list and re-render the RECENT group when it changes.

This keeps persistence in one sidebar method without coupling the sidebar to the WebSocket transport or requiring caller-managed record calls.

The caller invokes `setActive()` for every successful session selection. On startup, `handleMirrorSync()` calls `sidebar.setActive(data.sessionFile)` immediately after it assigns `mirrorActiveSessionFile` in the foreground branch. The existing early return for a background `mirror_sync` remains before that call, so background agents never pollute RECENT. Existing new-session refresh behavior continues to call the same method after Pi persists the first session message.

### Validation and pruning

After `loadSessions()` receives the current projects, the sidebar validates the in-memory RECENT paths against the global `/api/sessions` result. It removes paths that no longer exist or are archived, then persists the filtered result through the cookie module when it changed. This removes entries after a user deletes a `.jsonl`, archives it, or changes the session list in another workspace window.

Unarchiving does not restore an entry. The user must open the session again.

## Rendering and interaction

The sidebar renders RECENT before Favourites and project groups when at least one resolved, non-archived recent session exists.

- Header text uses `t("sidebar.recent")`: `Recent` in English and `最近访问` in Chinese.
- The group uses a dedicated `.recent-group` container and existing sidebar session-item styles.
- The group has no count, expand/collapse control, or extra actions.
- To preserve access order, the sidebar iterates the stored RECENT paths. For each path, it finds the matching `{ session, project }` pair in `this.projects`; unresolved paths are skipped.
- Each item is built through `buildSessionItem(session, project)` and invokes the existing `onSessionSelect(session, project)` callback.

A session can appear in RECENT, Favourites, and its project group simultaneously. This duplication is intentional: each group serves a distinct navigation purpose. Existing status application updates every duplicate by `filePath`, so active, unread, and streaming state remain synchronized.

Because RECENT reuses the normal session item and selection callback, it keeps current title and relative-time formatting, archive control, active state, unread status, streaming state, cross-project routing, session mirroring, and mobile-sidebar behavior.

## Search

RECENT participates in the sidebar title and project-name search. `applySearch()` applies the same item filtering and group visibility logic to `.recent-group` as it applies to `.favourites-group`. When no RECENT item matches, it hides the whole group. Clearing the query restores the group when it has resolved items and does not modify its access order.

## Tests

Cookie-module tests cover:

1. Missing, malformed, non-array, and non-string cookie values load as an empty history.
2. Recording de-duplicates paths, promotes the latest path, caps history at five, and skips a write when nothing changes.
3. Writing trims the oldest paths to stay within the encoded cookie-size bound.
4. A single oversized path is not persisted.

Frontend tests cover:

1. A selected session records through `setActive()` and appears at the start of RECENT.
2. Re-selecting a session de-duplicates it and promotes it to the first position.
3. The sixth distinct selection removes the oldest entry.
4. RECENT preserves cookie order across projects within one browser profile and dispatches the original session/project pair.
5. The foreground `handleMirrorSync()` branch records the restored live session; background sync does not.
6. Deleted and archived persisted entries do not render after validation.
7. Active, unread, and streaming classes apply to every duplicate session item.
8. Search hides nonmatching RECENT items and hides the group when none match.
9. English and Chinese translations expose `sidebar.recent`.

Run the focused Vitest tests, `bun run check`, and the required i18n safety grep on changed frontend files.