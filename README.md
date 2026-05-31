# Pi Studio

A local Codex-style desktop app for the [Pi](https://github.com/badlogic/pi-mono) coding agent. No cloud, no account — runs entirely on your machine.

Pi Studio ships a known-good build of the `pi` runtime **inside the .app bundle**, so there's no separate `pi` install to manage, no PATH shenanigans, and no version drift between Pi Studio and the agent it talks to.

## Upstream and fork status

Pi Studio is a maintained fork of **Tau**, adapted for Pi-first, local development workflows. It keeps Tau's local-first coding-agent UI philosophy and extends it with stronger multi-project desktop behavior and a smoother Pi-specific experience.

Key additions in this fork:

- **Tauri-native process manager** (`PiManager`) that runs one `pi --mode rpc` process per project window
- **Embedded pi runtime** — no separate `npm i -g @earendil-works/pi-coding-agent` step; Pi Studio ships its own pi binary
- **Pi-focused UX refinements** across chat streaming, session history, model/thinking controls, and file workflows

![Pi Studio dark mode](docs/images/dark.png)

![Pi Studio terracotta theme](docs/images/terracotta.png)

## What it does

Pi Studio gives you a full visual interface for Pi. Open any project, chat with the agent, browse sessions and files — all from a native desktop app. Multiple projects run in parallel, each in its own window with its own agent.

- **Multi-project** — each project gets its own window, working directory, session history, and running agent
- **Live chat** — streaming responses, tool-call cards, thinking blocks, inline diffs
- **Session browser** — view and resume any past session, full-text search across history
- **File browser** — lazy-loaded file tree, drag files into the chat
- **No terminal required** — launch, switch, and manage agents entirely from the GUI

## Install

Download the latest release for macOS from the [releases page](https://github.com/deflating/pi-studio/releases).

You **do not** need to install the `pi` CLI separately — Pi Studio bundles its own pi runtime. If you happen to have a different `pi` installed in your shell, the two never interact: Pi Studio's embedded pi reads sessions and credentials from `~/.pi/agent/` but is otherwise isolated.

### macOS unsigned release notice

Pi Studio currently ships macOS builds without Apple Developer ID signing/notarization. Expected Gatekeeper behavior is a block such as:

`"Pi Studio" cannot be opened because the developer cannot be verified.`

Use the standard GUI allow path:

1. Drag `Pi Studio.app` into `/Applications`
2. Right-click the app and choose **Open**
3. If blocked, open **System Settings → Privacy & Security**
4. Click **Open Anyway** for Pi Studio

For maintainers: publish the generated `.dmg` artifact directly and avoid modifying `.app` contents after bundling. The release helper script `bun run release:mac:dmg` validates this (rejects ad-hoc and broken signatures).

### Build from source

```bash
git clone https://github.com/deflating/pi-studio.git
cd pi-studio
bun install --frozen-lockfile
bun run build   # downloads the embedded pi binary, then runs `tauri build`
```

## Usage

1. Launch **Pi Studio**
2. Click a project bubble to open it (or pick a folder)
3. Start chatting — the embedded pi agent starts automatically in that workspace

Provide your model credentials once via `pi /login` inside any workspace, or by writing `~/.pi/agent/auth.json` directly. Pi Studio doesn't manage credentials itself — it reuses whatever pi has on disk.

## Features

### Chat
- Full markdown rendering with syntax-highlighted code blocks
- Streaming responses with typing indicator
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls (red/green lines)
- Scroll-to-bottom button with new message indicator
- Message queuing — type while the agent is working, messages queue and auto-send

### Session Management
- Browse all past sessions grouped by project
- Full-text search across all session history with highlighted snippets
- Sorted by last modified (most recent first)
- Live session marked with a green dot
- Historical sessions are read-only
- Inline session rename
- Favourite sessions, tags, and filtering

### Model & Thinking
- Model picker with search/filter and keyboard support
- Thinking level toggle (off/low/medium/high)
- Token usage percentage with context window visualiser
- Cost tracking per session

### Voice Input
- Mic button in the input area using Web Speech API (on-device dictation)
- Live transcription into the textarea
- Pulses red while recording

### File Browser
- Right sidebar with lazy-loaded file tree
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### Compaction
- Manual context compaction with status display
- Auto-compaction support

### Themes
Six built-in themes: Dusk, Dawn, Midnight, Clean, Terracotta, Sage.

## How it works

```
┌──────────────────────────────────────────────────────┐
│ Pi Studio .app                                       │
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
                 ├─ sessions/   (chat history, shared)
                 ├─ auth.json   (API keys, shared)
                 └─ settings.json
```

The embedded pi process loads `embedded-server.mjs` at startup. That extension owns the HTTP + WebSocket surface the Tauri WebView talks to: static assets, `/api/sessions`, `/api/cost-dashboard`, RPC bridge for prompts, etc. Pi Studio's Rust side controls process lifecycle, port allocation, and window management.

Your own `~/.pi/agent/extensions/` and project-local `.pi/extensions/` are still auto-loaded by the embedded pi — embedding doesn't disable user extensions.

## Development

```bash
git clone https://github.com/deflating/pi-studio.git
cd pi-studio
bun install --frozen-lockfile
bun run dev
```

`bun run dev` will:

1. Run `bun run fetch:pi` to populate `src-tauri/resources/pi/` with the locked pi binary (see `scripts/pi-version.json`).
2. Start `tauri dev` against the local `public/` for instant frontend reload.

To bump the embedded pi version, edit `scripts/pi-version.json`, run `bun run fetch:pi`, smoke-test, and commit.

After changes under `src-tauri/`:

```bash
bun run check:rust   # cargo check + clippy + fmt
```

(per project policy, `tauri build` is not used for routine verification — it's reserved for actual releases.)

## License

MIT
