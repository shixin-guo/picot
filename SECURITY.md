# Security Policy

## Supported versions

Picot ships rolling releases (see [Releases](https://github.com/shixin-guo/picot/releases)).
Only the latest released version is supported with security fixes; there are
no maintained LTS branches at this stage.

## Reporting a vulnerability

Please do **not** open a public GitHub issue for security vulnerabilities.

Instead, report it privately using
[GitHub Security Advisories](https://github.com/shixin-guo/picot/security/advisories/new)
for this repository. If that is not available to you, contact the maintainer
directly through their GitHub profile (`@shixin-guo`).

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is very helpful)
- The Picot version and platform (macOS/Linux/Windows) you tested on

We aim to acknowledge reports within a few days and will work with you on a
fix and coordinated disclosure timeline.

## Scope

Picot is a local desktop GUI that embeds the `pi` coding agent runtime and
manages:

- Local process supervision of `pi --mode rpc`
- A native HTTP/WebSocket host bridging the WebView UI to Pi's RPC protocol
- Credentials read from `~/.pi/agent/auth.json` (Picot does not itself manage
  or transmit credentials to any third party beyond what the user's
  configured model provider requires)
- Auto-update via the Tauri updater, verified against a signed manifest

Reports involving any of the above — e.g. local privilege escalation via the
native host, RPC bridge request smuggling, unsafe extension loading, or
update-signature bypass — are all in scope.

Reports about the upstream `pi` agent itself should go to the
[pi-mono repository](https://github.com/earendil-works/pi-mono) instead.

## Out of scope

- Vulnerabilities that require physical access to an already-unlocked
  machine running Picot
- Issues in third-party dependencies without a demonstrated impact on Picot
  (please report those upstream; we track dependency updates via Dependabot)
