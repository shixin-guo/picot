# Canonical `/app` launcher design

- Status: Proposed
- Date: 2026-08-24
- Branch: `feature/app-launcher`

## Problem

The Rust Host serves the SPA document for `/`, `/app`, and deep application URLs, but the browser entry always imports the session application. `public/native/app.js` requires a `/app/workspaces/{workspaceId}/sessions/{sessionId}` route and throws before initializing the sidebar when that route is absent. A browser opened at the bare Host origin therefore remains on static welcome/loading markup.

The previous mobile QR flow deep-linked to the active session and mixed navigation with authorization. Picot now needs a stable bookmark and home-screen entry that is not coupled to one session, while keeping authorization in the explicit device-approval flow.

## Decision

`/app` is the canonical launcher URL. `/` redirects to `/app`.

The launcher renders the existing application shell and session sidebar without selecting or starting a Pi runtime. Its main area tells the user to choose a project or saved session. Selecting a session resolves its project to a stable workspace ID and navigates to the existing canonical session route. Runtime bootstrap remains deferred until that session route loads.

Settings → Remote Access is the only QR entry point. It shows the trusted desktop's plain LAN `/app` launcher URL; scanning navigates to the launcher, and a fresh device requests access there for explicit desktop approval.

## Routes

| Route | Behavior |
| --- | --- |
| `/` | Host redirect to `/app` |
| `/app` | Targetless launcher |
| `/app/workspaces/{workspaceId}/sessions/{sessionId}` | Existing session application |
| `/app/workspaces/{workspaceId}/launcher` | Legacy/incomplete route redirects to `/app` |
| Unknown route | Redirect to `/app`; no reload loop |

`public/bootstrap-entry.js` becomes a small route dispatcher. It imports the launcher module for `/app` and the existing session orchestrator only for session routes. Session-only assumptions remain in `public/native/app.js` instead of being weakened with fake targets or widespread null checks.

## Launcher data contract

The launcher lists saved sessions across Pi's global session store. Projects are derived from each session's `projectPath`, matching the existing sidebar behavior.

A new targetless `list_launcher_sessions` data operation travels over the authenticated `/v2/ws` connection. It returns the same session summary shape and live-runtime annotations as `list_all_sessions`, but no project is marked current.

This first version intentionally means **projects with saved sessions**. Workspaces that have never created a saved session are absent. Although Picot's SQLite metadata contains a `workspaces` table, adding a durable all-workspace catalog and lifecycle policy is deferred until the product needs empty/recent projects.

Launcher catalog reads must not spawn a Pi runtime.

## Navigation

When a launcher session is selected:

1. Send an authenticated Host operation with its saved `projectPath`.
2. Canonicalize and validate that the project directory still exists.
3. Resolve or create its stable workspace ID through the existing `RemoteAuth`/`MetadataStore` authority.
4. Register the workspace root with `HostDataPlane`.
5. Navigate same-origin to `/app/workspaces/{workspaceId}/sessions/{sessionId}` using `appRoutePath()`.
6. Let the existing `/v2/bootstrap` session flow lazily resume the runtime.

Missing or deleted projects remain on the launcher and show an actionable error.

## UI behavior

The launcher reuses `SessionSidebar` and its project grouping, pinned, recent, archived, search, loading, and retry behavior. Launcher composition supplies a targetless session loader and no active session ID.

Session-only controls are not active on the launcher:

- the familiar composer remains visible but all controls are disabled until a session is selected;
- session model/status/file/Git controls are hidden;
- the global new-session button is hidden because there is no current workspace;
- native Open Folder remains available in the desktop shell;
- mobile sidebar toggle, session search, and refresh remain available;
- resource/settings controls that require an active runtime remain hidden.

The main area shows the Picot welcome mark and an instruction to choose a project or session. On narrow screens the sidebar starts collapsed and is opened with the existing sidebar button.

## Remote Access

The session header has no mobile or QR authorization control. Settings → Remote Access displays the automatically detected local-network launcher URL (`http://<LAN-IP>:57620/app`), supports Copy URL, and can show a QR encoding only the plain `/app` URL. The QR never includes a session path, pairing credential, or device token.

A previously authorized browser/PWA may open `/app` directly because the device token is stored for the same origin and port. A fresh unpaired browser or installed PWA requests access from its launcher and waits for explicit approval in desktop Picot; the resulting token is stored in that browser context.

The launcher catalog and workspace resolution use the authenticated WebSocket protocol rather than adding another unauthenticated LAN catalog endpoint. Broader consistency of existing HTTP-route authorization remains a separate security concern.

## PWA entry

`public/manifest.json` uses `/app` as `start_url` and declares `/app` scope. `public/index.html` links the manifest.

No service worker or offline cache is introduced. The launcher is online-only and requires the desktop Host to be running. Secure-context requirements may limit install/service-worker behavior on plain `http://<LAN-IP>` origins; this change only establishes a correct stable application entry.

## Error handling

Unknown routes converge on `/app` without importing the session application. Launcher startup failures must clear the session-swap overlay and render an actionable message.

The existing one-time reload guard remains limited to failures while importing/evaluating a recognized application entry.

## Security boundaries

- Route IDs continue through the existing opaque-ID validation.
- Launcher discovery requires an authenticated WebSocket client on non-loopback hosts.
- Project paths come only from Host-produced session summaries and are re-canonicalized before workspace registration.
- Navigation is built with `appRoutePath()` and remains same-origin.
- Catalog reads do not start runtimes or mutate Pi session files.
- Remote Access QR is launcher navigation only; it does not authorize devices or deep-link to sessions.
- Local-network access remains plain HTTP; installed-PWA HTTPS limitations are explained but not solved here.

## Acceptance criteria

1. Opening the bare Host origin redirects to `/app`.
2. Directly loading or refreshing `/app` renders the project/session sidebar and a launcher welcome state.
3. Launcher loading does not create an additional runtime.
4. Projects with saved sessions are grouped and sorted using current sidebar behavior.
5. Selecting a session from any project reaches its canonical session URL and resumes it normally.
6. A missing project produces a visible error without leaving the launcher.
7. Settings Remote Access shows a stable `/app` URL and QR without a pairing token or session path.
8. A previously authorized browser/PWA can later open `/app` and browse the launcher.
9. An isolated installed PWA can request access, resume a pending request, and transition after desktop approval within its own storage context.
10. `/app/workspaces/{workspaceId}/launcher` converges to `/app`.
11. Unknown routes converge on `/app` instead of reloading and hanging.
12. The manifest launches `/app`.
13. Frontend, Rust, design, and focused route/launcher tests pass.

## Deferred work

- Listing persisted workspaces with zero saved sessions.
- Automatic redirect to the last session; a future launcher may offer an explicit Continue action.
- Offline caching or service-worker support.
- HTTPS/LAN certificate provisioning.
- A repository-wide authorization migration for existing sensitive HTTP endpoints.
