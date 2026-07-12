# Picot File Preview and Editor Design

**Date:** 2026-07-12  
**Status:** Approved for implementation planning  
**Scope:** Desktop file preview/editor panel integrated with the existing File tree

## 1. Goal

Add a CodeMirror-based file preview/editor to the middle area of Picot. The existing chat remains visible on the left of the middle area, and the existing File tree remains on the far right. Selecting a file in the File tree opens it in a new tab in the preview/editor panel.

The first implementation supports text, Markdown, images, PDFs, unknown text, and binary-file fallbacks. Git diff is not implemented in this scope, but the tab model and renderer boundary reserve a `kind: "diff"` extension point.

## 2. Confirmed product decisions

- File tree single-click opens a file in the preview/editor panel.
- File tree double-click continues to open the file with the operating system via the existing `/api/open` endpoint.
- Multiple files can remain open in independent tabs.
- A tab is a content container. The renderer determines whether it is a CodeMirror editor, Markdown preview, image preview, PDF preview, or future diff viewer.
- Text files open in read-only preview mode by default.
- Markdown opens in rendered preview mode by default.
- Markdown rendered preview does not show line numbers. Markdown CodeMirror source preview and edit mode do show line numbers.
- CodeMirror text preview and edit mode always show line numbers.
- Edit mode is explicit. The preview toolbar exposes `Edit` only when the file is editable.
- Auto-save is enabled by default and runs about 1.5 seconds after typing stops.
- Save, discard, or cancel confirmation protects dirty tabs when switching, closing, reloading, changing workspace, or closing the panel.
- The preview/editor panel is resizable and defaults to about 42% of the available middle area.
- `Enlarge panel` hides the chat portion of the middle area and lets the preview/editor occupy it. `Collapse panel` restores the split.
- Closing the panel does not close its tabs. Reopening restores the persisted tab state.
- Tabs and panel preferences persist per workspace root.
- The File tree remains an independent right sidebar.
- The implementation uses vanilla JavaScript and CodeMirror, not React.
- The implementation uses a self-contained frontend bundle built with esbuild, not a CDN.

## 3. Layout

The desktop layout becomes:

```text
Session sidebar | Chat | splitter | Preview/editor panel | File tree
```

The existing session sidebar and File tree retain their responsibilities. The middle region owns chat and preview/editor layout.

### 3.1 Resizing

- The chat/preview boundary is a draggable splitter.
- The preview/editor panel defaults to approximately 42% of the middle region.
- The panel has a 320px minimum width.
- The panel has a maximum width of approximately 70% of the middle region.
- The width is persisted in localStorage.
- Enlarge/collapse changes the middle-region presentation, not the File tree width.
- On narrow windows, the preview/editor becomes a full-width overlay/page within the middle region and the splitter is hidden.

### 3.2 Panel controls

The tab row contains, at the far right:

- Enlarge panel / Collapse panel;
- Close panel.

Closing the panel preserves open tabs. Closing the last open tab closes the panel automatically.

## 4. Module boundaries

### 4.1 `public/file-preview-panel.js`

Owns panel lifecycle, splitter behavior, tab bar rendering, active-tab selection, panel enlarge/collapse, tab close confirmation, and renderer mounting. It does not own file I/O, directory traversal, Markdown parsing, or CodeMirror configuration.

### 4.2 `public/file-tab-state.js`

Owns tab identity, active-tab state, workspace-root isolation, persistence, and cleanup of invalid persisted paths.

The model reserves multiple content kinds:

```js
{
  workspaceRoot: "/workspace/project",
  tabs: [
    {
      id: "file:/workspace/project/README.md",
      kind: "file",
      filePath: "/workspace/project/README.md",
      mode: "preview"
    }
  ],
  activeTabId: "file:/workspace/project/README.md"
}
```

Future Git diff tabs can use `kind: "diff"` without changing the tab bar or panel layout.

### 4.3 `public/code-editor.js`

Owns a single CodeMirror instance and its lifecycle:

- `lineNumbers()`;
- read-only/editable configuration;
- language extension selection;
- line wrapping;
- search;
- go-to-line;
- change events;
- save content retrieval;
- destruction.

Only the active tab needs a mounted CodeMirror instance. This limits memory use when many tabs are open.

### 4.4 `public/file-preview-renderers.js`

Selects and mounts content renderers. The first implementation includes:

- Markdown rendered preview;
- CodeMirror text preview/edit;
- image preview;
- PDF preview;
- unknown-text read-only preview;
- binary-unavailable fallback.

A renderer follows this interface:

```js
const renderer = createFileRenderer({
  filePath,
  fileName,
  content,
  mimeType,
  mode,
  readOnly,
  lineNumbers: true,
  wrapLines,
  onChange,
  onSave,
  onModeChange,
  onError,
});

renderer.mount(container);
renderer.update(nextProps);
renderer.destroy();
```

### 4.5 `public/file-preview-markdown.js`

Wraps the existing `renderMarkdown()` export from `public/markdown.js` for file preview use. The wrapper sanitizes rendered output and restricts link/image protocols before insertion into the DOM.

### 4.6 `public/file-browser.js`

Keeps directory listing, navigation, native opening, and drag-to-chat behavior. It gains an `onFileSelect` callback but does not create CodeMirror or manipulate the preview panel directly.

## 5. Frontend bundling

Picot currently loads `public/app.js` as a browser module, but browser modules cannot resolve bare npm package imports such as `@codemirror/state`. The implementation therefore adds a frontend esbuild entry/build step.

Source modules remain individually testable. The build generates a self-contained browser bundle that includes CodeMirror and its language/search dependencies. The packaged application loads that generated bundle. The dev and release paths must build the frontend bundle before the Tauri WebView loads it.

The initial dependency set is:

```text
@codemirror/state
@codemirror/view
@codemirror/commands
@codemirror/language
@codemirror/search
@codemirror/lang-javascript
@codemirror/lang-json
@codemirror/lang-markdown
@codemirror/lang-python
@codemirror/lang-yaml
@codemirror/lang-html
@codemirror/lang-css
@codemirror/legacy-modes
```

R mode must not be assumed to exist. `.r` files remain openable, editable, and line-numbered; when no dedicated R mode is available, the language resolver falls back to plain text.

## 6. File API

The embedded server adds three endpoints.

### 6.1 `GET /api/files/content`

Reads a text file and returns:

```json
{
  "path": "/workspace/project/src/main.js",
  "content": "const value = 1;\n",
  "size": 18,
  "mtimeMs": 1752300000000,
  "mimeType": "text/javascript",
  "isBinary": false,
  "truncated": false
}
```

### 6.2 `GET /api/files/raw`

Serves approved image and PDF content with a safe MIME type. It supports `<img>`, `<iframe>`, and `<embed>` preview. Arbitrary HTML, JavaScript, and unknown binary content must not be served as executable resources.

### 6.3 `PUT /api/files/content`

Accepts:

```json
{
  "path": "/workspace/project/src/main.js",
  "content": "const value = 2;\n",
  "expectedMtimeMs": 1752300000000
}
```

The response includes the new file size and modification time. A modification-time mismatch returns HTTP 409 and leaves the file unchanged.

### 6.4 Path safety

All new endpoints resolve and canonicalize the requested path, then verify that it remains inside the current pi instance's workspace root. The implementation rejects:

- `..` traversal;
- symlink escapes;
- directories passed as files;
- writes to missing or non-regular files;
- paths outside the active workspace.

## 7. Renderer behavior

### 7.1 Text and code

Text files open as read-only CodeMirror preview. Edit changes the same renderer to editable mode. Both modes use line numbers.

Supported language families include JavaScript/TypeScript, JSON, YAML, Python, R, Rust/Go/C/C++, HTML/CSS, shell, TOML, XML, and Markdown source. Unknown text uses read-only CodeMirror without syntax highlighting.

### 7.2 Markdown

Markdown opens in `renderFileMarkdown()` preview mode. The renderer reuses Picot's existing `renderMarkdown()` implementation and adds file-preview sanitization. Markdown preview is a reading view and has no line-number gutter.

Edit switches to CodeMirror with line numbers. Preview switches back to rendered Markdown.

### 7.3 Images

Images use an `<img>` renderer backed by `/api/files/raw`. Images are read-only. Open in desktop and copy path remain available; content copy and save are unavailable.

### 7.4 PDF

PDFs use a native WebView `<iframe>` or `<embed>` backed by `/api/files/raw`. PDFs are read-only. If native Tauri WebView PDF support proves unreliable, a PDF.js renderer can replace this implementation behind the same renderer interface.

### 7.5 Binary and unknown files

The server detects obvious binary content using a small prefix read, including NUL-byte detection. Binary files show an unavailable-preview message and retain Open in desktop and Copy file path actions.

Unknown non-binary files open in read-only CodeMirror without a language extension.

### 7.6 Size limits

- Text read limit: 2 MiB.
- CodeMirror edit limit: 1 MiB.
- Text between 1 MiB and 2 MiB: read-only preview only.
- Text above 2 MiB: show a size warning without loading the full document.
- Binary asset endpoints enforce response limits appropriate to the renderer.

## 8. Toolbar behavior

The collapsed control is an icon-only `...` button. Hovering or activating it expands the floating toolbar. It remains open while an attached menu or dialog is active.

### 8.1 Preview toolbar

```text
Open in desktop
Disable line wrap
Edit
Copy file content
Copy file path
Save file
```

`Save file` remains visible for text preview but is disabled while the renderer is read-only. Inapplicable actions are hidden or disabled for images, PDFs, and binary files.

### 8.2 Edit toolbar

```text
Auto-save on
Open in desktop
Disable line wrap
Find in file
Go to line
Preview
Copy file content
Copy file path
Save file
```

Auto-save defaults to enabled. It saves about 1.5 seconds after typing stops. Manual Save cancels the pending timer and writes immediately.

## 9. Dirty state and conflicts

A tab becomes dirty when its editor content differs from the last loaded or saved content. The following actions require Save/Discard/Cancel when a tab is dirty:

- switching tabs;
- closing a tab;
- closing the panel;
- changing workspace;
- reloading a file;
- responding to an external modification conflict.

The server returns the loaded `mtimeMs`. Save includes `expectedMtimeMs`. A 409 response enters conflict state and offers Reload, Overwrite, or Cancel.

## 10. Persistence

Persist per workspace root:

- open file tabs;
- active tab;
- preview/edit mode;
- panel open/enlarged state;
- panel width;
- line-wrap preference;
- auto-save preference.

Do not persist unsaved full file content, CodeMirror instances, transient selections, search state, loading state, or errors. Dirty content remains in memory until the user saves or discards it.

## 11. Localization and accessibility

All visible labels use `t()` and are added to both locale files. New keys use `files.preview.*`, `files.editor.*`, `files.tabs.*`, `files.errors.*`, and `files.unsaved.*` namespaces.

Every icon button has a localized `title` and `aria-label`. SVG icons are `aria-hidden`. Saving, loading, saved, conflict, and error states use an accessible live region. File names are inserted with text-safe DOM APIs, not unescaped HTML interpolation.

## 12. Testing and verification

### State tests

Add `public/file-tab-state.test.js` and `public/file-preview-panel.test.js` covering:

- duplicate prevention;
- active-tab selection;
- neighboring-tab selection after close;
- dirty Save/Discard/Cancel behavior;
- open/close/enlarge/collapse;
- workspace isolation;
- localStorage restoration and invalid-data cleanup.

### Renderer tests

Add `public/file-preview-renderers.test.js` and `public/code-editor.test.js` covering:

- Markdown default preview;
- Markdown Preview/Edit transitions;
- line numbers in CodeMirror preview and edit;
- line-wrap switching;
- JSON/YAML/R language mapping and plain-text fallback;
- image and PDF renderer selection;
- binary rejection;
- large-file behavior;
- Markdown sanitization.

### File tree tests

Extend `public/file-browser.test.js` to cover:

- single-click file selection callback;
- double-click native opening;
- unchanged directory navigation;
- unchanged drag-to-chat behavior.

### Embedded server tests

Add `extensions/embedded-server-files.test.ts` covering:

- text read;
- image/PDF raw read;
- text write;
- traversal rejection;
- symlink escape rejection;
- directory rejection;
- binary detection;
- missing-file errors;
- 409 modification conflicts;
- size limits.

### Required checks after implementation

```bash
bun run check
bun run vitest run public/file-tab-state.test.js
bun run vitest run public/file-preview-panel.test.js
bun run vitest run public/file-preview-renderers.test.js
bun run vitest run public/file-browser.test.js
bun run vitest run extensions/embedded-server-files.test.ts
bun run build:extensions
```

The frontend bundle build must also be exercised by a focused smoke test.

## 13. Acceptance criteria

The implementation is complete when:

1. A single-clicked File tree file opens in the middle preview/editor panel.
2. Chat remains available beside the panel.
3. The File tree remains usable on the far right.
4. Multiple files open in independent tabs without duplicates.
5. Text opens read-only by default.
6. Markdown opens rendered preview by default.
7. CodeMirror preview and edit both show line numbers.
8. Images and PDFs preview in read-only renderers.
9. Obvious binary files are not rendered as text.
10. Edit, Save, Auto-save, Find, Go to line, Preview, Copy, and Open in desktop behave as specified.
11. Dirty tabs are protected by Save/Discard/Cancel.
12. Enlarge/Collapse and Close panel behave correctly.
13. Closing the panel does not lose open tabs.
14. Tab state is isolated and persisted per workspace.
15. Git diff is not implemented, but `kind: "diff"` is supported by the tab/renderer boundary.
16. English and Chinese localization keys are complete.
17. Focused tests and `bun run check` pass.
