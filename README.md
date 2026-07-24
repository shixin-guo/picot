# Picot （π-cot(e)）

**English** | [中文](./README.zh.md)

A local desktop GUI for the [Pi](https://github.com/badlogic/pi-mono) coding agent. No cloud, no account — runs entirely on your machine.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/shixin-guo/picot?include_prereleases&label=release)](https://github.com/shixin-guo/picot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#install)

Picot ships a known-good build of the `pi` runtime **inside the .app bundle**, so there's no separate `pi` install to manage, no PATH shenanigans, and no version drift between Picot and the agent it talks to. Open any project folder, start chatting with the agent, browse sessions and files — no terminal required. Multiple projects run in parallel, each in its own window with its own isolated agent process.

<p align="center">
  <img width="1200" alt="Picot hero" src="docs/images/hero.webp" />
</p>

---

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Features](#features)
- [For Developers](#for-developers)
- [Upstream](#upstream)
- [License](#license)

---

## Install

You **do not** need to install the `pi` CLI separately — Picot bundles its own pi runtime.

### One-liner install (recommended)

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1 | iex
```

The script auto-detects your OS and architecture, downloads the right package, installs it, and on macOS automatically clears the Gatekeeper quarantine bit — so the app opens directly without any "Open Anyway" prompt.

To install a specific version:
```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash -s -- --version v0.3.0

# Windows — enterprise MSI deployment
& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1'))) -Version v0.3.0 -MSI
```

### Manual download

[Download from GitHub Releases](https://github.com/shixin-guo/picot/releases)

| Platform | File |
|----------|------|
| macOS Apple Silicon | `Picot_*_aarch64.dmg` |
| macOS Intel | `Picot_*_x64.dmg` |
| Linux x86\_64 (Debian/Ubuntu) | `Picot_*_amd64.deb` |
| Linux arm64 (Debian/Ubuntu) | `Picot_*_arm64.deb` |
| Linux x86\_64 (RHEL/Fedora) | `Picot-*-1.x86_64.rpm` |
| Linux arm64 (RHEL/Fedora) | `Picot-*-1.aarch64.rpm` |
| Windows x64 | `Picot_*_x64-setup.exe` |
| Windows arm64 | `Picot_*_arm64-setup.exe` |

### macOS unsigned release notice

Picot currently ships macOS builds without Apple Developer ID signing/notarization.
The one-liner install script handles this automatically. If you install manually:

1. Drag `Picot.app` into `/Applications`
2. Right-click → **Open**
3. If blocked: **System Settings → Privacy & Security → Open Anyway**

<p align="center">
  <img width="420" alt="macOS Gatekeeper warning" src="docs/images/gatekeeper-warning.webp" />
</p>

Then click **Done**:

<p align="center">
  <img width="960" alt="Allow app in macOS security settings" src="docs/images/gatekeeper-allow.webp" />
</p>

---

## Quick Start

1. Launch **Picot**
2. Click a project bubble or pick a folder
3. Start chatting — the embedded pi agent starts automatically

Provide your model credentials via `pi /login` inside any workspace, or by writing `~/.pi/agent/auth.json` directly. Picot doesn't manage credentials itself.

---

## Features

### 📸 UI Preview

<p align="center">
  <img width="1200" alt="Picot workspace and project UI" src="docs/images/workspace.webp" />
</p>

<details>
<summary><strong>💬 Chat</strong></summary>

- Full markdown rendering with syntax-highlighted code blocks
- **Streaming responses** with live typing indicator (powered by remend)
- Image attachments — paste, drag & drop, or button
- Inline **diff viewer** for edit tool calls (red/green lines)
- Tool-call cards and **thinking blocks** rendered live
- Copy any message with one click
- Scroll-to-bottom button with unread indicator
- **Message queuing** — type while the agent is working; messages queue as pills and auto-send when ready
- **Conversation turn navigator** — Codex-style dot rail beside the chat; hover a dot for a preview, click to jump to that turn
- **Command palette** — quick access to Compact, Expand/Collapse All Tools, Settings, and Help
- **Fork from any message** — branch a new session off any point in the conversation

</details>

<details>
<summary><strong>🗂️ Multi-Session & Multi-Agent</strong></summary>

- **Multiple agents in parallel** — each session spawns its own headless pi process; no new OS window, no interruption of running sessions
- Browse and resume any past session from the sidebar
- Full-text search across all session history with highlighted snippets
- Sessions sorted by creation time; live session marked with a green dot
- Inline session rename, favourites, tags, and filtering

</details>

<details>
<summary><strong>📥 Agent Inbox</strong> <sub>(Beta)</sub></summary>

- Connect a Telegram bot — incoming DMs land in a pinned **Agent Inbox** session, kept separate from your normal project chats
- Dispatch tasks from the inbox to any open project's agent; track pending / running / done in a resizable task panel
- Task lifecycle events (dispatched, needs input, done, failed) round-trip back to the inbox, including a reply to the original Telegram sender
- Built-in Telegram Doctor check to diagnose bot/token/connectivity issues from Settings

</details>

<details>
<summary><strong>🗃️ Projects & Workspace</strong></summary>

- **Multi-project** — each project gets its own window, working directory, session history, and agent
- Shows the **current git branch** in the project header
- **Open in external editor** — launch VS Code, Cursor, or any app directly from Picot
- Native folder picker to open any project without touching the terminal

</details>

<details>
<summary><strong>📱 Mobile & LAN Access</strong></summary>

<p align="center">
  <img width="900" alt="LAN and mobile access panel" src="docs/images/lan-mobile-panel.webp" />
</p>
<p align="center">
  <img width="360" alt="Picot on mobile" src="docs/images/mobile.webp" />
</p>

- **LAN QR code** — scan to open Picot on any device on the same network
- Mobile-optimised URL handling and App Launcher support (installable as PWA on iOS/Android)

</details>

<details>
<summary><strong>📦 Package Manager</strong></summary>

<p align="center">
  <img width="1200" alt="Built-in package manager UI" src="docs/images/package-manager.webp" />
</p>

- Browse, install, and remove community packages from within the UI
- Built on top of `pi install` — no separate package commands needed

</details>

<details>
<summary><strong>💰 Cost & Usage Dashboard</strong></summary>

<p align="center">
  <img width="1200" alt="Cost dashboard overview" src="docs/images/cost-dashboard.webp" />
</p>
<p align="center">
  <img width="1200" alt="Per-model and trend breakdown" src="docs/images/cost-breakdown.webp" />
</p>

- Per-session cost tracking with live token/cost metrics
- Full cost dashboard with infobar, trends, and per-model breakdown
- **Context window visualiser** — click the token pill to see cached tokens, fresh input, and available space

</details>

<details>
<summary><strong>🎨 Themes & Appearance</strong></summary>

- Six built-in themes: **Dusk** (default), Dawn, Midnight, Clean, Terracotta, Sage
- Frosted-glass header and input bar (`backdrop-filter: blur`)
- Native macOS title bar overlay integration
- **Window dragging** from the header area — feels like a native app

</details>

<details>
<summary><strong>🎤 Voice Input</strong></summary>

- Mic button in the input area using Web Speech API (on-device dictation)
- Live transcription into the textarea; pulses red while recording

</details>

<details>
<summary><strong>🗄️ File Browser</strong></summary>

- Right sidebar with lazy-loaded file tree
- Navigate directories, open files natively
- Drag files onto the input to insert their path

</details>

<details>
<summary><strong>⚙️ Settings & Control</strong></summary>

<p align="center">
  <img width="1200" alt="Settings and controls" src="docs/images/settings.webp" />
</p>

- Model picker with search/filter and keyboard support
- Thinking level toggle (off / low / medium / high)
- Auto and manual **context compaction** with status display
- Push notification toggle
- **Auto-updater** — Settings → General → Updates for one-click in-app updates

</details>

---

## For Developers

### Architecture

Picot starts a Rust `HostServer` and a managed native `pi --mode rpc` process. The WebView talks to `/v2/ws` on the host, and the host bridges those frames to Pi over stdio RPC. The bundled `picot-bridge.mjs` extension provides Picot-specific Pi commands; it does not serve the app UI.

```
┌──────────────────────────────────────────────────────┐
│ Picot .app                                       │
│                                                      │
│   Tauri + native HostServer (Rust)                   │
│      ├─► spawn  pi --mode rpc --extension picot-bridge.mjs │
│      ├─► bridge stdio RPC frames over /v2/ws         │
│      └─► OS Window ──► WebView ──► native host HTTP  │
│                                                      │
│   resources/                                         │
│      ├─ public/             (frontend)               │
│      ├─ extensions/         (picot-bridge.mjs)       │
│      └─ pi/                 (bun-compiled pi binary) │
└──────────────────────────────────────────────────────┘
                       │
                       ▼ reads / writes
              ~/.pi/agent/
                 ├─ sessions/   (chat history)
                 ├─ auth.json   (API keys)
                 └─ settings.json
```

> This diagram is a public-facing summary. The source-of-truth version — kept in sync with this one — lives in [`AGENTS.md`](./AGENTS.md#architecture), which also covers goals, constraints, and per-module conventions for anyone contributing code.

### Pi capabilities integrated

Picot does not re-implement agent logic — it embeds Pi and exposes its runtime capabilities through a native UI.

- **Embedded `pi --mode rpc` runtime** — one managed process per workspace, isolated by project
- **Streaming RPC bridge** — token-by-token output, tool-call events, and thinking blocks rendered live
- **Session lifecycle APIs** — create, switch, and resume sessions; full per-project history
- **Native host server** — Rust owns the HTTP/WebSocket surface and bridges browser frames to Pi RPC
- **Extension compatibility** — user extensions from `~/.pi/agent/extensions/` and `.pi/extensions/` are auto-loaded
- **Credential reuse** — reads Pi's existing `~/.pi/agent/auth.json`; no separate login needed

### Build from source

```bash
git clone https://github.com/shixin-guo/picot.git
cd picot
bun install --frozen-lockfile
bun run dev      # fetch embedded pi binary + start tauri dev with hot reload
```

To make a release build:

```bash
bun run build    # downloads embedded pi binary, then runs tauri build
```

For the full command reference (tests, lint/format, Rust checks, bumping the embedded pi version), see [`AGENTS.md` → Common commands](./AGENTS.md#common-commands).

### Project docs

- [`AGENTS.md`](./AGENTS.md) — architecture, module conventions, and the full command reference for anyone (human or agent) working in this repo
- [`ROADMAP.md`](./ROADMAP.md) — shipped, in-progress, and planned features
- [`docs/adr/`](./docs/adr/) — architecture decision records
- [`docs/DESIGN.md`](./docs/DESIGN.md) — design tokens and UI primitives

---

## Upstream

Picot is a maintained fork of **Tau**, adapted for Pi-first, local development workflows. Key additions:

- **Native Pi runtime manager** — spawns and supervises `pi --mode rpc` processes
- **Embedded pi runtime** — no separate global install; Picot ships its own binary
- **Protocol v2 host bridge** — typed routing for runtime, data, auth, and extension UI frames
- **Host data plane** — Rust serves session and workspace data directly to the native UI

---

## License

MIT
