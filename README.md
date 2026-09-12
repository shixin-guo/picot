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

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.ps1 | iex
```

The Linux installer picks a `.deb` or `.rpm` for your package manager. On distros with
neither — or to install per-user without `sudo` — add `--appimage` to get the AppImage in
`~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/shixin-guo/picot/main/scripts/install.sh | bash -s -- --appimage
```

Or [download from GitHub Releases](https://github.com/shixin-guo/picot/releases).

You **do not** need to install the `pi` CLI separately — Picot bundles its own pi runtime.

---

## Quick Start

1. Launch **Picot**
2. Click a project bubble or pick a folder
3. Start chatting — the embedded pi agent starts automatically

Provide your model credentials via `pi /login` inside any workspace, or by writing `~/.pi/agent/auth.json` directly. Picot doesn't manage credentials itself. The interface is available in English and Chinese.

---

## Features


<p align="center">
  <img width="1200" alt="Picot workspace and project UI" src="docs/images/workspace.webp" />
</p>

---

### 💬 Chat

<p align="center">
  <img width="1200" alt="Chat with tool-call cards and thinking blocks" src="docs/images/chat.webp" />
</p>

- Full markdown rendering with syntax-highlighted code blocks
- **Streaming responses** with live typing indicator (powered by remend)
- Image attachments — paste, drag & drop, or button
- Inline **diff viewer** for edit tool calls (red/green lines)
- Tool-call cards and **thinking blocks** rendered live, each with its own token cost
- Copy any message with one click
- Scroll-to-bottom button with unread indicator
- **Message queuing** — type while the agent is working; messages queue as pills and auto-send when ready
- **Conversation turn navigator** — Codex-style dot rail beside the chat; hover a dot for a preview, click to jump to that turn
- **Command palette** — quick access to Compact, Expand/Collapse All Tools, Settings, and Help
- **Fork from any message** — branch a new session off any point in the conversation

**`@` file mentions** — type `@` in any composer to search and insert a file-path reference (workspace, `../`, `~/`, or absolute):

<p align="center">
  <img width="1200" alt="@ file mention menu in the composer" src="docs/images/composer-mentions.webp" />
</p>

---

### 🗂️ Multi-Session & Multi-Agent

<p align="center">
  <img width="1200" alt="Session sidebar with projects, RECENT, and workspace actions" src="docs/images/sessions.webp" />
</p>

- **Multiple agents in parallel** — each session spawns its own headless pi process; no new OS window, no interruption of running sessions
- Browse and resume any past session from the sidebar
- Sessions sorted by creation time; live session marked with a green dot
- Inline session rename, favourites, tags, and filtering
- **Safe individual deletion** — delete a session from the sidebar or ARCHIVED; running sessions are refused by the server
- **RECENT** — a cross-workspace, most-recently-used list keeps the last five visited sessions at the top of the sidebar

> 🛣️ **Planned:** subagent/team support — spawning agent teams from the UI, visual grouping in the sidebar, and live-switching between agents. Tracked in [`ROADMAP.md`](./ROADMAP.md).

**Full-text search** across all session history, with highlighted snippets (`⌘K`):

<p align="center">
  <img width="1200" alt="Full-text session search with highlighted snippets" src="docs/images/session-search.webp" />
</p>

---

### 📥 Agent Inbox <sub>(Beta)</sub>

<p align="center">
  <img width="1200" alt="Agent Inbox settings with the Telegram Doctor check" src="docs/images/agent-inbox-settings.webp" />
</p>

- Connect a Telegram bot — incoming DMs land in a pinned **Agent Inbox** session, kept separate from your normal project chats
- Dispatch tasks from the inbox to any open project's agent; track pending / running / done in a resizable task panel
- Task lifecycle events (dispatched, needs input, done, failed) round-trip back to the inbox, including a reply to the original Telegram sender
- Built-in **Telegram Doctor** check to diagnose bot/token/connectivity issues from Settings

---

### 🗃️ Projects & Workspace

<p align="center">
  <img width="1200" alt="Project header with git branch and the open-in-editor menu" src="docs/images/workspace-open-in.webp" />
</p>

- **Multi-project** — each project gets its own window, working directory, session history, and agent
- Shows the **current git branch** in the project header
- **Open in external editor** — launch VS Code, Cursor, Zed, Ghostty, a terminal, or Finder directly from Picot
- Native folder picker to open any project without touching the terminal

---

### 🗄️ File Browser, Preview & Editor

<p align="center">
  <img width="1200" alt="Chat, Markdown preview, and the workspace file tree side by side" src="docs/images/file-browser.webp" />
</p>

- Right sidebar with a lazy-loaded workspace file tree
- Click a file to open it in a resizable, tabbed preview panel; tabs are restored separately for each workspace
- Preview Markdown, images, PDF documents, and source files; Markdown is sanitized before rendering
- Double-click to open a file in its native desktop application
- Drag a file from the tree onto the chat input to insert a workspace-relative `@path` reference

**Built-in CodeMirror editor** with syntax highlighting, line wrapping, search, go-to-line, auto-save, and external-change conflict protection:

<p align="center">
  <img width="1200" alt="Tabbed CodeMirror editor next to the chat" src="docs/images/code-editor.webp" />
</p>

---

### 🔀 Git Changes & Diffs

<p align="center">
  <img width="1200" alt="Git changes panel with a side-by-side diff" src="docs/images/git-diff.webp" />
</p>

- Git panel grouped into **staged / changes / untracked / conflicted**, with per-directory counts
- Side-by-side **original vs. modified** diff in the same preview panel used for files
- Stage or discard changes from the panel
- Branch and ahead/behind status in the header

---

### ⌨️ Built-in Terminal

<p align="center">
  <img width="1200" alt="Integrated terminal panel below the chat" src="docs/images/terminal.webp" />
</p>

- Real xterm.js terminal rooted at the workspace directory (``Ctrl+` ``)
- Multiple tabs, resizable panel, and restore-on-reopen
- Runs alongside the chat — no window switching to check a build

---

### 📱 Mobile & LAN Access

<p align="center">
  <img width="900" alt="LAN and mobile access panel" src="docs/images/lan-mobile-panel.webp" />
</p>
<p align="center">
  <img width="360" alt="Picot on mobile" src="docs/images/mobile.webp" />
</p>

- **Settings → Remote Access** — scan the plain `/app` launcher URL on the same network; new devices request access and require desktop approval
- Mobile-optimised URL handling and App Launcher support (installable as PWA on iOS/Android)

---

### 📦 Package Manager

<p align="center">
  <img width="1200" alt="Built-in package manager UI" src="docs/images/package-manager.webp" />
</p>

- Browse, install, and remove community packages from within the UI
- Built on top of `pi install` — no separate package commands needed

---

### 💰 Cost & Usage Dashboard

<p align="center">
  <img width="1200" alt="Cost dashboard overview" src="docs/images/cost-dashboard.webp" />
</p>
<p align="center">
  <img width="1200" alt="Per-model and trend breakdown" src="docs/images/cost-breakdown.webp" />
</p>

- Per-session cost tracking with live token/cost metrics
- Full cost dashboard with infobar, trends, and per-model breakdown

**Context window visualiser** — click the token pill to see cached tokens, fresh input, and available space, and compact from there:

<p align="center">
  <img width="1200" alt="Context window popover showing input, output, available, and cached tokens" src="docs/images/context-window.webp" />
</p>

---

### 🎨 Themes & Appearance

<p align="center">
  <img width="1200" alt="Picot in the Midnight theme" src="docs/images/theme-midnight.webp" />
</p>

- Six built-in themes: **Dusk** (default), Dawn, Midnight, Clean, Terracotta, Sage
- Frosted-glass header and input bar (`backdrop-filter: blur`)
- Native macOS title bar overlay integration
- **Window dragging** from the header area — feels like a native app
- **Language** — switch the live interface between English, Simplified Chinese, or the system preference

<p align="center">
  <img width="1200" alt="Settings → General with theme swatches, agent options, and updates" src="docs/images/settings-general.webp" />
</p>

---

### 🎤 Voice Input

<p align="center">
  <img width="1000" alt="Composer with attach, model picker, thinking toggle, mic, and send" src="docs/images/composer.webp" />
</p>

- Mic button in the input area using Web Speech API (on-device dictation)
- Live transcription into the textarea; pulses red while recording

---

### ⚙️ Settings & Control

<p align="center">
  <img width="1200" alt="Model picker with search and context sizes" src="docs/images/model-picker.webp" />
</p>

- Model picker with search/filter and keyboard support
- Thinking level toggle (off / low / medium / high)
- Auto and manual **context compaction** with status display
- Push notification toggle
- **Skills management** — Settings → Skills: browse every discovered skill per source root and toggle individual skills or whole groups using Pi's `!`/`+`/`-` rule semantics (takes effect on next session/restart)
- **Auto-updater** — Settings → General → Updates for one-click in-app updates

<p align="center">
  <img width="1200" alt="Settings and controls" src="docs/images/settings.webp" />
</p>

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
