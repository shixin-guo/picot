# Chat History Navigation Design

## Status

The interaction design was approved in conversation with Dr. Lin on 2026-07-14
and revised after an architecture review. This document defines the desktop
chat-history navigator. Implementation has not started.

## Goal

Add a compact navigator to the left-center edge of the chat panel. The navigator
lets users inspect a long conversation by user turn and jump directly to an
earlier prompt without displacing the chat layout.

## Scope

The navigator:

- indexes one item per user turn;
- shows persistent, low-contrast tick marks;
- magnifies nearby ticks under the pointer;
- previews the selected user prompt and assistant response;
- follows the current scroll position; and
- updates during streaming.

The first version supports desktop interfaces that match `(hover: hover)` and
`(pointer: fine)`. It remains hidden on touch-first and mobile layouts. It also
remains hidden when a session contains fewer than two user turns.

## Non-goals

- A mobile or touch-specific navigator
- Search within the navigator
- Navigation to tool calls, thinking blocks, or individual assistant messages
- Persisting navigator state across sessions or reloads
- Changing the Pi session format or RPC protocol

## Turn Model

Each navigation item represents one user turn:

```js
{
  id,
  userElement,
  userText,
  hasUserImage,
  assistantText,
  responseState,
}
```

`responseState` is `waiting`, `streaming`, or `complete`.

The prompt summary uses the user's visible plain text. When the prompt contains
images but no text, it uses the localized image-message label. The response
summary contains only visible assistant text. It excludes thinking, tool-call
arguments, tool results, usage data, and error details.

The navigator stores only the leading 2,000 Unicode code points of a prompt and
4,000 of a response. The chat renderer retains the full source; these bounded
copies are sufficient for the two- and three-line previews and prevent the
navigator from duplicating an unbounded conversation in memory.

The rendering pipeline supplies this data directly. The navigator must not
recover source content by scraping rendered Markdown. Direct data preserves the
boundary between visible response text and hidden thinking or tool content.

A turn starts at a renderable user message and ends immediately before the next
renderable user message. The navigator concatenates visible text from every
assistant message in that interval, separated by a blank line. Tool calls and
tool results may occur between assistant messages but never split a turn.
Assistant messages that precede the first user message do not create navigation
items. The existing local-send/message-start suppression remains the authority
for avoiding duplicate user turns.

## Visual Behavior

The navigator occupies a fixed overlay at the vertical center of the chat panel's
left edge. It does not reserve layout width and never shifts chat content.
The rail uses `height: clamp(160px, 42vh, 360px)` and a pointer hit area wide
enough to reach magnified ticks without covering message text.

Each user turn maps to one tick. The module distributes ticks evenly along a
fixed-height rail. At rest, ticks remain short, thin, and low contrast. The tick
that corresponds to the current viewport uses a stronger color.

Pointer movement selects the nearest tick by vertical position. Ticks close to
the pointer become progressively longer and thicker; the nearest tick receives
the strongest treatment. This magnification reveals local structure without
making the idle rail visually dominant.

The module coalesces pointer, scroll, resize, and streaming updates with
`requestAnimationFrame`. Magnification updates only the selected tick and a
bounded neighborhood of six ticks on either side. It resets the previous
neighborhood instead of rewriting every tick on each pointer event.

Long sessions retain one tick per user turn. Dense ticks may form a continuous
texture at rest, but pointer position still maps to the nearest turn. The local
magnification treatment separates nearby candidates.

The UI honors `prefers-reduced-motion`. Reduced-motion mode applies the same size
and color states without animated transitions or smooth scrolling.

## Preview and Navigation

Hovering the rail opens one preview card to its right. The card contains:

1. a user-prompt summary clamped to two lines; and
2. an assistant-response summary clamped to three lines.

The card uses a responsive width between 280 and 380 CSS pixels. Text truncation
uses CSS line clamping and an ellipsis. Summary truncation never affects the
stored target element or navigation behavior.

The prompt uses the stronger text treatment and the response uses a secondary
treatment, matching the prototype's visual hierarchy. If a completed turn has
no visible assistant text, the response area shows a localized no-visible-response
label instead of the generating label.

The card clamps its position to the visible chat viewport. It never crosses the
top, bottom, or right edge of the window. Moving the pointer from the rail to the
card keeps the card open. Leaving both starts a 120-millisecond close delay;
entering either surface cancels it so the gap between them does not cause
flicker.

The preview treats user prompts and assistant responses as untrusted text. It
creates text nodes or assigns `textContent`; it never inserts either value with
`innerHTML`. Tests use HTML-like and event-handler payloads to enforce this
boundary.

Clicking a tick or the user-prompt portion of its preview card scrolls the
matching user message into view. The response portion is not a navigation
control. Normal motion uses smooth scrolling and centers the prompt when
practical. Reduced-motion mode jumps immediately. After navigation, the user
message receives a brief visual highlight and the preview card closes; the
persistent rail remains visible.

## Scroll Tracking

The navigator observes the messages container. Its reading anchor sits 30% below
the visible container top. The active turn is the last user message at or above
that anchor. The first turn remains active before the first prompt reaches the
anchor; the last turn remains active after the final prompt passes it. A
12-pixel hysteresis around a boundary prevents rapid toggling between adjacent
turns.

A binary search over cached user-message offsets avoids scanning every turn on
each scroll event. A `ResizeObserver` and explicit message lifecycle updates
invalidate those offsets when the container, images, Markdown, or message heights
change. The module recomputes offsets at most once per animation frame.

Scroll tracking updates only the active tick. It does not open or move the
preview card unless the pointer is already interacting with the navigator.

## Streaming and Session Lifecycle

When the user submits a prompt, the navigator adds a turn with `waiting` state.
When assistant generation starts, it changes the state to `streaming`. Visible
text deltas update `assistantText`; thinking and tool events do not. Finalization
changes the state to `complete`.

Streaming always updates the in-memory summary. It refreshes preview DOM only
when the preview displays that turn and only once per animation frame.

The preview shows localized waiting or generating text until visible response
text exists.

Historical-session rendering builds the complete turn index from the session
entries passed to the chat renderer. Switching sessions, starting a new session,
clearing the renderer, or failing to load history clears the old index before
new content appears.

## Module Boundary

`public/chat-history-navigation.js` owns:

- the turn index;
- rail and preview DOM;
- tick layout and magnification;
- active-turn scroll tracking;
- click navigation;
- streaming summary updates; and
- lifecycle cleanup.

`public/app.js` creates the module and relays existing chat lifecycle events. It
must not contain tick calculations, preview rendering, or turn-index logic.

The message renderer may expose narrow callbacks or return values that provide
the rendered element and visible source text. It must not own navigator UI.

## Accessibility and Internationalization

The rail is a pointer-only enhancement and remains outside the Tab order. It is
hidden from the accessibility tree because dozens of non-keyboard-operable ticks
would create misleading controls. Keyboard and assistive-technology users retain
the existing scrollable chat surface as the equivalent path through history.

All Picot-authored text uses `t(...)` keys in both `public/locales/en.json` and
`public/locales/zh.json`. Required concepts include:

- image message;
- waiting for response;
- generating response; and
- no visible response; and
- any user-visible navigator status or tooltip.

User prompts, assistant responses, paths, and model output remain verbatim. A
locale change updates an open preview's status text without rebuilding chat
messages or interrupting streaming. CSS truncation must support both English and
Chinese text.

## Error Handling

- Missing or malformed message content produces an empty summary, not an
  exception.
- A turn without visible assistant text retains its status label.
- Missing target elements remove the stale turn before navigation.
- Session switches cancel pending animation frames, observers, and preview
  state.
- Invalid or HTML-like prompt and response text remains inert text.
- Navigator failures must not block chat rendering or scrolling.

## Verification

Automated tests cover:

1. one item per user turn;
2. hiding with fewer than two turns and on touch/mobile layouts;
3. image-only prompts;
4. bounded prompt and response summaries, with multiple assistant messages
   combined into one turn while thinking and tools remain excluded;
5. orphan assistant messages and duplicate local/message-start delivery;
6. waiting, streaming, and complete states;
7. bounded, animation-frame-coalesced magnification;
8. active-turn anchor, hysteresis, and boundary behavior while scrolling;
9. click navigation and reduced-motion behavior;
10. inert rendering of HTML-like prompt and response payloads;
11. preview hierarchy, no-visible-response fallback, close delay, truncation,
    and viewport clamping;
12. session clearing and stale-target cleanup; and
13. English and Chinese key parity and live locale updates.

Layout-dependent tests inject deterministic element geometry instead of relying
on jsdom layout. Final verification runs focused Vitest files, `bun run test`,
and `bun run check`. Manual verification covers light and dark themes, a long
session, a dense rail, a narrow desktop window, streaming, and session switches.
