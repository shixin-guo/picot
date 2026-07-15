# Pi 0.80.3 built-in capability inventory for Picot

Research date: 2026-07-14

## Scope and source of truth

Picot pins its embedded Pi runtime to **0.80.3** in
[`scripts/pi-version.json`](../../scripts/pi-version.json). This inventory therefore uses the official
upstream [`v0.80.3` tag](https://github.com/earendil-works/pi/tree/v0.80.3/packages/coding-agent)
as the compatibility source of truth, and uses the current
[`pi.dev/docs/latest`](https://pi.dev/docs/latest) only as a forward-looking cross-check.

The adjacent local `../pi-mono` checkout is **not** the source of truth for Picot: its
`packages/coding-agent/package.json` reports 0.76.0, while Picot bundles 0.80.3. It also has a local
modification. Exact claims below therefore link to the immutable upstream 0.80.3 source/docs.

The most important architectural boundary is this:

- Pi's interactive slash commands are implemented by the terminal UI.
- Picot embeds Pi in `--mode rpc`.
- RPC exposes many equivalent primitives, but it explicitly does **not** expose the built-in TUI
  commands through `get_commands`, and sending `/settings`, `/hotkeys`, and similar built-ins through
  `prompt` does not execute them. `get_commands` returns only extension commands, prompt templates,
  and skills. ([0.80.3 RPC `get_commands`](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#get_commands))

Consequently, a Picot feature is not obtained merely by forwarding the slash-command text. Picot
must either call an RPC primitive, build an equivalent UI/workflow itself, or add a new bridge/API.

## 1. Built-in interactive slash commands

Pi 0.80.3 has the following built-in interactive commands. The command list and descriptions come
from the versioned [Using Pi documentation](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/usage.md#slash-commands).

| Command | Pi TUI capability | RPC building block in 0.80.3 | Source-level implication for Picot |
| --- | --- | --- | --- |
| `/login`, `/logout` | Manage OAuth/API-key credentials | None | TUI-only credential flow; requires a separate Picot auth UI/bridge. |
| `/model` | Select a model | `set_model`, `cycle_model`, `get_available_models` | Fully representable through RPC. |
| `/scoped-models` | Choose and order models used by cycling | None | TUI/settings-only; Picot must maintain equivalent preferences itself or change settings. |
| `/settings` | Edit thinking, theme, delivery, transport, etc. | Partial: thinking, queue modes, auto-compaction, and auto-retry setters | There is no generic RPC settings API; each missing setting needs Picot-owned handling. |
| `/resume` | Browse previous sessions and select one | `switch_session` only | Switching is RPC-capable, but session discovery/picker UX is client-owned. |
| `/new` | Start a fresh session | `new_session` | RPC-capable. |
| `/name <name>` | Set session display name | `set_session_name` | RPC-capable. |
| `/session` | Show path, ID, messages, tokens, cost | `get_state`, `get_messages`, `get_session_stats`, `get_entries` | RPC-capable. |
| `/tree` | Browse the append-only tree, jump to a point, optionally summarize the abandoned branch | `get_tree` and `get_entries` are read-only | Tree inspection is exposed, but 0.80.3 has no RPC command equivalent to tree navigation. |
| `/trust` | Persist project trust decision | None | TUI-only at runtime; RPC startup instead follows saved trust/default policy and `--approve`/`--no-approve`. |
| `/fork` | Create a new session from an earlier user message | `get_fork_messages`, `fork` | RPC-capable. |
| `/clone` | Clone the current active branch into a new session | `clone` | RPC-capable. |
| `/compact [prompt]` | Compact context, optionally with custom instructions | `compact`, `set_auto_compaction` | RPC-capable. |
| `/copy` | Copy the latest assistant answer | `get_last_assistant_text` | The text is RPC-capable; Picot must perform the OS/browser clipboard write. |
| `/export [file]` | Export HTML or JSONL | `export_html` only | HTML export is RPC-capable. There is no dedicated RPC JSONL-export command; the active session is already a JSONL file. |
| `/import <file>` | Import and resume an external JSONL session | None | TUI-only workflow; `switch_session` only loads a session path and is not documented as import. |
| `/share` | Upload a private GitHub gist and return a shareable link | None | TUI-only network workflow. |
| `/reload` | Reload keybindings, extensions, skills, prompts, themes, and context | None | No RPC reload command in 0.80.3. Restarting the process is the conservative equivalent. |
| `/hotkeys` | Display all TUI keybindings | None | TUI-only and mostly irrelevant to a browser UI unless Picot recreates the actions. |
| `/changelog` | Display Pi version history | None | TUI-only presentation. |
| `/quit` | Exit Pi | None as an RPC command | Picot's process manager must terminate the subprocess. |

The exact RPC command union is defined in
[`rpc-types.ts`](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/src/modes/rpc/rpc-types.ts)
and documented in the versioned [RPC reference](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#commands).

## 2. Complete RPC capability surface in Pi 0.80.3

These are the headless primitives Picot can implement directly without invoking a TUI-only command:

| Area | RPC commands |
| --- | --- |
| Prompt and queue | `prompt` (text/images; immediate or queued), `steer`, `follow_up`, `abort`, `new_session` |
| State | `get_state`, `get_messages` |
| Model | `set_model`, `cycle_model`, `get_available_models` |
| Thinking | `set_thinking_level`, `cycle_thinking_level` |
| Queue policy | `set_steering_mode`, `set_follow_up_mode` |
| Compaction | `compact`, `set_auto_compaction` |
| Retry | `set_auto_retry`, `abort_retry` |
| User shell execution | `bash`, `abort_bash` |
| Session | `get_session_stats`, `export_html`, `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`, `set_session_name` |
| Extensibility discovery | `get_commands` for extension commands, prompt templates, and skills |
| Extension UI response | `extension_ui_response` for extension dialogs |

Source: [Pi 0.80.3 RPC commands](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#commands).

RPC events available to a graphical client are:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `queue_update`
- `compaction_start`, `compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `extension_error`

Source: [Pi 0.80.3 RPC event types](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#event-types).

The current latest protocol additionally documents `agent_settled`; it is **not** present in the
0.80.3 RPC event list, so Picot should not rely on it until the embedded Pi version is upgraded.
([latest RPC events](https://pi.dev/docs/latest/rpc#event-types))

## 3. Model, thinking, queue, and runtime controls

Pi 0.80.3 RPC can list/select/cycle models, set/cycle supported thinking levels, control steering and
follow-up delivery (`all` or `one-at-a-time`), enable/disable auto-compaction and auto-retry, abort the
active agent, abort a retry delay, and execute/abort user bash commands. These are first-class RPC
commands, not approximations. ([0.80.3 RPC model through bash sections](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#model))

Settings go beyond this runtime RPC surface. Pi settings also include theme/display behavior, project
trust, compaction thresholds, retry counts/delays, transport/timeouts, image behavior, shell command,
session behavior, model cycling, Markdown rendering, and resource/package configuration. There is no
generic `get_settings`/`set_settings` RPC command in 0.80.3. Those settings are file/startup concerns or
must be represented by Picot. ([0.80.3 settings reference](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/settings.md#all-settings))

## 4. Session controls and important RPC gaps

Pi sessions are append-only trees. RPC exposes both the current message context and the durable entry
tree: `get_messages`, `get_entries`, and `get_tree`; it also exposes the active leaf ID. This is enough
to render history and branches. ([0.80.3 RPC session section](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#session))

However, in 0.80.3:

- `get_tree` only returns the tree; there is no `navigate_tree` RPC command. Therefore the defining
  `/tree` action—moving the live session leaf to an arbitrary prior entry—is not available through the
  documented RPC protocol.
- `fork` is available, but it creates a new session from a prior **user message**, which is not the
  same as in-place navigation to any entry.
- `switch_session` requires a path and does not provide session discovery/search/deletion/rename UI.
  Discovery and deletion are client-side responsibilities; renaming the active session is available
  through `set_session_name`.
- JSONL import, private-gist sharing, and live resource reload have no RPC command.

The broader interactive session behavior—resume search, delete/rename shortcuts, branch labels and
filters, branch summarization prompts—is documented in
[Sessions](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/sessions.md)
and [Keybindings](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/keybindings.md#sessions).

## 5. Built-in tools and input capabilities

Pi 0.80.3 ships implementations for seven built-in agent tools:

- `read`
- `bash`
- `edit`
- `write`
- `grep`
- `find`
- `ls`

They can be allowlisted/excluded or disabled at process startup with `--tools`, `--exclude-tools`,
`--no-builtin-tools`, and `--no-tools`. Source:
[0.80.3 CLI tool options](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/usage.md#tool-options)
and [tool implementations](https://github.com/earendil-works/pi/tree/v0.80.3/packages/coding-agent/src/core/tools).

Interactive input also includes `@` file fuzzy search, Tab path completion, multiline input, pasted or
dragged images, `!command` (shell output is added to model context), `!!command` (hidden from model
context), and an external editor. ([0.80.3 editor features](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/usage.md#editor-features))

RPC directly supports text and base64 images on `prompt`, and provides `bash` with the same deferred
inclusion of output in the next model prompt. File fuzzy search, path completion, drag/paste handling,
hidden shell commands, and external-editor invocation are client UX and are not RPC commands.

## 6. Extension commands, skills, prompts, and extension UI

RPC `get_commands` discovers extension commands, prompt templates, and skills; `prompt` expands skill
commands and prompt templates, and executes extension commands immediately even while the agent is
streaming. Built-in TUI commands are intentionally excluded.
([0.80.3 RPC prompting](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#prompt),
[0.80.3 `get_commands`](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#get_commands))

Extensions in RPC mode can request these UI operations from a graphical client:

- Blocking dialogs: `select`, `confirm`, `input`, `editor`
- Fire-and-forget: `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`

The client must render dialogs and return matching `extension_ui_response` messages. It may display or
ignore fire-and-forget requests. ([0.80.3 extension UI protocol](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#extension-ui-protocol))

Some extension UI capabilities are explicitly unavailable or degraded in RPC mode:

- `custom()` returns `undefined`.
- `setWorkingMessage()`, `setWorkingIndicator()`, `setFooter()`, `setHeader()`,
  `setEditorComponent()`, and `setToolsExpanded()` are no-ops.
- Editor/tool-expanded getters return empty/false defaults.
- Theme discovery and theme mutation are unavailable.
- Component-factory widgets are ignored; RPC supports string-line widgets only.

These limitations are intrinsic to Pi 0.80.3's RPC adapter, not merely missing Picot UI.
Source: [0.80.3 extension UI protocol](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#extension-ui-protocol).

Extensions themselves can register tools, commands, shortcuts, flags, renderers, providers, model
changes, event hooks, and dynamic tool sets. Whether a Picot user can benefit depends on whether the
extension relies only on headless/RPC-safe APIs or on the unsupported TUI APIs above.
([0.80.3 Extensions API](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/extensions.md#extensionapi-methods))

## 7. CLI-only and startup capabilities

Pi's CLI has capabilities outside a live RPC session:

- Package lifecycle: `pi install`, `remove`/`uninstall`, `update`, `list`, and `config`.
- Modes: interactive, print, JSON event stream, RPC, and one-shot session export.
- Startup model/session/resource/tool configuration.
- Initial `@file` arguments and piped stdin.
- System-prompt replacement/appending, project trust overrides, custom session directory, ephemeral
  sessions, explicit extensions/skills/templates/themes, and resource-discovery disable flags.

Source: [Pi 0.80.3 CLI reference](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/usage.md#cli-reference).

Because Picot always starts the embedded runtime in RPC mode, these are not runtime RPC operations.
Picot can expose an equivalent only by changing subprocess launch options, manipulating the supported
configuration/package files safely, or providing a separate package-management process/UI. Pi
self-update is especially inappropriate for Picot's embedded binary because Picot's pinned bundle is
the product source of truth.

## 8. Actual Picot implementation audit

Picot already provides useful equivalents for model selection and visibility, session listing and
switching, new parallel sessions, session naming/deletion, manual compaction, per-message clipboard
copying, HTML export, image prompts, thinking display, and basic session statistics. It also exposes
global Pi package install/remove UI. These are not gaps merely because the TUI slash-command names are
absent.

The remaining gaps fall into three different classes.

### 8.1 Pi 0.80.3 can do it through RPC, but Picot does not currently expose it correctly

| Capability | Current Picot behavior | Evidence |
| --- | --- | --- |
| Native prompt preprocessing | Picot calls the extension API's `sendUserMessage()`, which deliberately disables command handling and prompt/skill expansion. The slash menu also filters `getCommands()` down to skills only. Consequently explicit `/skill:*`, prompt-template, and extension-command invocation does not follow native RPC `prompt` semantics. | [`embedded-server.ts`](../../extensions/embedded-server.ts), especially `normalizeSkillCommands()` and the `prompt` case; upstream [`AgentSession.sendUserMessage()`](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/src/core/agent-session.ts#L1197-L1238) |
| True steering/follow-up queues | Picot keeps one browser-side queue and waits until `state.isStreaming` becomes false before sending the next prompt. It does not expose distinct steering vs follow-up submission or the two queue modes. | [`app.js`](../../public/app.js) `sendMessage()` / `flushQueue()`; [`embedded-server.ts`](../../extensions/embedded-server.ts) has unused `steer` and `follow_up` handlers |
| Fork and clone | Pi RPC has `get_fork_messages`, `fork`, and `clone`; Picot has no matching handlers or UI. | [`embedded-server.ts`](../../extensions/embedded-server.ts) command switch; [0.80.3 RPC session commands](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#session) |
| Auto-compaction toggle | The Picot handler acknowledges `set_auto_compaction` without changing Pi, and `get_state` always reports it as enabled. The visible setting is therefore cosmetic. | [`embedded-server.ts`](../../extensions/embedded-server.ts) `get_state` and `set_auto_compaction`; [`app-settings-toggles.js`](../../public/app-settings-toggles.js) |
| Retry control | Pi RPC exposes `set_auto_retry` and `abort_retry`; Picot forwards retry events but offers neither command. | [`embedded-server.ts`](../../extensions/embedded-server.ts); [0.80.3 RPC retry](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#retry) |
| Direct user bash mode | Pi RPC exposes `bash` and `abort_bash`; Picot has neither the `!`/`!!` editor UX nor web command handlers. Agent-initiated use of the `bash` tool still works. | [`embedded-server.ts`](../../extensions/embedded-server.ts); [0.80.3 RPC bash](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#bash) |
| Full session stats | Picot's custom stats response omits the session ID, output/cache token totals, cost, context-window percentage, and tool-result count supplied by native RPC. Its UI shows only message/tool counts and an approximate context token count. | [`embedded-server.ts`](../../extensions/embedded-server.ts) `get_session_stats`; [`app.js`](../../public/app.js) `showSessionStats()` |
| Model-aware thinking cycle | Picot hard-codes `off` through `high`. Pi 0.80.3 also supports `xhigh` on supported models; latest Pi additionally documents `max`. | [`embedded-server.ts`](../../extensions/embedded-server.ts) `cycle_thinking_level`; [0.80.3 RPC thinking](https://github.com/earendil-works/pi/blob/v0.80.3/packages/coding-agent/docs/rpc.md#thinking) |

Picot contains browser dialog rendering for `extension_ui_request`, but the transport is not connected
to Pi's RPC extension-UI protocol: Rust discards the subprocess stdout where those requests are emitted,
and the embedded WebSocket command switch has no `extension_ui_response` case. Thus extension dialogs,
notifications, status/widgets, title changes, and editor-prefill requests are not currently end-to-end
usable despite the frontend code. See [`pi_manager.rs`](../../src-tauri/src/pi_manager.rs) subprocess
stdio configuration, [`dialogs.js`](../../public/dialogs.js), and
[`embedded-server.ts`](../../extensions/embedded-server.ts).

### 8.2 Picot must build its own workflow because Pi has no matching 0.80.3 RPC command

- OAuth `/login` and `/logout`. Picot supports stored API keys, but its own source explicitly excludes
  OAuth browser round trips.
- `/trust`. This is especially important because Picot starts `--mode rpc` without `--approve` or a
  trust UX. Under the default `defaultProjectTrust: "ask"`, untrusted project settings, `.pi` resources,
  project extensions, and project skills are ignored in non-interactive RPC mode.
- `/tree` in-place branch navigation and branch-summary choice. Picot can render the tree using
  `get_tree`, but 0.80.3 RPC cannot move the active leaf.
- JSONL import, private-GitHub-gist `/share`, `/reload`, changelog presentation, and Pi TUI hotkey help.
- The rest of `/settings` for delivery, transport, retry thresholds, compaction thresholds, shell,
  session directory, resource paths, and similar file/startup settings.
- `@` file fuzzy completion, path completion, and external-editor invocation. Picot does support
  multiline input, image paste/drop, a file browser, and dragging a path from that browser.

### 8.3 Intrinsic RPC/TUI incompatibilities

Even with a complete Picot RPC client, TUI-specific extension features remain unavailable or degraded:
arbitrary `custom()` components/overlays, custom editor/header/footer/working indicators, theme APIs,
component widgets, terminal keyboard shortcuts, and custom terminal renderers. Supporting those would
require a new cross-UI extension contract, not just another Picot button.

## 9. Practical comparison checklist for Picot

When auditing Picot, treat the following as separate questions:

1. **RPC-supported:** Does Picot send/handle the relevant command, response, and events?
2. **Client-owned equivalent:** Does Picot recreate TUI-only UX such as auth, settings, history search,
   clipboard, file completion, hotkeys, or package management?
3. **Extension compatibility:** Does Picot implement all nine RPC extension UI request methods and the
   four dialog responses?
4. **Intrinsic RPC limitation:** Is the feature impossible through Pi 0.80.3 RPC itself, such as
   in-place tree navigation, custom TUI components, footer/header replacement, or theme APIs?
5. **Version mismatch:** Is a capability documented only by latest Pi (for example `agent_settled`) and
   therefore unavailable in Picot's pinned 0.80.3 runtime?

This distinction prevents labeling every missing TUI affordance as an upstream limitation: many have
good RPC primitives, while others genuinely require new Pi protocol support or a Picot-owned workflow.
