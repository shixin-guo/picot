# Picot Roadmap

Ideas and planned features. Nothing here is committed — just captured so it doesn't get lost.

---

## ✅ Done

### Rebrand: Pi Studio → Picot
Renamed from Tau → Pi Studio → Picot. Own icon, README, and install scripts (`scripts/install.sh` / `install.ps1`) with one-liner install from GitHub Releases. npm publishing plan was dropped in favour of the Releases + install-script flow.

### Cost & Usage Dashboard
Per-session token/cost tracking with live metrics. Full dashboard (`public/cost.js`, `cost-infobar.js`, `native/cost-dashboard.js`) with infobar stats, per-model breakdown chart, per-project breakdown, and trend view. Context window visualiser (below) is the companion per-turn view.

### Quick Actions on Tool Results
Copy-output button on every tool card. Expand All / Collapse All wired into the Command Palette (`⌘`-button → Expand All Tools / Collapse All Tools). Re-run command was dropped — not pursued.

### Command Palette
`⌘`-button opens a command palette (`native/command-palette.js`) with Compact, Expand/Collapse All Tools, Settings, and Help. Extensible via `commandCatalog`.

### Conversation Turn Navigator
Codex-style dot rail (`ui/conv-nav.js`) alongside the chat — one dot per turn, hover shows a preview, click jumps to that point in the conversation.

### Agent Inbox (bundled multi-agent dispatch)
Ships as part of Picot, not a separate extension. Telegram bot integration (`components/chat-settings-panel.js`) routes incoming messages into a pinned "Agent Inbox" session; tasks can be dispatched to any open project's agent (`super-agent/dispatch.js`, `super-agent/task-state.js`) with a resizable task panel (pending/running/done, `components/super-agent-runtime.js`). Currently in Beta — see settings tab badge.

### PWA / Install to Home Screen
Service worker, manifest, custom icons. Installable on iOS/Android/macOS as a standalone app.

### Full-Text Session Search
Search across all historical sessions by message content, not just titles. Debounced API search with highlighted snippets in the sidebar.

### Context Window Visualiser
Click the token usage pill to see a breakdown of cached tokens, fresh input, and available space. Stacked bar with legend.

### File Browser
Right sidebar with lazy-loaded file tree. Navigate directories, double-click to open files natively (macOS `open`), drag files onto the input to insert their path. Filters out `node_modules`, `.git`, etc.

### Custom Model Picker
Styled dropdown with search/filter, keyboard support, frosted glass menu. Replaces native `<select>`.

### Compaction Support
Manual compact command broadcasts start/end events to Picot. Shows compaction status in the conversation.

### Voice Input
Mic button inside the input bubble. Uses Web Speech API (on-device dictation). Live transcription into the textarea. Pulses red while recording. Hidden if browser doesn't support it.

### Diff Viewer
Edit tool cards render a proper inline diff with red/green lines instead of raw JSON args. Works for both live and history cards.

### Message Queuing
Input stays enabled while the agent is working. Queued messages appear as pills above the input with cancel buttons. Auto-sends in order when the agent finishes. Just like the TUI.

### Image Previews in Chat
Sent images now display inline in user message bubbles. Works for both new messages and session history.

### Six Themes
Dusk (clean neutral dark, default), Dawn (warm blue dark), Midnight (OLED black), Clean (Apple-style light with cyan-blue accents), Terracotta (warm light), Sage (warm olive-green light). Theme picker shows colour palette dots. All shadows flattened — no more clay.

### Frosted Header & Footer
Both header and input area are `position: absolute` with `backdrop-filter: blur(40px) saturate(1.5)`. Messages scroll behind both for the frosted glass effect.

### Settings Panel
Theme picker, auto-compaction toggle, thinking level, show/hide thinking blocks, push notification toggle.

---

## 🔨 In Progress

### Conversation Fork/Branch Visualisation
Partially there: a per-message "fork" button already forks a new session from any point (`ui/message-renderer.js` → `messagefork` event → RPC `fork`), and `native/session-tree.js` has a working `get_tree` / `navigate` client against Pi's tree RPC. Still missing: an actual visual tree UI — the `tree` command-catalog builtin currently just dispatches a `picot:open-tree` event with no listener wired up yet.

---

## 🔜 Low-Hanging Fruit

_(nothing queued right now — see Bigger Ideas below)_

---

## 🔮 Bigger Ideas

### File Preview Panel
Context-aware split pane that displays files the agent is working on.

- Code → syntax highlighted viewer (Monaco/CodeMirror)
- Images → preview (PNG, SVG, generated images)
- HTML → live iframe preview, hot reloads as agent edits
- Markdown → rendered preview

Desktop: button collapses sidebar and shrinks conversation to narrow feed, preview panel takes 60-70%. Mobile: tap a file reference to open full-screen preview.

Builds on the file browser — could auto-show preview when a file gets edited.

### Session Templates
Start a new session pre-loaded with context for a specific project. Each with its own CLAUDE.md, working directory, and maybe a starter prompt.

### Multi-Model A/B Testing
Send the same prompt to two models side by side and compare responses. Split view with both responses streaming.

### Live Terminal Embed
Embedded terminal panel (xterm.js) showing real-time bash output from Pi's tool executions. Would need pi-core to expose a PTY stream through the extension API — currently bash tool runs one-shot commands, not a persistent shell. Read-only output display is possible now but limited value over existing tool cards.

### memoryd Dashboard
Standalone viewer for memoryd memory files. Was previously built into Picot, stripped out to keep the core lean. The viewer code is saved at `~/Desktop/memoryd-viewer/`. Now being integrated into the native macOS memoryd menu bar app.
