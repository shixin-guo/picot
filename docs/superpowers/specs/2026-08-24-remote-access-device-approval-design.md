# Remote Access device approval design

- Status: Approved for implementation
- Date: 2026-08-24
- Branch: `feature/app-launcher`

## Problem

Picot currently authorizes a new remote browser by embedding a one-time pairing token in a QR/deep link. This works in a normal browser tab, but it is a poor primary flow for an installed PWA:

- iOS may isolate the installed home-screen app's storage from Safari;
- a token exchanged in Safari does not necessarily authorize the installed PWA;
- a remote URL may differ from Picot's advertised LAN URL;
- users must rewrite URLs, copy opaque tokens, or use a terminal to create the correct link.

Remote access must not depend on Tailscale or any other network vendor. Tailscale, WireGuard, a reverse proxy, a tunnel, and a LAN address are transports. Picot owns only application authorization.

## Decision

Adopt a vendor-neutral **Request access → Approve on desktop** flow modeled after OAuth device authorization.

An unpaired browser or installed PWA can create one bounded pending request. The trusted desktop Picot application displays the request and lets the user approve or deny it. The remote requester polls with a proof-of-possession secret. After approval, the Host issues the existing long-lived Picot device token directly into that browser/PWA's own storage context.

No project/session data, runtime operation, file access, or settings operation is available before approval.

The Settings → Remote Access panel is the only QR entry point. It displays the automatically detected local-network launcher URL (`http://<LAN-IP>:57620/app`) and can render a QR encoding only that plain `/app` URL. QR is navigation, never authorization: it contains no session path, pairing credential, or device token. It is no longer required to authorize an installed PWA. Remove the launcher paste-token form and its parsing/helper code, styles, translations, and tests.

## User flow

### Remote browser/PWA

1. Open the stable remote URL, for example `https://host.example/app`.
2. The launcher detects that this origin has no Picot device token.
3. It renders the normal launcher shell plus a primary **Request access** action.
4. On activation, the browser generates a high-entropy claim secret and submits a bounded device label and stable browser device ID.
5. The launcher shows **Waiting for approval in desktop Picot…** and polls only the claim endpoint.
6. On approval, the claim response returns a long-lived device token; the browser stores it under the existing remote-device-token key and reloads `/app`.
7. The ordinary authenticated WebSocket handshake loads projects and sessions.
8. On denial or expiration, the launcher shows an actionable retry state.

### Desktop Picot

1. A feature-owned module periodically checks the Host for pending requests while a native Picot window is visible.
2. A request opens one accessible modal:
   - title: **Remote access request**;
   - bounded, escaped device label;
   - explicit warning that approval grants access to projects, prompts, tools, and files available through Picot;
   - **Deny** and **Approve** controls.
3. Approve or deny is sent to a loopback-only Host endpoint.
4. The modal closes after a terminal response. Duplicate polling windows converge safely if another window already handled the request.

No approval is automatic. No network vendor identity is consulted.

## Protocol

### Create request

`POST /v2/auth/device-requests`

Unauthenticated by necessity, but narrowly scoped and rate/bound protected.

Request:

```json
{
  "deviceId": "device-…",
  "deviceName": "Kevin’s iPhone",
  "claimSecret": "high-entropy requester-held value"
}
```

Response:

```json
{
  "requestId": "request-…",
  "expiresAt": 1787599999,
  "pollAfterMs": 1500
}
```

The Host stores only a hash of `claimSecret`. Repeated creation for the same device replaces or reuses its pending request rather than growing unbounded state.

### Claim request

`POST /v2/auth/device-requests/{requestId}/claim`

Request:

```json
{
  "deviceId": "device-…",
  "claimSecret": "high-entropy requester-held value"
}
```

Outcomes:

- pending: `202` with `{ "status": "pending" }`;
- approved: `200` with `{ "status": "approved", "deviceToken": "…" }`;
- denied: `403` with `{ "status": "denied" }`;
- expired/not found: `410`/`404` with a stable error code.

The long-lived token is generated and persisted only on the first valid claim after approval. The request is then removed so it cannot mint another token.

### Desktop list and decision

- `GET /v2/auth/device-requests` — loopback only;
- `POST /v2/auth/device-requests/{requestId}/approve` — loopback only;
- `POST /v2/auth/device-requests/{requestId}/deny` — loopback only.

The list returns only display-safe metadata: request ID, bounded device name, creation time, and expiration time. It never returns the claim secret or its hash.

## Trust boundary

Desktop approval endpoints must use the TCP peer address, not `Host`, `Origin`, forwarded headers, query parameters, or browser-supplied `clientType`. Axum must receive socket connection information and reject non-loopback peers before reading or mutating approval state.

The public create/claim surface must enforce:

- strict JSON/body size bounds already owned by the Host;
- bounded field lengths and stable identifier syntax;
- cryptographically random requester claim secrets;
- constant-time hash comparison;
- short expiration (five minutes);
- bounded pending-request capacity;
- per-source and/or coarse global creation throttling;
- no project/session data in any response;
- one terminal token issuance per request.

A malicious LAN/tunnel client may create a visible request but gains nothing unless the desktop user explicitly approves it and the requester proves possession of the original secret.

## State ownership

Pending approval requests are ephemeral Host memory. Restarting Picot expires them. Long-lived device tokens continue using the existing `paired_devices` SQLite table through `MetadataStore`; no session/auth authority moves away from the existing store.

The feature should extend `RemoteAuth` rather than create a second token authority.

## Frontend ownership

- `public/native/features/app-launcher.js` owns the unpaired request/wait/retry state.
- A new cohesive module under `public/native/features/` owns desktop pending-request polling and the approval modal.
- `public/native/app.js` remains composition/wiring only.
- Feature CSS lives beside the feature and uses design-system tokens/primitives.
- All user-visible strings exist in every locale.
- No shared-state mutation occurs at import time beyond explicit setup invoked by the composition root.

## Existing code removal

Delete code made obsolete by this flow:

- the launcher paste-pairing form;
- `pairingPathFromInput` and its tests;
- paste-link/token translations and CSS;
- the session-scoped mobile header button, QR modal, `/v2/lan-qr`, and pairing-token URL exchange;
- `RemoteAuth` pairing pending/create/exchange state and WebSocket auth routing;
- documentation instructing users to copy or rewrite pairing links.

Keep:

- existing long-lived device-token storage and WebSocket authentication;
- launcher behavior for already authorized browsers;
- device-request creation, claim, approval, denial, and revocation authority.

Do not retain two primary PWA authorization flows.

## Failure and lifecycle behavior

- Closing/reopening the PWA resumes a still-valid request when requester state exists in that PWA's storage; otherwise it can create a new request.
- Hidden/offline clients back off polling and resume when visible/online.
- Approval after expiration returns a stable already-expired outcome.
- Multiple desktop windows may observe the same request, but approve/deny is idempotent and first terminal decision wins.
- A denied request cannot be approved later; the remote device must create a new request.
- Deleting browser storage or revoking a paired device returns the browser to Request access.

## Validation contract

### Backend

- RemoteAuth unit tests cover create, bounded capacity, expiration, wrong secret, deny, approve, one-time claim, and persisted token authorization.
- Host integration tests prove list/approve/deny reject non-loopback peers and accept loopback peers.
- Create/claim responses contain no project/session data.
- Claiming an approved request authorizes the returned token through the existing verifier.

### Frontend

- Launcher tests cover request creation, waiting state, approved claim/token storage/reload, denial, expiration, retry, and removal of paste-token UI.
- Desktop approval tests cover escaped/bounded device labels, approve, deny, duplicate/already-handled convergence, modal accessibility, and polling cleanup.
- Remote Access settings, remote-auth, session launcher, and PWA manifest tests remain green.
- Trusted desktop Remote Access endpoint tests prove `/app` QR output contains no credential and reject
  remote/bearer callers.

### User-flow validation

1. Clear installed-PWA storage.
2. Open `/app` through any reachable remote origin.
3. Tap Request access.
4. Observe the request in desktop Picot without terminal work.
5. Approve it.
6. Observe the installed PWA automatically transition to the project launcher.
7. Restart Picot and confirm the PWA remains authorized.

### Required commands

```bash
bun run check
bun run test
bun run check:rust
```

## Non-goals

- Configuring Tailscale, tunnels, DNS, TLS, routers, or firewalls.
- Trusting reverse-proxy or vendor identity headers.
- Cloud accounts or centralized Picot identity.
- Internet-public exposure guidance.
- Replacing or weakening the existing long-lived device-token model.
- Automatically approving any remote client.
