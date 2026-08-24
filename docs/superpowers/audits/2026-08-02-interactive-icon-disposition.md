# Interactive icon disposition audit — 2026-08-02

Reproducible AST/text audit over every interactive `<button>`, `[role="button"]`,
and dynamic button factory in the WebView (`public/`), capturing the final
disposition of each control after the integrated UI modernization plan.

**Reproduction:**

```bash
grep -rn "createIcon(\|setButtonIcon(" public --include='*.js' | grep -v 'test\|node_modules\|icons.js:'
grep -n 'class="icon-btn\|role="button"' public/index.html
```

## Disposition legend

- `action-registry` — uses `public/icons.js` (local monochrome, 24×24, currentColor).
- `Material-object` — uses `public/file-type-icons.js` (trusted local Material vocabulary).
- `preserve-brand/text/status` — keeps existing brand/logo, text, or status glyph.
- `out-of-scope history` — session-history rendering (message-renderer/tool-card); explicitly excluded from migration.

## Static HTML controls (`public/index.html`)

| file:line | selector / id | user action | current glyph kind | disposition |
| --- | --- | --- | --- | --- |
| index.html:116 | `.icon-btn` (#sidebar-toggle) | toggle sidebar | inline svg | action-registry (preserve current chevron) |
| index.html:141 | `.icon-btn.hidden` (#side-chat-btn) | open Side Chat | inline svg | preserve-brand/text/status |
| index.html:164 | `.icon-btn` (#refresh-sessions-btn) | refresh sessions | inline static svg (refresh) | action-registry; static (no spin) — uses disabled + aria-busy |
| index.html:383 | `.icon-btn.panel-toggle-btn` (#file-sidebar-toggle) | toggle file browser | inline svg (folder) | action-registry |
| index.html:406 | `.icon-btn.hidden` (#terminal-toggle mount) | mount terminal toggle | dynamic (terminal-panel.js) | action-registry (sliders) |
| index.html:763,792 | `.icon-btn` (open-app menu) | open workspace / choose app | brand logo + chevron | preserve-brand/text/status |
| index.html:818 | `.icon-btn.file-preview-enlarge-btn` (#file-preview-enlarge) | enlarge panel | inline svg (maximize) | action-registry (maximize) |
| index.html:842 | `.icon-btn.file-preview-collapse-btn.hidden` (#file-preview-collapse) | restore panel | inline svg (minimize) | action-registry (minimize) |
| index.html:866 | `.icon-btn` (#file-preview-close) | close panel | inline svg (x) | action-registry |
| index.html:898–935 | `.icon-btn` (file-preview toolbar: toggle/preview/save/reload/search/go-to-line/copy/open) | file actions | inline svg | action-registry (preserve current glyphs) |
| index.html:955 | `.icon-btn` (#file-preview-mode-preview) | toggle preview/edit | inline svg (eye/pencil) | action-registry |
| index.html:1022,1042,1063 | `.icon-btn` (model/thinking/composer controls) | composer actions | inline svg | action-registry (preserve) |

## Dynamic button factories (`public/*.js`)

| file:line | symbol / factory | user action | glyph | disposition |
| --- | --- | --- | --- | --- |
| terminal-panel.js:56–61 | `TerminalPanel.toggleEl` (`panel-toggle-btn`) | expand/collapse terminal | createIcon("terminal") | action-registry (terminal); distinct from maximize/minimize |
| terminal-panel.js:96–103 | `TerminalPanel.enlargeButton` | enlarge/restore terminal | createIcon("maximize") → setButtonIcon("minimize") on enlarge | action-registry (maximize/minimize state pair) |
| terminal-panel.js:105–110 | `TerminalPanel newTabButton` | new terminal tab | createIcon("plus") | action-registry |
| terminal-panel.js:closeButton | `.terminal-collapse` | collapse terminal | setButtonIcon("x") | action-registry |
| file-preview-panel.js:31 | `appendTabBarActionIcon` (chat-plus) | new Side Chat tab | createIcon("message-square-plus") | action-registry |
| file-preview-panel.js:518 | `_createTabElement` close | close file tab | appendCloseIcon (x) | action-registry |
| file-preview-panel.js:663,734 | `_getFileIcon` → createFileTypeIcon | file tab object icon | Material SVG | Material-object |
| sidebar/build-session-item.js:110 | archive button | archive session | createIcon("archive") | action-registry |
| sidebar/build-session-item.js:141 | delete button | delete session | createIcon("trash-2") | action-registry |
| app.js (sidebar header) | `#session-search-clear` | clear search | setButtonIcon("x") | action-registry |
| app.js (sidebar header) | `#open-folder-btn` | open workspace | setButtonIcon("folder-plus") | action-registry |
| app.js (sidebar header) | `#quick-chat-btn` | open Quick Chat | setButtonIcon("message-circle") | action-registry |
| app.js (sidebar header) | `#refresh-sessions-btn` | refresh sessions | setButtonIcon("refresh-cw") | action-registry; static (disabled + aria-busy) |
| app.js (header) | `#settings-btn` | settings | setButtonIcon("settings") | action-registry |
| app.js (header) | `#sidebar-toggle` | toggle sidebar | setButtonIcon("menu") | action-registry |
| app.js (header) | `#header-open-app-toggle` | choose desktop app | setButtonIcon("chevron-down") | action-registry |
| app.js (header) | `#file-sidebar-toggle` | toggle file browser | setButtonIcon("panel-right") | action-registry |
| app.js (header) | `#side-chat-btn` | Side Chat | setButtonIcon("message-square") | action-registry |
| app.js (composer) | `#attach-btn` | attach | setButtonIcon("plus") | action-registry |
| app.js (composer) | `#command-btn` | command menu | setButtonIcon("bot") | action-registry |
| app.js (composer) | `#model-dropdown-btn` | model select chevron | setButtonIcon("chevron-down") | action-registry |
| app.js (composer) | `#mic-btn` | voice | setButtonIcon("mic") | action-registry |
| app.js (composer) | `#send-btn` | send | setButtonIcon("send") | action-registry |
| app.js (composer) | `#abort-btn` | abort | setButtonIcon("square") | action-registry |

## File/Git object-icon consumers (`Material-object`)

| file:line | consumer | glyph source |
| --- | --- | --- |
| workspace/file-browser.js:render | file tree rows | createFileTypeIcon |
| git-panel.js:renderTree | directory + file rows | createFileTypeIcon (folder / file) |
| file-preview-panel.js:_getFileIcon | file tabs | createFileTypeIcon |

## Explicitly out-of-scope (session history)

| surface | disposition |
| --- | --- |
| `ui/message-renderer.js` | out-of-scope history — current composition preserved |
| `ui/tool-card.js` | out-of-scope history — tool cards, collapse, layout preserved |
| user-prompt paragraph rendering | out-of-scope history |
| agent thinking blocks / tool calls (incl. bash) / final response | out-of-scope history |

## Metadata-info slice (decorative, aria-hidden)

| surface | disposition |
| --- | --- |
| `workspace-quick-info.js` folder/count/path/repo metadata icons | preserve current CSS-mask artwork (separate metadata slice; not a Header action) |
| `sidebar/workspace-focus-sidebar.js` inline info card icons | preserve current artwork |

## Audit coverage confirmation

- [x] Header action controls (32px scoped) — indexed.
- [x] Sidebar / session list factories — indexed.
- [x] File Preview enlarge/restore/close/toolbar — indexed.
- [x] Terminal toggle/enlarge/new-tab/close — indexed.
- [x] File Browser / Git Panel / File Preview object icons — indexed (Material-object).
- [x] Quick/Side Chat composer — indexed (preserve).
- [x] Super Agent / Skill menu / Packages — listed as preserve (no glyph change this slice).
- [x] Session history (message-renderer / tool-card) — explicitly excluded.

## Round-2 button-icon inventory — 2026-08-02

This pass closes controls found outside the first inventory. The scope is limited
 to interactive controls and action glyphs. Status dots, loading marks, object
 icons, dashboard metric artwork, brand marks, visible text buttons, and
 standalone prototypes remain explicit exceptions.

| surface | control / glyph | disposition | implementation rule |
| --- | --- | --- | --- |
| `public/ephemeral-chat-view.js` | attach, commands, model chevron, mic, send, local SVG builders | `migrate-icons.js` | use the shared registry; preserve scoped DOM and labels |
| `public/components/sa-chat-header.js` | sidebar, runtime task-board inline SVG | `migrate-icons.js` | build controls imperatively with the shared registry DOM icons |
| `public/components/super-agent-runtime.js` | close inline SVG; dismiss `✕`; session `→` | `migrate-icons.js` | build task controls imperatively with the shared registry DOM icons; keep text action labels unchanged |
| `public/terminal-panel.js` | terminal restart `↻` | `migrate-icons.js` | use `rotate-cw`; retain restart hit target and title |
| `public/composer-image-attachments.js` | pending-image remove `✕` | `migrate-icons.js` | use `x`; keep image-preview behavior unchanged |
| `public/app.js` | queued-message cancel `×` | `migrate-icons.js` | use `x`; keep queue semantics unchanged |
| `public/sidebar-workspace-group.js` | more fallback `…`; focus fallback `→` | `migrate-icons.js` | registry is authoritative; no Unicode fallback |
| `public/sidebar/build-session-item.js` | rename fallback `✎` | `migrate-icons.js` | use `pencil`; no Unicode fallback |
| `public/sidebar/index.js` | search-result rename `✎` and local icon factory | `migrate-icons.js` | use shared registry; search match emoji remains non-interactive status decoration |
| `public/sidebar/workspace-focus-sidebar.js` | back `‹` | `migrate-icons.js` | use `chevron-left`; keep visible Back label |
| `public/settings/editors.js` | provider disclosure `▼` fallback | `migrate-icons.js` | use `chevron-down`; no Unicode fallback |
| `public/ui/skill-slash-command.js` | skill cube inline SVG | `migrate-icons.js` | use a shared `box` action/object-neutral glyph |
| `public/cost/infobar.js` | dashboard metric SVGs | `keep-status-glyph` | display-only dashboard metrics, not button icons |
| `public/file-preview-panel.js` | `●`, `⚠`, `⋯` tab/status marks | `keep-status-dot` | status semantics remain text/badge, not action icons |
| `public/ui/message-renderer.js` / `public/ui/tool-card.js` | history copy/thinking glyphs | `out-of-scope history` | preserve session-history structure and styling |
| `docs/prototypes/*` | contrast samples and prototype emoji | `prototype-only-untouched` | standalone, disconnected, read-only prototypes |

### Round-2 completion criteria

- Every production action glyph in this inventory is created by `public/icons.js`
  or has an explicit exception above.
- DOM-created registry icons share one path definition source across the migrated controls.
- No migrated production action control relies on Unicode glyph fallback.
- Existing IDs, event delegation, labels, focus behavior, and hit targets remain
  unchanged.
