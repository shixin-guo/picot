# ADR 0003: Separate Picot metadata and use QR device authorization

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

Remote pairing is QR-only. A single-use pairing token expires after five minutes and exchanges for a
revocable long-term device token; only its hash is persisted. Remote clients may use approved runtime
operations but cannot invoke folder picking, app launching, package changes, updates, workspace
deletion, or other dangerous Host operations.

The LAN transport remains unencrypted for this release. The product must display an explicit warning
that prompts and source may be observable on the network.

## Consequences

- Import, sharing, encrypted transport, session indexing/FTS, and arbitrary TUI rendering remain
  deferred.
- Authorization is enforced by the Host route family, not by hiding frontend controls.
- Credentials, pairing secrets, prompt content, and command content must not appear in diagnostics.
