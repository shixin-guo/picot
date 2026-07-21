/**
 * CodeMirror editor lifecycle wrapper.
 *
 * Creates and manages a single CodeMirror instance with line numbers,
 * configurable read-only/editable mode, line wrapping, search, and
 * go-to-line support. The EditorView ref is private; callers interact
 * through the returned API object.
 *
 * Source imports @codemirror/* directly — Vitest resolves from node_modules;
 * the browser import map redirects to vendor bundles at runtime.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { languageExtensionForPath } from "./file-language.js";
import { getLocale, onLocaleChange } from "./i18n.js";

const SEARCH_PHRASES = {
  zh: {
    Find: "查找",
    Replace: "替换",
    next: "下一个",
    previous: "上一个",
    all: "全部",
    "match case": "区分大小写",
    regexp: "正则表达式",
    "by word": "全词匹配",
    replace: "替换",
    "replace all": "全部替换",
    close: "关闭",
    "current match": "当前匹配项",
    "replaced match on line $": "已替换第 $ 行的匹配项",
    "replaced $ matches": "已替换 $ 个匹配项",
    "Go to line": "跳转到行",
    go: "跳转",
  },
};

function searchPhrasesForLocale(locale) {
  return SEARCH_PHRASES[locale] || {};
}

export function createCodeEditor({
  container,
  value = "",
  filePath,
  readOnly = true,
  wrapLines = false,
  onChange,
  onViewReady,
  onViewDestroy,
} = {}) {
  if (!container) throw new Error("container is required");

  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const languageCompartment = new Compartment();
  const searchPhrasesCompartment = new Compartment();
  const languageExt = languageExtensionForPath(filePath || "");
  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    search(),
    keymap.of(searchKeymap),
    editableCompartment.of(EditorView.editable.of(!readOnly)),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    searchPhrasesCompartment.of(EditorState.phrases.of(searchPhrasesForLocale(getLocale()))),
    wrapCompartment.of(wrapLines ? EditorView.lineWrapping : []),
    languageCompartment.of(languageExt ? [languageExt] : []),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && typeof onChange === "function") {
        onChange(update.state.doc.toString());
      }
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions,
    }),
    parent: container,
  });

  const unsubscribeLocale = onLocaleChange((locale) => {
    view.dispatch({
      effects: searchPhrasesCompartment.reconfigure(
        EditorState.phrases.of(searchPhrasesForLocale(locale)),
      ),
    });
  });

  if (typeof onViewReady === "function") {
    onViewReady(view);
  }

  return {
    getValue() {
      return view.state.doc.toString();
    },

    setValue(newValue) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: newValue,
        },
      });
    },

    focus() {
      view.focus();
    },

    openSearch() {
      openSearchPanel(view);
    },

    closeSearch() {
      closeSearchPanel(view);
    },

    /**
     * Scroll to and select a specific line number (1-indexed).
     * Returns true if the line exists, false otherwise.
     */
    goToLine(lineNumber) {
      if (!Number.isInteger(lineNumber) || lineNumber < 1) return false;
      const lineCount = view.state.doc.lines;
      if (lineNumber > lineCount) return false;
      const line = view.state.doc.line(lineNumber);
      view.dispatch({
        selection: { anchor: line.from, head: line.to },
        scrollIntoView: true,
      });
      view.focus();
      return true;
    },

    setReadOnly(newReadOnly) {
      view.dispatch({
        effects: [
          editableCompartment.reconfigure(EditorView.editable.of(!newReadOnly)),
          readOnlyCompartment.reconfigure(EditorState.readOnly.of(newReadOnly)),
        ],
      });
    },

    setWrapLines(enabled) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []),
      });
    },

    destroy() {
      unsubscribeLocale();
      if (typeof onViewDestroy === "function") {
        onViewDestroy();
      }
      view.destroy();
    },

    get view() {
      return view;
    },
  };
}
