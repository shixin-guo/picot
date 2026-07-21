# Custom Drag Interaction Lessons

This guide records the constraints discovered while implementing file-tree-to-composer file mentions in Picot's macOS WebView. It applies whenever frontend code replaces a browser-native interaction with custom mouse or pointer handling.

## Ownership invariant

A gesture has exactly one drag state machine:

- Use native HTML5 drag and drop, **or**
- Disable native drag and own the gesture with application event handlers.

Do not mix them. A row with `draggable = false` can still invoke WebKit native drag behavior through CSS such as `-webkit-user-drag: element`.

For a custom drag source, first confirm that the pointer is on a valid source, then cancel the native action at `mousedown` or `pointerdown`:

```js
const item = getDraggableItem(event);
if (!item) return;

event.preventDefault();
```

Do not cancel ordinary clicks, directory navigation, or blank-area interactions.

## Required audit before changing drag behavior

Search both JavaScript and CSS for every native drag mechanism:

```text
draggable
-webkit-user-drag
dragstart
dragover
drop
dragend
pointer-events
user-select
```

Treat a CSS native-drag declaration as part of the interaction implementation, not merely presentation.

## State-machine contract

Model custom drag as explicit lifecycle states:

```text
idle → pressed → dragging → overTarget → dropped | cancelled → idle
```

Each visual or behavioral state requires a matching cleanup path:

- source-row dragging class;
- drag ghost;
- target hover class;
- document-level movement and release listeners;
- document-level cursor state;
- focus state, where applicable.

Release or cancel must clean every state, whether the pointer is over a valid target or not.

## Focus behavior in WKWebView

A call to `element.focus()` is not proof that an input received focus in Tauri's macOS WebView. Unit tests can prove that a handler calls it, but they cannot prove the actual WebKit result.

For a custom drag into an editable target:

1. Prevent the source's native drag behavior at gesture start.
2. Focus the target when the pointer first enters it during the custom drag.
3. Perform the drop operation on release.
4. Verify the behavior manually in Tauri/WKWebView: visible focus state, insertion caret, and immediate typing.

Do not use `setTimeout()` or `requestAnimationFrame()` as a first response to focus failure. First determine which state machine owns the gesture and whether native default actions are still active.

## Native drag UX that custom code must restore

Removing native drag also removes browser-provided feedback. Decide explicitly which feedback to retain:

- `cursor: copy` for copy semantics;
- a drag ghost;
- a target-hover indicator;
- source-row drag state;
- focus and insertion behavior after dropping;
- cancellation cleanup.

A source-only cursor rule does not cover the pointer after it leaves the source. For global custom-drag feedback, use a temporary document-level state such as `body.file-dragging` and remove it on release/cancel:

```css
body.file-dragging,
body.file-dragging * {
  cursor: copy !important;
}
```

## Testing and acceptance

Write an interaction-path test, not only helper tests. Cover:

```text
valid source mousedown
  → native default prevented
  → movement threshold crossed
  → global drag state and ghost created
  → target entered and focused
  → mouseup inserts the expected result
  → all temporary state is removed
```

Also test non-drag cases: directories, non-primary buttons, and movement below the threshold.

Before declaring the work complete:

1. Run the focused Vitest file.
2. Run `bun run check` after frontend edits.
3. Manually exercise the gesture in the desktop Tauri/WKWebView runtime.

Do not treat a jsdom `focus()` spy or `document.activeElement` assertion as a substitute for desktop WebView acceptance.
