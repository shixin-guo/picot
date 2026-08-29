# Extension Command / Custom UI Parity: pi-web vs Picot

Comparison of how the two web-facing hosts talk to the same underlying protocol
(`pi --mode rpc`, defined in `pi-mono/packages/coding-agent/src/modes/rpc/`) and
why Picot currently loses a class of extension functionality that pi-web
supports.

## 1. How the two hosts attach to the RPC protocol

| | **pi-web** | **Picot** |
|---|---|---|
| Runtime | Embeds `@earendil-works/pi-coding-agent` **in-process** via the SDK (`createAgentSessionFromServices`, `AgentSessionWrapper` in `lib/rpc-manager.ts`) | Spawns the real `pi` binary as a **subprocess** with `--mode rpc` (`src-tauri/src/native_pi_manager.rs:44`, `--mode rpc`) and talks to it over stdin/stdout JSONL (`pi_rpc_bridge.rs`) |
| Extension binding | Calls `session.bindExtensions({ uiContext, mode: "rpc", commandContextActions, ... })` directly with a **JS object** implementing `ExtensionUIContext` — no serialization | Extensions run inside the child `pi` process and talk to *its own* RPC layer (`rpc-mode.ts`), which serializes `ExtensionUIContext` calls into `extension_ui_request` JSON frames on stdout |
| Transport to browser | Same-process event emitter (`AgentEvent`) → SSE/WebSocket to the React client | JSON frames from the child process → Rust `PiRpcBridge` → forwarded verbatim over the Tauri WebSocket/host origin to the JS frontend |

Both ultimately expose the **same wire protocol** (`extension_ui_request` /
`extension_ui_response`, `get_commands`, etc., defined in `rpc-types.ts`). The
difference is not the protocol — it's how much of that protocol each frontend
actually *implements*.

## 2. Command execution (`get_commands`, slash commands)

Both sides call `{ type: "get_commands" }` and get back
`{ commands: RpcSlashCommand[] }` (extension-registered commands + prompt
templates + skills). Both build a slash-command palette from it:

- pi-web: `components/ChatInput.tsx` (`buildSlashCommandLayout`, grouped by
  source: builtin/extension/prompt/skill).
- Picot: `public/native/composer/slash-commands.js` (`buildCommandCatalog`) +
  `public/native/composer/composer-slash-menu.js`, fed from
  `app.js:640-645` (`loadCommands()` → `runtime.request({ type: "get_commands" }, target)`;
  moved from the old `app.js:611` call site, same behavior).

**This part is at parity.** Invoking a command just sends a `prompt`/`steer`
RPC command in both cases; the command's *side effects* (tool calls, message
history) render fine everywhere because they flow through the normal message
stream, not through `ExtensionUIContext`.

The gap is entirely in what happens **while** a command/extension is running
and wants to render or read something outside the normal chat transcript.

## 3. Extension UI methods — implementation matrix

`ExtensionUIContext` (`pi-mono/.../core/extensions/types.ts:124`) has ~20
methods. Each one becomes an `extension_ui_request` frame with a `method`
field. Here is what each frontend does with it:

| method | RPC frame | pi-web (`lib/rpc-manager.ts`, `hooks/useAgentSession.ts`, `components/ChatWindow.tsx`) | Picot (`extension-ui-host.js`, `app.js`, `dialog.js`) |
|---|---|---|---|
| `select` / `confirm` / `input` / `editor` | blocking, needs `extension_ui_response` | ✅ Rendered as a modal (`ExtensionDialog`) built from React | ✅ Rendered as a modal (`showNativeDialog`) or inline card (`showInlineExtensionPrompt`), queued per-session |
| `notify` | fire-and-forget | ✅ `addNotice` → toast/system message | ✅ `messageRenderer.renderSystemMessage` |
| `setStatus` | fire-and-forget | ✅ `ExtensionStatusBar` renders `{key,text}` pills | ✅ shown only as generic "Connected" text (`setStatus(request.statusText || "Connected")`) — status **key** is discarded, so multiple concurrent statuses collapse to one string |
| `setWidget` (string[] content only) | fire-and-forget | ✅ `ExtensionWidgets` renders `lines[]` above/below the editor, keyed by `widgetKey`, keeps a live `Map<key, widget>` | ⚠️ **Special-cased for exactly one extension** (`rpiv-todo-mirror.js` matches `widgetKey === "rpiv-todos"`); every other extension's widget hits the hook and is silently dropped (`widget: (request) => { if (isRpivTodoWidgetRequest(request)) return; }` — no `else` branch) |
| `setWidget` (component-factory overload) | **not representable over RPC at all** | Not supported (RPC mode strips factories, see `rpc-mode.ts` comment: *"Only support string arrays in RPC mode — factory functions are ignored"*) | Same limitation — this is a protocol-level gap, not host-specific |
| `setTitle` | fire-and-forget | ✅ sets `document.title` | ✅ sets `document.title` |
| `set_editor_text` / `pasteToEditor` | fire-and-forget | ✅ inserts into the composer via `chatInputRef` | ✅ sets `input.value` directly |
| `custom(factory, …)` (arbitrary interactive TUI component) | needs `extension_ui_request(method:"custom")` render frames + `extension_ui_input` keystroke frames + `extension_ui_response` on close | ✅ **Full support** — see §4 | ❌ **Explicitly rejected**: `extension-ui-host.js` has no `case "custom"`, falls into `default:` and immediately replies `{ cancelled: true, error: "unsupported" }` |
| `setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator` / `setHiddenThinkingLabel` | not emitted at all by RPC mode (`rpc-mode.ts` has them as no-ops with comments: *"not supported in RPC mode - requires TUI loader access"*) | N/A (never sent) | N/A (never sent) |
| `setFooter` / `setHeader` | not emitted at all in RPC mode (no-ops) | N/A | N/A |
| `getEditorText` | synchronous, can't round-trip over RPC | returns `""` always | not implemented client-side either |
| `addAutocompleteProvider` / `setEditorComponent` | not supported over RPC | no-op | no-op |
| theme methods (`getAllThemes`, `setTheme`, …) | RPC returns empty/failure | stubbed | not surfaced |

**Headline finding:** `setStatus`/`setWidget` are received by Picot's bridge
but the frontend throws away the payload for anything beyond one hardcoded
extension, and `custom` is actively refused at the JS layer — even though the
Rust bridge (`pi_rpc_bridge.rs`) and the runtime frame classification
(`BridgeFrame::ExtensionUi`) already forward these frames correctly. **The gap
is 100% in the browser-side JS (`extension-ui-host.js`), not in Rust, not in
the RPC protocol, and not in the `pi` binary.**

> **Verified 2026-08-02** against current code — all claims above still hold.
> File locations have moved since this doc was first written:
> `extension-ui-host.js` now lives at
> `public/native/extensions/extension-ui-host.js`, and `rpiv-todo-mirror.js`
> at `public/native/features/rpiv-todo-mirror.js`. The dispatch switch
> (`extension-ui-host.js:143-169`) still has no `case "custom"` and no
> `pasteToEditor` case — both fall through to `default:` and reply
> `{ cancelled: true, error: "unsupported" }`. `hooks.status`/`hooks.widget`
> in `app.js:265-299` are unchanged: `status` discards `statusKey`
> (`setStatus(request.statusText || "Connected")`, line 284) and `widget` has
> no `else` branch beyond the `rpiv-todos` special case (lines 293-297).
> `pi_rpc_bridge.rs`'s `read_frames()` (lines 279-319) still classifies purely
> on the `type` field prefix (`extension_ui*`) into `BridgeFrame::ExtensionUi`
> without ever inspecting `method` — confirming the bridge is not the
> bottleneck.

## 4. Why pi-web can do `custom()` and Picot can't

`ExtensionUIContext.custom()` lets an extension mount an arbitrary
interactive component built with `pi-tui` primitives (`Component`, `TUI`,
`Theme`, `KeybindingsManager`) and get raw keystrokes until it calls `done()`.

### pi-web's trick: a headless TUI shim, in the same process

Because pi-web embeds the SDK in-process, it doesn't need RPC serialization
for `custom()` at all — it can call the extension's factory function directly
with a **headless implementation of `TUI`**:

- `lib/custom-ui-terminal.ts` — `createHeadlessCustomUiTui()` returns a fake
  `{ terminal: { columns, rows, kittyProtocolActive: false }, requestRender() }`
  that satisfies the `TUI` interface enough for `pi-tui` `Component`s to render
  themselves into an array of ANSI-styled strings.
- `lib/rpc-manager.ts` (`requestExtensionCustomUi`) calls
  `factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done)`, gets back a
  `Component` with `.render(width): string[]`, and on every `requestRender()`
  re-invokes `.render()` and emits the resulting lines as
  `extension_ui_request { method: "custom", lines }`.
- Because pi-web *is* the RPC endpoint (it's the SDK, not a client of one),
  this whole flow happens **without ever leaving the module** — no subprocess,
  no extra IPC frame for the component object itself, only the rendered lines
  cross into the browser.
- Keystrokes come back as `extension_ui_input { id, data }` (see
  `lib/rpc-manager.ts:610`, fed by `hooks/useAgentSession.ts:753`) and are
  passed to `component.handleInput(data)`, which is exactly what a real
  terminal would feed a `pi-tui` component (raw ANSI/keyboard escape
  sequences, produced browser-side by `lib/terminal-input.ts` —
  `toTerminalKeyData()` / `asBracketedPaste()`).
- The browser side is `ExtensionCustomPanel` in `components/ChatWindow.tsx`: a
  modal with a hidden `<textarea>` that captures keydown/composition/paste
  events, converts them to terminal escape sequences, and a `<pre>` that
  renders the ANSI-styled lines via `parseAnsiLine()` (`lib/ansi.ts`).

So pi-web effectively reimplements "one terminal cell grid, rendered as HTML,
fed by real keystrokes" — a minimal xterm-like bridge, purpose-built for
`pi-tui` components. It does not need `pi-tui`'s real terminal renderer; it
only needs `Component.render(width): string[]` + `Component.handleInput(data)`,
which is the full public contract `pi-tui` components implement.

### What's missing for Picot to get the same thing

Picot's architecture already has the right shape to do this — it's arguably
*better positioned* than pi-web, because:

1. The Rust bridge already classifies `method: "custom"` frames as
   `BridgeFrame::ExtensionUi` and forwards them — nothing to change there.
2. `pi_rpc_bridge.rs`'s `request()`/`send_frame()` already round-trip
   arbitrary JSON, so `extension_ui_input` frames (keystrokes) are just another
   JSON payload the bridge doesn't need to know about.
3. Picot already has ANSI-aware rendering infrastructure it built for other
   things (dialogs, tool cards) that could be reused/extended.

But two pieces are genuinely absent:

1. **The RPC child process itself never emits `method: "custom"` frames**,
   because `rpc-mode.ts`'s `custom()` implementation is a hard stub:
   ```ts
   async custom() {
     // Custom UI not supported in RPC mode
     return undefined as never;
   }
   ```
   (still the exact code at `rpc-mode.ts:227-230` as of 2026-08-02; also
   confirmed `setFooter`/`setHeader`/`setWorkingMessage`/`setWorkingVisible`/
   `setWorkingIndicator`/`setHiddenThinkingLabel` remain true no-ops at
   `rpc-mode.ts:178-192,209-215`, and `rpc-types.ts`'s `RpcExtensionUIRequest`
   union, lines 213-248, still has no `"custom"` variant and `RpcCommand` has
   no `extension_ui_input`-shaped keystroke command — pi-web's `custom()`
   support is built entirely on its own `lib/types.ts` vocabulary, which is
   richer than the shared `rpc-types.ts` contract.)
   This is upstream in `pi-mono/packages/coding-agent`, not in Picot. **Picot
   cannot receive `custom` frames from a real subprocess until this is
   implemented in `rpc-mode.ts`** — pi-web only gets it because it bypasses
   `rpc-mode.ts` entirely and calls `bindExtensions` with its own
   `ExtensionUIContext` implementation in-process (§1). This is the single
   biggest structural reason for the gap: **pi-web's "RPC mode" is a
   same-process reimplementation of the UI context; Picot's RPC mode is the
   literal upstream RPC mode, which is intentionally more limited today.**

2. **`extension-ui-host.js` has no browser-side handler at all** for
   `custom` — it's routed to the generic `default:` branch and answered
   `{ cancelled: true, error: "unsupported" }` immediately (see
   `extension-ui-host.js` and its own test:
   `"reports TUI-only operations as unsupported"`). Even once upstream RPC
   mode emits real `custom` frames, Picot's host JS would still need:
   - a render loop that re-requests the component's rendered lines on
     `requestRender()` (there's no such request today because there's no
     emitter to trigger it — this would come for free once `rpc-mode.ts`
     emits `method: "custom"` render frames the same way pi-web's
     `emitCustomUiRender` does),
   - an input path that turns DOM keydown/paste events into terminal escape
     sequences and posts them back as `extension_ui_input` (pi-web's
     `lib/terminal-input.ts` is directly portable — same escape-sequence
     table works for any xterm-speaking backend),
   - a modal/panel to host the ANSI-rendered lines (Picot's dialog/message
     rendering already parses styled text elsewhere, so this is mostly
     wiring, not new capability).

## 5. `setStatus` / `setWidget` — smaller, purely browser-side gaps

Unlike `custom()`, these **already work end-to-end at the protocol layer** in
Picot today — `rpc-mode.ts` emits them from a real subprocess, the Rust
bridge forwards them, and `extension-ui-host.js` already routes them to
`hooks.status` / `hooks.widget`. The only thing missing is **generic
rendering**:

- `setStatus`: Picot's `hooks.status` throws away `statusKey` and always
  displays a single hardcoded "Connected" string
  (`status: (request) => setStatus(request.statusText || "Connected")`).
  pi-web keeps a live `Map`/array keyed by `statusKey`
  (`extensionStatuses`) and renders all of them via `ExtensionStatusBar`.
  **Fix is purely frontend**: keep a `Map<statusKey, statusText>` (mirroring
  `useAgentSession.ts`'s `setExtensionStatuses` reducer) and render it instead
  of a single string.
- `setWidget`: Picot's `hooks.widget` is a no-op except for one
  extension-specific `widgetKey` check. pi-web keeps a
  `Map<widgetKey, {lines, placement}>` (`extensionWidgets`) and renders all of
  them above/below the composer via `ExtensionWidgets`. **Fix is purely
  frontend**: generalize `rpiv-todo-mirror.js`'s special case into a generic
  `Map<widgetKey, {lines, placement}>` renderer (e.g. a
  `above-editor-widgets` / `below-editor-widgets` DOM container), falling back
  to that generic renderer for any `widgetKey` that isn't already natively
  mirrored (keep the `rpiv-todos` special case as an *override*, not the only
  path).

These two are low-risk, no-Rust-changes, no-upstream-changes fixes — pure
browser JS, following the pattern pi-web already validated.

## 6. Summary: what's actually blocking Picot today

| Gap | Layer | Needs upstream (`pi-mono`) change? | Needs Rust (`src-tauri`) change? | Fix scope |
|---|---|---|---|---|
| Generic `setStatus` rendering (multiple keys) | `public/native/app.js` hook | No | No | Small, frontend-only |
| Generic `setWidget` rendering (any extension, not just rpiv-todo) | `public/native/app.js` hook + a new widget container | No | No | Small, frontend-only |
| `custom()` TUI components (e.g. interactive pickers/forms extensions build with `pi-tui`) | Needs `rpc-mode.ts` to actually emit `method: "custom"` render/input frames (it's currently a stub returning `undefined`) | **Yes** — `pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts` `custom()` | No (bridge already forwards arbitrary `extension_ui_*` frames) | Medium: needs upstream RPC support + a browser-side render/input loop modeled on pi-web's `ExtensionCustomPanel` + `terminal-input.ts` |
| `setWorkingMessage`/`setWorkingIndicator`/`setFooter`/`setHeader`/custom editor components | Not emitted by RPC mode for *either* host (both are no-ops in `rpc-mode.ts`) | Yes, if ever wanted | No | Out of scope — neither pi-web nor Picot supports these; not a Picot-specific regression |

**Bottom line for the user's premise:** it's *not* that "extensions don't
report state to Picot's RPC" — the RPC layer (subprocess → Rust bridge →
WebSocket) already carries `setStatus`/`setWidget`/`custom` frames correctly
for anything the upstream `pi` binary emits. The real gaps are:

1. Picot's **browser JS** (`extension-ui-host.js` / `app.js`) only special-cases
   one extension's widget and discards everyone else's `setStatus`/`setWidget`
   payloads — that's fixable entirely inside Picot, no upstream dependency.
2. `custom()` (arbitrary interactive extension UI) is unimplemented **in the
   real `pi --mode rpc` binary itself** (`rpc-mode.ts`), so no client of the
   real binary — including a hypothetical from-scratch Picot rewrite — can
   receive those frames yet. pi-web only appears to support it because it
   doesn't go through that binary at all; it embeds the SDK and hand-rolls its
   own `ExtensionUIContext`, which is a fundamentally different integration
   strategy than Picot's "spawn the real CLI in RPC mode" approach.

## 7. Suggested path for Picot

1. **Ship the low-risk wins first** (§5): generalize `setStatus` and
   `setWidget` handling in `public/native/app.js` /
   `extension-ui-host.js` to key by `statusKey`/`widgetKey` and render N
   items, not 1. This alone recovers a meaningful slice of "extension
   functionality invisible in Picot" with zero upstream/Rust changes.
2. **File the `custom()` RPC gap upstream** against
   `pi-mono/packages/coding-agent/src/modes/rpc/rpc-mode.ts` — propose an
   `extension_ui_request { method: "custom", lines }` /
   `extension_ui_input { id, data }` protocol identical to pi-web's
   `custom-ui-terminal.ts` approach, since pi-web already proves the design
   works and the RPC type definitions (`rpc-types.ts`) can be extended to
   match `lib/types.ts`'s `ExtensionUiRequest` union (which already has the
   `method: "custom"` / `closed` shape pi-web invented — reusing it keeps the
   two hosts' protocols convergent instead of diverging further).
3. **Once upstream emits `custom` frames**, port pi-web's
   `lib/terminal-input.ts` (escape-sequence mapping) and the
   render/modal pattern from `ExtensionCustomPanel` into Picot's JS — the
   logic is host-agnostic (DOM keydown → ANSI bytes, ANSI-styled
   `string[]` → styled DOM) and doesn't depend on pi-web's in-process
   embedding.

## 8. Concrete design notes (added after re-verifying against current code)

### Phase 1 — generic `setStatus`/`setWidget` (frontend-only, no upstream/Rust dependency)

Copy pi-web's keyed-state model as-is. Note pi-web itself uses a plain array
with filter-then-append dedup keyed by `statusKey`/`widgetKey`
(`hooks/useAgentSession.ts:791-810`), not an actual `Map` — replicate that
exact shape rather than inventing a new one, since it's already
battle-tested:

- `app.js`'s `hooks.status`/`hooks.widget` become
  `statusItems: {key, text}[]` / `widgetItems: {key, lines, placement}[]`,
  deduped by `key`, removing an entry when `statusText === undefined`.
- Add generic `above-editor-widgets` / `below-editor-widgets` DOM containers
  and a status bar that iterate over *all* keys, not just `rpiv-todos`.
- Keep `rpiv-todo-mirror.js` as an **override**, not the only path: if a
  native mirror exists for a `widgetKey`, prefer it; otherwise fall back to
  the generic renderer.

Low risk, immediately visible payoff, no dependency on phases 2/3.

### Phase 2 — upstream protocol extension (`pi-mono`: `rpc-mode.ts` + `rpc-types.ts`)

This is the actual blocker, and benefits both hosts:

1. Add a `custom` variant to `rpc-types.ts`'s `RpcExtensionUIRequest` union,
   shaped exactly like pi-web's own `ExtensionUiRequest`
   (`{method: "custom", id, lines: string[], closed?: boolean}`) — reusing
   pi-web's already-proven shape keeps the two hosts' protocols convergent.
2. Add `extension_ui_input {id, data: string}` to `RpcCommand` as the
   keystroke-return channel (distinct from the one-shot
   `extension_ui_response` used for select/confirm).
3. Implement `rpc-mode.ts`'s `custom()` following pi-web's
   `requestExtensionCustomUi` design: build a headless `TUI`
   (`{terminal: {columns, rows, kittyProtocolActive: false}, requestRender()}`),
   call the extension's factory to get a `Component`, emit
   `render(width): string[]` results as `extension_ui_request{method:"custom",lines}`,
   call `component.handleInput(data)` on incoming `extension_ui_input` and
   re-render, and emit `{lines: [], closed: true}` on `done()`/dispose. This
   logic is host-agnostic — pi-web already validated the design; it just
   needs to be re-targeted at stdout JSONL frames instead of an in-process
   event emitter.

### Phase 3 — Picot browser-side render/input loop

Once upstream actually emits `custom` frames, three pieces, all "same logic,
different host":

1. **Keystroke encoding**: `lib/terminal-input.ts`'s `toTerminalKeyData()` /
   `asBracketedPaste()` are pure functions with no React/pi-web-specific
   state — portable byte-for-byte. The mapping table (arrows, Home/End,
   Ctrl-combos via `code & 0x1f`, Alt-prefix via `\x1b`+char, Enter/Tab's
   Shift variants) is standard terminal escape-sequence trivia, host-agnostic.
2. **ANSI rendering**: `lib/ansi.ts`'s `parseAnsiLine()` (SGR-only —
   8-color/bright/256-color/truecolor) plus `normalizeCustomPanelLines()`
   (strips TUI box-drawing borders and cursor markers) can be ported wholesale
   or mapped onto Picot's existing ANSI-rendering infra (dialogs, tool cards).
3. **Input capture + queue integration** — this is where Picot's extra
   complexity vs. pi-web actually lives, and needs deliberate design: pi-web
   is a single-session web page, so `ExtensionCustomPanel` just mounts a
   hidden `<textarea>` and captures keydown/composition/paste directly. Picot
   already has a per-session foreground/background queue for blocking dialogs
   (`extension-ui-host.js`'s `#queues`/`#inFlight`, `flushForegroundQueue()`)
   — `custom` UI panels must plug into the *same* mechanism: only the
   foreground session's `custom` panel should mount keyboard capture and
   drive a `requestRender()` loop; background sessions' `custom` frames
   should just cache the latest `lines` and defer mounting the render/input
   loop until that session becomes foreground. Otherwise multiple sessions'
   custom panels would fight over keyboard focus or render in the
   background for no reason.

### A sizing detail worth flagging

pi-web's headless terminal size is fixed per-request (default 92×40, clamped
40-140 via `options.overlayOptions().width`) — it doesn't adapt to the
browser window. Picot can start by copying this simple fixed/clamped-width
model; making the panel width follow real DOM dimensions (passing the
panel's actual available column count into the `custom` request) is a
nice-to-have for later, not a blocker for a first version.

**Priority**: Phase 1 can ship today, independently, zero risk. Phase 2 must
land in `pi-mono` first (the protocol design can be copied from pi-web's
already-working implementation, no fresh design needed). Phase 3 is mostly
mechanical porting — the only genuinely new design work is integrating with
Picot's existing foreground/background session queue.
