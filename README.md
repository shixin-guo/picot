# Picot （π-cot(e)）

**English** | [中文](./README.zh.md)

A local desktop GUI for the [Pi](https://github.com/badlogic/pi-mono) coding agent. No cloud, no account — runs entirely on your machine.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Latest release](https://img.shields.io/github/v/release/shixin-guo/picot?include_prereleases&label=release)](https://github.com/shixin-guo/picot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#install)

Picot ships a known-good build of the `pi` runtime **inside the .app bundle**, so there's no separate `pi` install to manage, no PATH shenanigans, and no version drift between Picot and the agent it talks to.

<p align="center">
  <img width="1200" alt="Picot hero" src="docs/images/hero.webp" />
</p>



---

## Install

[Download from GitHub Releases](https://github.com/shixin-guo/picot/releases)

You **do not** need to install the `pi` CLI separately — Picot bundles its own pi runtime.

### macOS unsigned release notice

Picot currently ships macOS builds without Apple Developer ID signing/notarization. Expected Gatekeeper behavior:

`"Picot" cannot be opened because the developer cannot be verified.`

**To allow it:**

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

## What it does

Picot gives you a full visual interface for Pi. Open any project folder, start chatting with the agent, browse sessions and files — no terminal required. Multiple projects run in parallel, each in its own window with its own isolated agent process.

---

## Features

### 📸 UI Preview

<p align="center">
  <img width="1200" alt="Picot workspace and project UI" src="docs/images/workspace.webp" />
</p>

### 💬 Chat

- Full markdown rendering with syntax-highlighted code blocks
- **Streaming responses** with live typing indicator (powered by remend)
- Image attachments — paste, drag & drop, or button
- Inline **diff viewer** for edit tool calls (red/green lines)
- Tool-call cards and **thinking blocks** rendered live
- Copy any message with one click
- Scroll-to-bottom button with unread indicator
- **Message queuing** — type while the agent is working; messages queue as pills and auto-send when ready

### 🗂️ Multi-Session & Multi-Agent

- **Multiple agents in parallel** — each session spawns its own headless pi process; no new OS window, no interruption of running sessions
- Browse and resume any past session from the sidebar
- Full-text search across all session history with highlighted snippets
- Sessions sorted by creation time; live session marked with a green dot
- Inline session rename, favourites, tags, and filtering

### 🗃️ Projects & Workspace

- **Multi-project** — each project gets its own window, working directory, session history, and agent
- Shows the **current git branch** in the project header
- **Open in external editor** — launch VS Code, Cursor, or any app directly from Picot
- Native folder picker to open any project without touching the terminal

### 📱 Mobile & LAN Access
<p align="center">
  <img width="900" alt="LAN and mobile access panel" src="docs/images/lan-mobile-panel.webp" />
</p>
<p align="center">
  <img width="360" alt="Picot on mobile" src="docs/images/mobile.webp" />
</p>


- **LAN QR code** — scan to open Picot on any device on the same network
- Mobile-optimised URL handling and App Launcher support (installable as PWA on iOS/Android)

### 📦 Package Manager
<p align="center">
  <img width="1200" alt="Built-in package manager UI" src="docs/images/package-manager.webp" />
</p>


- Browse, install, and remove community packages from within the UI
- Built on top of `pi install` — no separate package commands needed

### 💰 Cost & Usage Dashboard

<p align="center">
  <img width="1200" alt="Cost dashboard overview" src="docs/images/cost-dashboard.webp" />
</p>
<p align="center">
  <img width="1200" alt="Per-model and trend breakdown" src="docs/images/cost-breakdown.webp" />
</p>


- Per-session cost tracking with live token/cost metrics
- Full cost dashboard with infobar, trends, and per-model breakdown
- **Context window visualiser** — click the token pill to see cached tokens, fresh input, and available space

### 🎨 Themes & Appearance

- Six built-in themes: **Dusk**, Dawn, Midnight, Clean, Terracotta, Sage
- Frosted-glass header and input bar (`backdrop-filter: blur`)
- Native macOS title bar overlay integration
- **Window dragging** from the header area — feels like a native app

### 🎤 Voice Input

- Mic button in the input area using Web Speech API (on-device dictation)
- Live transcription into the textarea; pulses red while recording

### 🗄️ File Browser

- Right sidebar with lazy-loaded file tree
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### ⚙️ Settings & Control
<p align="center">
  <img width="1200" alt="Settings and controls" src="docs/images/settings.webp" />
</p>


- Model picker with search/filter and keyboard support
- Thinking level toggle (off / low / medium / high)
- Auto and manual **context compaction** with status display
- Push notification toggle
- **Auto-updater** — Settings → General → Updates for one-click in-app updates

---

## Pi capabilities integrated

Picot does not re-implement agent logic — it embeds Pi and exposes its runtime capabilities through a native UI.

- **Embedded `pi --mode rpc` runtime** — one managed process per workspace, isolated by project
- **Streaming RPC bridge** — token-by-token output, tool-call events, and thinking blocks rendered live
- **Session lifecycle APIs** — create, switch, and resume sessions; full per-project history
- **WebSocket broker** — multiple UI clients can connect to the same pi process simultaneously
- **Extension compatibility** — user extensions from `~/.pi/agent/extensions/` and `.pi/extensions/` are auto-loaded
- **Credential reuse** — reads Pi's existing `~/.pi/agent/auth.json`; no separate login needed

---

## How it works

```
┌──────────────────────────────────────────────────────┐
│ Picot .app                                       │
│                                                      │
│   Tauri + PiManager (Rust)                           │
│      ├─► spawn  pi --mode rpc  (project A, :3001)    │
│      ├─► spawn  pi --mode rpc  (project B, :3002)    │
│      └─► OS Window per project ──► WebView ──► HTTP  │
│                                                      │
│   resources/                                         │
│      ├─ public/             (frontend)               │
│      ├─ extensions/         (embedded-server.mjs)    │
│      └─ pi/                 (bun-compiled pi binary) │
└──────────────────────────────────────────────────────┘
                       │
                       ▼ reads / writes
              ~/.pi/agent/
                 ├─ sessions/   (chat history)
                 ├─ auth.json   (API keys)
                 └─ settings.json
```

The embedded pi process loads `embedded-server.mjs` at startup. That extension owns the HTTP + WebSocket surface the Tauri WebView talks to: static assets, `/api/sessions`, `/api/cost-dashboard`, RPC bridge for prompts, etc. Picot's Rust side controls process lifecycle, port allocation, and window management.

---

## Usage

1. Launch **Picot**
2. Click a project bubble or pick a folder
3. Start chatting — the embedded pi agent starts automatically

Provide your model credentials via `pi /login` inside any workspace, or by writing `~/.pi/agent/auth.json` directly. Picot doesn't manage credentials itself.

---

## Build from source

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

After any changes under `src-tauri/`:

```bash
bun run check:rust   # cargo check + clippy + fmt (fast; no full build needed)
```

To bump the embedded pi version, edit `scripts/pi-version.json`, run `bun run fetch:pi`, smoke-test, and commit.

---

## Upstream

Picot is a maintained fork of **Tau**, adapted for Pi-first, local development workflows. Key additions:

- **Tauri-native PiManager** — spawns one `pi --mode rpc` process per project window
- **Embedded pi runtime** — no separate global install; Picot ships its own binary
- **Multi-session without new windows** — headless pi processes, current WebView navigates
- **LAN + mobile access** — QR code, PWA support, WebSocket broker for multi-client

---

## License

MIT
