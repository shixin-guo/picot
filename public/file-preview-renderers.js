/**
 * File preview renderer factory.
 *
 * Creates the appropriate renderer based on file classification.
 * Each renderer follows the interface: mount(container), update(props), destroy().
 * Text/code renderers expose getValue() for dirty-state extraction.
 */

import { createCodeEditor } from "./code-editor.js";
import { classifyFilePath } from "./file-language.js";
import { createPdfRenderer } from "./file-pdf-preview.js";
import { attachCopyButtonDelegation, renderFileMarkdown } from "./file-preview-markdown.js";

export function createFileRenderer({
  filePath,
  fileName,
  content,
  mode = "preview",
  readOnly = true,
  wrapLines = false,
  onChange,
  onModeChange,
  onError,
} = {}) {
  const classification = classifyFilePath(filePath || "");

  switch (classification.contentType) {
    case "markdown":
      return createMarkdownRenderer({
        filePath,
        content,
        mode,
        readOnly,
        wrapLines,
        onChange,
        onModeChange,
        onError,
      });

    case "image":
      return createImageRenderer({ filePath, fileName });

    case "pdf":
      return createPdfRenderer({ filePath, onError });

    case "text":
      return createTextRenderer({
        filePath,
        content,
        readOnly,
        wrapLines,
        onChange,
        onError,
      });

    default:
      return createTextRenderer({
        filePath,
        content,
        readOnly: true,
        wrapLines,
        onChange,
        onError,
      });
  }
}

// ─── Markdown renderer ──────────────────────────────────────────────────

function createMarkdownRenderer({
  filePath,
  content,
  mode = "preview",
  wrapLines = false,
  onChange,
  onModeChange,
  onError,
}) {
  let editor = null;
  let cleanupCopy = null;
  let mountedContainer = null;
  let currentMode = mode;
  let currentContent = content || "";
  let currentWrap = wrapLines;

  return {
    mount(container) {
      mountedContainer = container;
      renderCurrent(container);
    },
    update(props) {
      const modeChanged = props.mode !== undefined && props.mode !== currentMode;
      if (props.mode !== undefined) currentMode = props.mode;
      if (props.content !== undefined) currentContent = props.content;
      if (props.wrapLines !== undefined) currentWrap = props.wrapLines;

      if (modeChanged && mountedContainer) {
        // Re-render on mode change.
        if (cleanupCopy) {
          cleanupCopy();
          cleanupCopy = null;
        }
        if (editor) {
          currentContent = editor.getValue();
          editor.destroy();
          editor = null;
        }
        renderCurrent(mountedContainer);
      }
    },

    destroy() {
      if (cleanupCopy) {
        cleanupCopy();
        cleanupCopy = null;
      }
      if (editor) {
        editor.destroy();
        editor = null;
      }
      mountedContainer = null;
    },

    getValue() {
      if (editor) return editor.getValue();
      return currentContent;
    },

    getMode() {
      return currentMode;
    },

    setMode(newMode, container) {
      if (currentMode === newMode) return;
      currentMode = newMode;

      // Clean up previous renderer.
      if (cleanupCopy) {
        cleanupCopy();
        cleanupCopy = null;
      }
      if (editor) {
        currentContent = editor.getValue();
        editor.destroy();
        editor = null;
      }

      renderCurrent(container);
      if (typeof onModeChange === "function") {
        onModeChange(newMode);
      }
    },

    openSearch() {
      editor?.openSearch();
    },

    goToLine(lineNumber) {
      return editor?.goToLine(lineNumber) ?? false;
    },

    setWrapLines(enabled) {
      currentWrap = enabled;
      editor?.setWrapLines(enabled);
    },

    get contentType() {
      return "markdown";
    },
  };

  function renderCurrent(container) {
    if (!container) return;

    if (currentMode === "preview") {
      container.innerHTML = "";
      const frag = renderFileMarkdown(currentContent);
      const mdDiv = document.createElement("div");
      mdDiv.className = "file-markdown-preview";
      mdDiv.appendChild(frag);
      container.appendChild(mdDiv);
      cleanupCopy = attachCopyButtonDelegation(mdDiv);
    } else {
      // Edit mode: use CodeMirror.
      container.innerHTML = "";
      const editorDiv = document.createElement("div");
      editorDiv.className = "file-code-editor";
      container.appendChild(editorDiv);

      editor = createCodeEditor({
        container: editorDiv,
        value: currentContent,
        filePath,
        readOnly: false,
        wrapLines: currentWrap,
        onChange: (val) => {
          currentContent = val;
          if (typeof onChange === "function") onChange(val);
        },
        onError,
      });
    }
  }
}

// ─── Text/code renderer ─────────────────────────────────────────────────

function createTextRenderer({
  filePath,
  content,
  readOnly = true,
  wrapLines = false,
  onChange,
  onError,
}) {
  let editor = null;
  let _containerRef = null;
  let currentReadOnly = readOnly;
  let currentWrap = wrapLines;

  return {
    mount(container) {
      _containerRef = container;
      container.innerHTML = "";
      const editorDiv = document.createElement("div");
      editorDiv.className = "file-code-editor";
      container.appendChild(editorDiv);

      editor = createCodeEditor({
        container: editorDiv,
        value: content || "",
        filePath,
        readOnly: currentReadOnly,
        wrapLines: currentWrap,
        onChange,
        onError,
      });
    },

    update(props) {
      if (props.readOnly !== undefined && props.readOnly !== currentReadOnly) {
        currentReadOnly = props.readOnly;
        if (editor) editor.setReadOnly(currentReadOnly);
      }
      if (props.wrapLines !== undefined && props.wrapLines !== currentWrap) {
        currentWrap = props.wrapLines;
        if (editor) editor.setWrapLines(currentWrap);
      }
    },

    destroy() {
      if (editor) {
        editor.destroy();
        editor = null;
      }
      _containerRef = null;
    },

    getValue() {
      if (editor) return editor.getValue();
      return content || "";
    },

    getEditor() {
      return editor;
    },

    openSearch() {
      editor?.openSearch();
    },

    goToLine(lineNumber) {
      return editor?.goToLine(lineNumber) ?? false;
    },

    setWrapLines(enabled) {
      currentWrap = enabled;
      editor?.setWrapLines(enabled);
    },

    get contentType() {
      return "text";
    },
  };
}

// ─── Image renderer ─────────────────────────────────────────────────────

function createImageRenderer({ filePath, fileName }) {
  let imgEl = null;
  let containerEl = null;

  return {
    mount(container) {
      container.innerHTML = "";
      containerEl = document.createElement("div");
      containerEl.className = "file-image-preview";

      imgEl = document.createElement("img");
      imgEl.className = "file-image-img";
      imgEl.alt = fileName || filePath || "";
      imgEl.src = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
      imgEl.onerror = () => {
        if (containerEl) {
          containerEl.classList.add("file-image-error");
        }
      };

      containerEl.appendChild(imgEl);
      container.appendChild(containerEl);
    },

    update() {
      // Images have no props to update.
    },

    destroy() {
      if (imgEl) {
        imgEl.src = "";
        imgEl = null;
      }
      if (containerEl?.parentNode) {
        containerEl.parentNode.removeChild(containerEl);
      }
      containerEl = null;
    },

    get contentType() {
      return "image";
    },
  };
}
