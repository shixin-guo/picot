// Vendor bundle entry for CodeMirror.
// Bundled by scripts/build-frontend.js into public/vendor/codemirror.js.
// The browser import map maps @codemirror/* specifiers to this file.

export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
export { css } from "@codemirror/lang-css";
export { html } from "@codemirror/lang-html";
export { javascript } from "@codemirror/lang-javascript";
export { json } from "@codemirror/lang-json";
export { markdown } from "@codemirror/lang-markdown";
export { python } from "@codemirror/lang-python";
export { yaml } from "@codemirror/lang-yaml";
export {
  forceParsing,
  HighlightStyle,
  indentUnit,
  Language,
  LanguageDescription,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
export { r } from "@codemirror/legacy-modes/mode/r";
export { shell } from "@codemirror/legacy-modes/mode/shell";
export {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
export {
  Compartment,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from "@codemirror/state";
export {
  Decoration,
  EditorView,
  gutters,
  keymap,
  lineNumbers,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
