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
  const wrapCompartment = new Compartment();
  const languageCompartment = new Compartment();

  const languageExt = languageExtensionForPath(filePath || "");
  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    search(),
    keymap.of(searchKeymap),
    editableCompartment.of(EditorView.editable.of(!readOnly)),
    EditorState.readOnly.of(readOnly),
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
        effects: editableCompartment.reconfigure(EditorView.editable.of(!newReadOnly)),
      });
    },

    setWrapLines(enabled) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []),
      });
    },

    destroy() {
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
