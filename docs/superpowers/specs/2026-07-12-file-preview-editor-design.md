# Picot File Preview and Editor Design

**Date:** 2026-07-12  
**Status:** Implemented and verified
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
- The application remains a native-module frontend. CodeMirror and PDF.js are imported directly by source modules for Vitest and are mapped to same-origin ESM vendor bundles by the browser import map.

## 3. Layout

The desktop layout becomes:

```text
Session sidebar | Chat | splitter | Preview/editor panel | File tree
```

The existing session sidebar and File tree retain their responsibilities. The middle region owns chat and preview/editor layout.

The workspace header is a shared, non-scrolling toolbar above the chat, preview/editor panel, and File tree. The panel must start below this header; it must never be a top-level sibling that begins at the window's top edge.

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

### 3.3 Header and preview alignment

- The shared header remains visible above the entire workspace while chat, preview/editor, and File tree occupy the content row below it.
- Markdown preview reserves a 28px left margin. CodeMirror uses the same 28px minimum line-number gutter, so rendered Markdown aligns with source/edit content without rendering line numbers.

## 4. Module boundaries

### 4.1 `public/file-preview-panel.js`

Owns panel lifecycle, splitter behavior, tab bar rendering, active-tab selection, panel enlarge/collapse, tab close confirmation, and renderer mounting. It does not own file I/O, directory traversal, Markdown parsing, or CodeMirror configuration.

### 4.2 `public/file-tab-state.js`

Owns tab identity, active-tab state, workspace-root isolation, persistence, and cleanup of invalid persisted paths.

The model reserves multiple content kinds:

{
  workspaceRoot: "/workspace/project",
  tabs: [
    {
      id: "file:/workspace/project/README.md",
      kind: "file",
      filePath: "/workspace/project/README.md",
      mode: "preview",
      content: null,
      originalContent: null,
      dirty: false
    }
  ],
  activeTabId: "file:/workspace/project/README.md"
}
```

Future Git diff tabs can use `kind: "diff"` without changing the tab bar or panel layout. `content` and `originalContent` are in-memory fields only; they are updated when a renderer is detached and restored when it is mounted again. They are never written to localStorage.

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
When the active renderer is detached, the panel reads the current CodeMirror document with `view.state.doc.toString()` before calling `destroy()`. It stores that value in the tab's in-memory `content` field, preserving dirty edits across tab switches. Reopening the tab recreates CodeMirror from that value. Closing or discarding a tab releases the in-memory content.

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

Wraps the existing `renderMarkdown()` export from `public/markdown.js` for file preview use. The wrapper uses DOM APIs, not a new sanitization dependency: it parses generated HTML in a detached `<template>`, keeps this explicit element allowlist—`p`, `br`, `hr`, `h1` through `h6`, `strong`, `em`, `del`, `code`, `pre`, `blockquote`, `ul`, `ol`, `li`, `table`, `thead`, `tbody`, `tr`, `th`, `td`, `a`, `img`, `div`, `span`, and `input`—and removes every other element. It removes all event-handler attributes, allows only safe `http:`, `https:`, `mailto:`, and fragment link protocols, allows only `http:`, `https:`, and `data:image/*` image protocols, allows `input` only for disabled task-list checkboxes, and permits only `text-align` values (`left`, `center`, `right`) in table-cell styles. It removes the renderer's inline copy-button `onclick` attribute and installs copy-button event delegation after sanitization.

### 4.6 `public/file-browser.js`

Keeps directory listing, navigation, native opening, and drag-to-chat behavior. It gains an `onFileSelect` callback but does not create CodeMirror or manipulate the preview panel directly.

## 5. Frontend dependency bundling

Picot continues to load `public/app.js` and feature modules as native browser ES modules. The application is not converted into one full frontend bundle, so ordinary application-module edits remain directly loadable by the existing development server.

Source modules import CodeMirror and PDF.js from their normal npm package specifiers:

```js
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
```

Vitest resolves these imports from `node_modules`, so tests do not depend on generated files.

For the browser, `index.html` contains an import map that maps each runtime package specifier used by the application to same-origin generated ESM files:

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
@codemirror/legacy-modes/mode/shell
pdfjs-dist/legacy/build/pdf.mjs
```

The CodeMirror entry exports the named runtime APIs used by the application from one browser bundle. The PDF.js entry exports the PDF facade separately, and the PDF.js worker is emitted as a separate same-origin asset. The import map is browser-only; Vitest never reads it.

`scripts/build-frontend.js` is a new build script parallel to `scripts/build-extensions.js`:

```json
{
  "build:frontend": "node scripts/build-frontend.js",
  "build:frontend:watch": "node scripts/build-frontend.js --watch"
}
```

The script uses esbuild with `bundle: true`, `format: "esm"`, and `platform: "browser"` for the CodeMirror and PDF.js entries. It writes generated files below `public/vendor/`. `public/vendor/` is added to `.gitignore`; the directory is a build artifact and is never imported by tests.

Development behavior:

- `bun run dev` performs one `bun run build:frontend` before `tauri dev` starts;
- ordinary application-module edits remain unbundled and are loaded by the existing WebView reload flow;
- `bun run build:frontend:watch` runs esbuild watch mode when changing vendor entry configuration or dependency exports;
- the vendor watch process is not needed for ordinary panel, renderer, or app edits.

Release behavior:

- `prebuild` runs `fetch:pi`, `build:extensions`, and `build:frontend`;
- the Tauri `beforeDevCommand` runs `fetch:pi` and `build:frontend`;
- the Tauri `beforeBuildCommand` runs `fetch:pi`, `build:extensions`, and `build:frontend`;
- `public/vendor/` is inside the existing `frontendDist` tree and is served by the embedded server;
- the generated ESM files comply with the existing Tauri CSP because scripts come from the same localhost origin;
- CodeMirror's runtime `<style>` injection is covered by the existing `style-src 'self' 'unsafe-inline'` policy.

The dependency set is:

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
pdfjs-dist
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

Serves approved image and PDF content with a safe MIME type. Images use the raw URL directly. PDF preview uses PDF.js and the raw URL as its document source. Arbitrary HTML, JavaScript, and unknown binary content must not be served as executable resources.

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

### 6.4 Workspace root and path safety

The active workspace root is the canonical path of `latestCtx?.cwd || process.cwd()`. `latestCtx` is republished on every `session_start`, so a headless session or session switch uses the current session context. The process's instance registration also records `ctx.cwd || process.cwd()` for workspace routing.

The `/api/files` endpoint has two explicit scopes:

- `scope=workspace` is used by FileBrowser and applies the active workspace-root boundary;
- `scope=picker` is used by FolderPicker and retains unrestricted read-only directory browsing so a user can choose an initial workspace.

The default scope is `workspace`. FileBrowser sends `scope=workspace` on every directory request, and `FileBrowser.getParentPath()` stops at `workspaceRoot`. FolderPicker sends `scope=picker` and remains able to browse from the filesystem root. Content and raw endpoints always use the active workspace boundary and never accept picker scope.

All content/raw endpoints and workspace-scoped directory requests resolve and canonicalize the requested path, then verify that it remains inside the active workspace root. The implementation rejects:

- `..` traversal;
- symlink escapes;
- directories passed as files;
- writes to missing or non-regular files;
- paths outside the active workspace.

If a stale client requests a path outside the current session root, the server returns a structured `outsideWorkspace` error. In normal browsing this is prevented by `scope=workspace`; the panel state is primarily for persisted tabs from a previous workspace or session-root change. The panel shows a localized outside-workspace state and keeps Close tab and Copy file path available.

## 7. Renderer behavior

### 7.1 Text and code

Text files open as read-only CodeMirror preview. Edit changes the same renderer to editable mode. Both modes use line numbers.

Supported language families include JavaScript/TypeScript, JSON, YAML, Python, R, Rust/Go/C/C++, HTML/CSS, shell, TOML, XML, and Markdown source. Unknown text uses read-only CodeMirror without syntax highlighting.

### 7.2 Markdown

Markdown opens in `renderFileMarkdown()` preview mode. The renderer reuses Picot's existing `renderMarkdown()` implementation and adds file-preview sanitization. Markdown preview is a reading view and has no line-number gutter.

Edit switches to CodeMirror with line numbers. Preview switches back to rendered Markdown.

Markdown preview retains the alignment margin described in §3.3. It does not render line numbers.

### 7.3 Images

Images use an `<img>` renderer backed by `/api/files/raw`. Images are read-only. Open in desktop and copy path remain available; content copy and save are unavailable.

### 7.4 PDF

PDFs use PDF.js as the initial renderer. The PDF.js worker is bundled as a same-origin ESM asset, and pages render into canvases inside a scrollable tab container. The renderer is read-only and supports Open in desktop, Copy file path, Enlarge/Collapse, and Close tab. Native `<iframe>`/`<embed>` is not the primary path because nested PDF viewer support is inconsistent in WKWebView. A platform-specific native viewer can be considered later without changing the renderer interface.

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

The toolbar opens from the panel controls and remains available while a text renderer is active. Actions that require CodeMirror are disabled in Markdown rendered preview, image preview, PDF preview, and binary fallback states.

### 8.1 Preview toolbar

```text
Open in desktop
Line wrap
Edit
Copy file content
Save file
```

`Save file` remains visible for text preview but is disabled while the renderer is read-only. Inapplicable actions are hidden or disabled for images, PDFs, and binary files.

### 8.2 Edit toolbar

```text
Auto-save
Open in desktop
Line wrap
Find
Go to line
Preview
Copy file content
Save file
```

- The visible Find label is `Find` in English and `查找` in Chinese.
- CodeMirror Search/Replace uses localized phrases for Find, Replace, navigation, matching options, replacement, close, and Go to line. Existing editors reconfigure their phrases when the application locale changes.
- Selecting Go to line replaces its button with a focused numeric input. Enter moves the cursor to a positive, existing line and restores the button. Escape or blur cancels input and restores the button. The toolbar does not use `window.prompt()`.

Auto-save defaults to enabled. It saves about 1.5 seconds after typing stops. Manual Save cancels the pending timer and writes immediately. If auto-save receives HTTP 409, it pauses further auto-save for that tab, keeps the tab dirty, marks the tab as conflicted, and does not open a modal dialog. The conflict action appears in the tab state and toolbar. The next user-initiated tab switch, close, reload, or panel close opens Reload/Overwrite/Cancel. An explicit `Save file` action opens the conflict choice immediately.

## 9. Dirty state and conflicts

A tab becomes dirty when its editor content differs from the last loaded or saved content. Dirty content is preserved in memory when CodeMirror is detached and is released only after save, discard, or tab close.

The following actions require Save/Discard/Cancel when a tab is dirty:

- switching tabs;
- closing a tab;
- closing the panel;
- changing workspace;
- reloading a file;
- responding to an external modification conflict.

The server returns the loaded `mtimeMs`. Save includes `expectedMtimeMs`. A 409 response from an explicit save enters conflict state and immediately offers Reload, Overwrite, or Cancel. A 409 from auto-save enters conflict state without a modal dialog, pauses auto-save, and defers the choice until a user-initiated action.

## 10. Persistence

Persist per workspace root:

- open file tabs;
- active tab;
- preview/edit mode;
- panel open/enlarged state;
- panel width;
- line-wrap preference;
- auto-save preference.

Picot's embedded server gives each workspace instance its own localhost port, so per-port localStorage naturally isolates persisted tabs by workspace. Cross-workspace global preferences continue to use the existing project convention when needed.

Do not persist unsaved full file content, CodeMirror instances, transient selections, search state, loading state, or errors. Dirty content remains in memory until the user saves or discards it.

## 11. Localization and accessibility

All visible labels use `t()` and are added to both locale files. New keys use `files.preview.*`, `files.editor.*`, `files.tabs.*`, `files.errors.*`, and `files.unsaved.*` namespaces. CodeMirror's internal Search/Replace labels use `EditorState.phrases` and must track the active Picot locale.

Every icon button has a localized `title` and `aria-label`. SVG icons are `aria-hidden`. The inline Go to line input has a localized placeholder and `aria-label`. Saving, loading, saved, conflict, and error states use an accessible live region. File names are inserted with text-safe DOM APIs, not unescaped HTML interpolation.

## 12. Testing and verification

Add `public/file-tab-state.test.js` and `public/file-preview-panel.test.js` covering:

- duplicate prevention;
- active-tab selection;
- neighboring-tab selection after close;
- dirty Save/Discard/Cancel behavior;
- dirty content preservation when a CodeMirror renderer is detached and remounted;
- open/close/enlarge/collapse;
- workspace isolation;
- localStorage restoration and invalid-data cleanup;
- auto-save debounce timing;
- auto-save 409 conflict state, pause, and deferred resolution;
- explicit-save 409 immediate conflict flow.

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
- Markdown sanitization;
- Markdown preview gutter alignment with the CodeMirror line-number gutter;
- Chinese CodeMirror Search/Replace phrases;
- inline Go to line input visibility, Enter navigation, and button restoration.

### File tree tests

Extend `public/file-browser.test.js` to cover:

- single-click file selection callback;
- double-click native opening;
- unchanged directory navigation;
- unchanged drag-to-chat behavior.

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
- size limits;
- workspace-root resolution from `ctx.cwd` and `process.cwd()`;
- workspace-scoped `/api/files` rejection of paths above the workspace root;
- picker-scoped `/api/files` access from the filesystem root.

### Required checks after implementation

```bash
bun run check
bun run vitest run public/file-tab-state.test.js
bun run vitest run public/file-preview-panel.test.js
bun run vitest run public/file-preview-renderers.test.js
bun run vitest run public/file-browser.test.js
bun run vitest run extensions/embedded-server-files.test.ts
bun run build:frontend
bun run build:extensions
```

The vendor build and same-origin CSP loading must also be exercised by a focused frontend smoke test.

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
10. Edit, Save, Auto-save, Find, localized Search/Replace, inline Go to line, Preview, Copy, and Open in desktop behave as specified.
11. Dirty tabs are protected by Save/Discard/Cancel.
12. Enlarge/Collapse and Close panel behave correctly.
13. Closing the panel does not lose open tabs.
14. Tab state is isolated and persisted per workspace.
15. Git diff is not implemented, but `kind: "diff"` is supported by the tab/renderer boundary.
16. English and Chinese localization keys are complete.
17. Focused tests and `bun run check` pass.
18. The shared header stays above the chat, preview/editor panel, and File tree; the preview/editor panel begins below it.
19. Markdown preview left alignment matches the CodeMirror line-number gutter.
