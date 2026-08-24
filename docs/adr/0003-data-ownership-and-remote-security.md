# ADR 0003: Separate Picot metadata and use device approval authorization

- Status: Accepted
- Date: 2026-07-14

## Context

Picot needs stable UI identity and remote-client authorization without taking ownership of Pi sessions,
credentials, settings, or project trust. The approved release retains LAN access without transport
encryption.

## Decision

SQLite stores only Picot metadata: workspace IDs, UI preferences, suspension policy, schema version,
and paired-device token hashes. Pi continues to own session JSONL, `AuthStorage`, settings files, and
`trust.json`. Losing or resetting the Picot database cannot mutate Pi sessions or workspace files.

Project Trust is a blocking, default-deny startup gate before project resources execute. Current-session
settings use native RPC; project and global defaults atomically merge into Pi settings while preserving
unknown keys.

Remote authorization uses an explicit Request access → Approve on desktop flow. Pending requests are
short-lived proof-of-possession claims, and desktop approval endpoints are loopback-only. Only the hash
of the resulting revocable long-term device token is persisted. QR is navigation only: Settings exposes
the trusted desktop's plain LAN `/app` launcher URL and a QR encoding that URL, never a credential,
session path, or pairing secret. A device that completes authorization is trusted to the same degree as
the desktop app: as of 2026-08, the Host router no longer distinguishes
`ClientKind::Remote` from `ClientKind::Desktop` for authorization purposes, so a paired mobile/LAN
client has parity with desktop for Host operations (folder picking, app launching, package and Pi
package changes, updates, workspace deletion, `/picot-config`) and for local Git operations. The
`ClientKind` distinction is retained only for identity/telemetry, not for gating.

The LAN transport remains unencrypted for this release. The product must display an explicit warning
that prompts and source may be observable on the network.

Workspace file browsing, source preview, Git status, and per-file Git diff are read-only Host data
operations. Their HTTP endpoints require a registered workspace ID, accept only workspace-relative
paths, and resolve those paths through the same containment checks used by file preview. Git commands
run in the registered workspace and never accept an arbitrary working directory from the browser.

Office and email preview is also Host-owned. For an allowlisted suffix, the Rust Host reads a
canonical workspace-contained regular file with a 32 MiB input cap and streams those bytes to an
optional local Python 3.10+ MarkItDown process using fixed arguments and a scrubbed environment.
Converted output is capped at 2 MiB, diagnostics at 256 KiB, execution at 20 seconds, and concurrency
at two conversions per Host. Source paths, credentials, plugins, cloud integrations, and shell
interpolation are never passed to the converter. Converted Markdown remains untrusted and is rendered
with the frontend's converted-document sanitizer and remote-image blocking policy.

## Consequences

- Import, sharing, encrypted transport, session indexing/FTS, and arbitrary TUI rendering remain
  deferred.
- Authorization is enforced by the Host route family, not by hiding frontend controls.
- Credentials, claim secrets, prompt content, and command content must not appear in diagnostics.
- There is one authorization model: Request access → Approve on desktop. Legacy pairing creation and
  exchange routes are removed; persisted device tokens remain valid and revocable.
