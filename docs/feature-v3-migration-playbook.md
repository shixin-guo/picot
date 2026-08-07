# feature-v3 → v3.3-new-arch Migration Playbook

> **Read this before starting any feature-v3 port.**
> Every lesson below was paid for in debugging time. Follow the protocol and
> you will avoid repeating the same mistakes.

## The two architectures at a glance

| Dimension | feature-v3 (source) | v3.3-new-arch (target) |
| --- | --- | --- |
| Entry point | `public/app.js` | `public/native/app.js` |
| Sidebar | `public/sidebar/index.js` (modular class) | `public/native/session/session-sidebar.js` (single class) |
| Session item | `public/sidebar/build-session-item.js` | inlined in `session-sidebar.js` `#buildItem` |
| Workspace group builder | `public/sidebar-workspace-group.js` | `public/sidebar-workspace-group.js` (**already ported**) |
| Quick-info card | `public/workspace-quick-info.js` | `public/workspace-quick-info.js` (**already ported**) |
| Pinned store | `public/pinned-items.js` (cookie) | `public/native/session/pinned-items.js` (localStorage) |
| Session identifier | `session.filePath` (disk path) | `session.id` (in-memory UUID) |
| Workspace identifier | `workspace.workspaceId` (`history:` / `path:` prefix) | `project.path` (bare on-disk path) |
| CSS | `public/style.css` (one mega-file) | split: `public/style.css` + `public/native/**/*.css` |
| i18n | `public/i18n.js` | same module at `public/i18n.js` |
| Icons | `public/icons.js` (Lucide SVG registry) | same module at `public/icons.js` (**already ported**) |
| File-type icons | `public/file-type-icons.js` (Material SVG) | same (**already ported**) |
| HTTP routes | `src-tauri/src/host_server.rs` | same module (routes added incrementally) |

## The golden rule

> **Port verbatim. Do not re-implement.**

feature-v3 was a mature, tested codebase. Every time we "simplified" or
"adapted" the source during porting, we introduced bugs:

- We replaced SVG icon buttons with emoji → Dr. Lin rejected it, we had to redo.
- We wrote a custom `#buildPinnedSection` instead of using
  `buildSidebarSection` → the PINNED group had the wrong visual style and
  missing disclosure toggles.
- We skipped the CSS entirely → the quick-info card rendered as unstyled
  boilerplate.
- We omitted the `/api/workspace-info` backend route → git repository info
  never appeared even though the frontend was correctly ported.

**If feature-v3 has a file for it, port that file.** If feature-v3 uses a
builder function, call that builder. If feature-v3 has CSS rules, copy those
CSS rules. Adapt only the identifier scheme and import paths — nothing else.

## Pre-port checklist (do this every time)

1. **Locate ALL source files** in `private/features-v3`:

   ```bash
   git show private/features-v3:public/  # list the tree
   git grep -n '<keyword>' private/features-v3 -- 'public/'
   ```

2. **Check CSS** — the source CSS lives in `public/style.css`. Search it:

   ```bash
   git show private/features-v3:public/style.css | grep '<class-name>'
   ```

   Copy matching rules to the appropriate target CSS file. CSS is the #1
   forgotten artifact.

3. **Check backend routes** — if the feature makes HTTP calls, verify the
   route exists in `src-tauri/src/host_server.rs`:

   ```bash
   rg '<api-path>' src-tauri/src/
   ```

   If missing, port the handler from feature-v3 or write a new one that
   returns the same JSON shape.

4. **Check i18n keys** — verify all `t("sidebar.xxx")` calls have
   corresponding keys in all four locale files:

   ```bash
   python3 -c "import json; d=json.load(open('public/locales/en.json')); print(d['sidebar'].get('KEY','MISSING'))"
   ```

5. **Check identifiers** — know the mapping:
   - `session.filePath` → `session.id`
   - `workspace.workspaceId` (`history:<dir>`) → `project.path`
   - Pin store key: `filePath` → `session.id`

## Porting protocol

### Step 1: Port the source files verbatim

```bash
# Copy the file as-is from feature-v3
git show private/features-v3:public/<file> > public/<target-path>
```

Only change:

- Import paths (e.g. `"./i18n.js"` → `"../../i18n.js"`)
- Identifier references (filePath → id) **inside** ported functions
- Storage backend (cookie → localStorage) **only** if the feature-v3 version
  uses cookie and the target convention is localStorage

Do NOT change:

- DOM construction patterns (use `createElement`/`textContent` as-is)
- CSS class names
- Icon generation (`createIcon("pin")` etc.)
- Event wiring patterns

### Step 2: Port the CSS

```bash
# Find and extract all CSS rules referencing the feature's class names
git show private/features-v3:public/style.css | grep -A 20 '\.<class-name>'
```

Append to the nearest feature-owned CSS file. Run `bunx biome check --write`
to format.

### Step 3: Wire into the target architecture

This is the only step where you write new code. The goal is to **call** the
ported builders, not to re-implement their internals.

Typical wiring points:

- **Sidebar render**: `session-sidebar.js` `render()` — call
  `buildSidebarSection` / `buildSidebarWorkspaceGroup` the same way
  feature-v3's `render()` does.
- **Constructor**: `session-sidebar.js` constructor — initialize stores,
  subscribe to changes.
- **app.js orchestrator**: `native/app.js` `adoptTarget()` — trigger
  sidebar reload on workspace change.

### Step 4: Add backend routes (if needed)

If the frontend calls `/api/<endpoint>`:

1. Check `host_server.rs` for the route.
2. If missing, find the handler in feature-v3's `host_server.rs` (or write a
   new one following the `git_stat_handler` pattern).
3. Add the method to `host_data.rs` (follow the `git_stat` pattern: resolve
   workspace root, run git command, return serializable struct).
4. Add `.route("/api/<endpoint>", get(handler))` to the router.
5. Run `bun run check:rust` to verify.

### Step 5: Update tests

feature-v3 ships test files (e.g. `session-sidebar-pinned.test.js`). Port
them to the target path and adapt:

- Identifier references (filePath → id)
- Mock data shapes (`{ id: "s-1", filePath: "..." }`)
- DOM selectors if the class structure changed (it shouldn't if you ported
  the builders verbatim)

## Common pitfalls

### 1. Cookie → localStorage identifier drift

feature-v3's `pinned-items.js` uses `session.filePath` as the pin key. The
target uses `session.id`. When porting, rename the **parameter** but keep
the **schema field** stable (`sessions: string[]`). The pin key is just a
string — whether it's a path or a UUID doesn't matter to the store.

### 2. `adoptTarget` missing sidebar reload

The #1 integration bug: `adoptTarget()` in `app.js` calls
`sidebar.setActive()` but **not** `sidebar.load()`. When a workspace is
first resolved (after bootstrap), the sidebar never fetches sessions.

**Fix**: In `adoptTarget`, when `workspaceId` changes:

```js
if (nextTarget.workspaceId !== previousTarget.workspaceId) {
  sidebar?.load().catch(showError);
}
```

### 3. Pin store notify gap

The top-level `pinWorkspace` / `pinSession` functions write to storage but
the `createPinnedItemsStore` wrapper has its own `emit`. If you call the
top-level functions directly (not through the store), subscribers won't
fire. The fix: `writePinnedItems` must call `notifyChanged()` at the end.

### 4. `innerHTML` → DOM API

feature-v3's sidebar uses `innerHTML` with `escapeHtml()` wrappers. The
target architecture (v3.3) is moving toward `textContent` / `createElement`
DOM construction (pi-lens flags innerHTML). When porting a builder that uses
`innerHTML`, prefer the DOM API equivalent. But **do not refactor existing
code that isn't part of the port** — only convert the code you are actively
touching.

### 5. `buildSidebarSection` vs custom section headers

feature-v3 has ONE unified section builder: `buildSidebarSection`. All four
sidebar regions (RECENT, PINNED, PROJECTS, ARCHIVED) use it. Do NOT write a
custom header builder — the CSS contract (`sidebar-section-header`,
`sidebar-section-title`, `sidebar-section-count`, `section-chevron`) is
coupled to this specific DOM structure.

### 6. CSS is the #1 forgotten artifact

Every time the UI "looks wrong" after a port, it's because the CSS wasn't
ported. feature-v3's CSS is all in `public/style.css` (4000+ lines). Search
for the class names and copy the rules to the target CSS file.

### 7. Backend routes must match frontend fetch paths

The frontend `WorkspaceQuickInfo` fetches `/api/workspace-info`. If the
backend route doesn't exist, the card renders without git info — silently.
Always verify routes exist after porting a feature that makes HTTP calls.

## File inventory: already ported

| File | Source | Status |
| --- | --- | --- |
| `public/icons.js` | feature-v3 `public/icons.js` | ✅ Verbatim |
| `public/file-type-icons.js` | feature-v3 `public/file-type-icons.js` | ✅ Identical |
| `public/workspace-quick-info.js` | feature-v3 `public/workspace-quick-info.js` | ✅ Verbatim |
| `public/sidebar-workspace-group.js` | feature-v3 `public/sidebar-workspace-group.js` | ✅ Verbatim |
| `public/native/session/pinned-items.js` | feature-v3 `public/pinned-items.js` | ✅ Adapted (cookie→localStorage, filePath→id) |
| `public/native/session/session-sidebar.js` | feature-v3 `public/sidebar/index.js` | ✅ Adapted (single class, native gateways) |
| `public/native/workspace/file-browser.js` | feature-v3 `public/workspace/file-browser.js` | ✅ Adapted (material icons) |
| `public/git-panel.js` | feature-v3 `public/git-panel.js` | ✅ Adapted (material icons) |

## File inventory: not yet ported

Check against the feature-v3 source tree and the manual test plan:

```bash
# List feature-v3 files that don't exist in the target
git show private/features-v3:public/ --name-only | while read f; do
  [ ! -f "$f" ] && echo "MISSING: $f"
done
```
