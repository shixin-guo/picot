# ADR 0001: Use one Rust Host and native Pi RPC

- Status: Accepted
- Date: 2026-07-14

## Context

Picot currently starts an HTTP/WebSocket server inside every Pi process and splits runtime behavior
between that extension, a Rust broker, and browser HTTP calls. Ports consequently act as process,
session, and navigation identity, while Pi's authoritative RPC responses are discarded.

## Decision

One Rust Host owns the application HTTP/WebSocket origin, client authorization, routing, local read
models, and process lifecycle. Every embedded Pi 0.80.7 process runs in RPC mode and communicates only
through strict LF-delimited JSONL on stdin/stdout. A `PiRpcBridge` correlates responses and classifies
runtime events and extension UI requests. Pi processes do not bind TCP ports.

Protocol v2 is an atomic replacement. It has no v1 translation, cross-port navigation, active-port
fallback, or silent downgrade. Native Pi RPC is authoritative. A bundled extension may expose only
namespaced `picot.*` adapters for Pi-owned behavior absent from RPC.

## Consequences

- Local WebViews and authorized remote clients share one origin and one protocol.
- Runtime feature code cannot depend on paths, ports, subprocess frames, or per-process HTTP routes.
- The legacy embedded server and duplicate runtime handlers must be deleted at cutover.
- Development may select legacy or native startup, but a Pi process can never run both paths.
