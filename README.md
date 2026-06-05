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

## Pi capabilities integrated in Pi Studio

Pi Studio does not re-implement agent logic. It embeds Pi and exposes Pi's runtime capabilities through a desktop UI.

- **Embedded `pi --mode rpc` runtime** — one managed Pi process per workspace, isolated by project
- **Streaming RPC bridge** — token-by-token assistant output, tool-call events, and thinking blocks rendered live
- **Session lifecycle APIs** — create new sessions, switch/resume historical sessions, keep per-project history
- **Model and reasoning controls** — choose model, tune thinking level, and inspect token/context usage
- **Cost and usage telemetry** — session-level cost metrics from Pi's embedded server endpoints
- **Compaction controls** — trigger context compaction and view compaction status in UI
- **Extension compatibility** — keeps loading user extensions from `~/.pi/agent/extensions/` and `.pi/extensions/`
- **Credential reuse** — uses Pi's existing auth/session files under `~/.pi/agent/` without separate login plumbing

## What you can do in the UI

- **Open and run multiple projects** in parallel with separate windows and active agents
- **Chat with Pi visually** using markdown rendering, streaming responses, tool cards, and inline edit diffs
- **Manage sessions efficiently** with history browsing, full-text search, rename, favorites, tags, and quick resume
- **Control model behavior** via model picker, thinking-level toggle, token window visualizer, and cost dashboard
- **Work with project files** through the sidebar tree, native file opening, and drag-to-chat path insertion
- **Send multimodal input** with image attachments and on-device voice dictation
- **Customize workflow and appearance** with message queueing, manual/auto compaction, and built-in themes
- **Operate fully from desktop GUI** (open folder, new session, switch session, stop instance) without terminal commands

## Install
[download from github](https://github.com/shixin-guo/pi-studio/releases)

You **do not** need to install the `pi` CLI separately — Pi Studio bundles its own pi runtime. If you happen to have a different `pi` installed in your shell, the two never interact: Pi Studio's embedded pi reads sessions and credentials from `~/.pi/agent/` but is otherwise isolated.



### macOS unsigned release notice



Pi Studio currently ships macOS builds without Apple Developer ID signing/notarization. Expected Gatekeeper behavior is a block such as:

`"Pi Studio" cannot be opened because the developer cannot be verified.`

Use the standard GUI allow path:

1. Drag `Pi Studio.app` into `/Applications`
2. Right-click the app and choose **Open**
3. If blocked, open **System Settings → Privacy & Security**
4. Click **Open Anyway** for Pi Studio


<img width="299" height="282" alt="image" src="https://github.com/user-attachments/assets/cb09f1f8-9eb8-4c0d-aee0-2fc9b704b201" />

Click **Done**
then： 
<img width="724" height="346" alt="image" src="https://github.com/user-attachments/assets/42ada9ae-b43d-47f1-bf38-ea38c34beb4f" />

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
