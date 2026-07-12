import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createCodeEditor } from "./code-editor.js";

describe("createCodeEditor", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (container?.parentNode) {
      container.parentNode.removeChild(container);
    }
  });

  test("creates editor with line numbers in preview mode", () => {
    const editor = createCodeEditor({
      container,
      value: "const x = 1;\n",
      readOnly: true,
    });
    // CodeMirror renders line-number gutters.
    const gutters = container.querySelectorAll(".cm-gutters");
    expect(gutters.length).toBeGreaterThan(0);
    editor.destroy();
  });

  test("creates editor with line numbers in edit mode", () => {
    const editor = createCodeEditor({
      container,
      value: "const x = 1;\n",
      readOnly: false,
    });
    const gutters = container.querySelectorAll(".cm-gutters");
    expect(gutters.length).toBeGreaterThan(0);
    editor.destroy();
  });

  test("getValue returns the initial content", () => {
    const editor = createCodeEditor({
      container,
      value: "hello world\n",
    });
    expect(editor.getValue()).toBe("hello world\n");
    editor.destroy();
  });

  test("setValue updates the document", () => {
    const editor = createCodeEditor({
      container,
      value: "old content\n",
    });
    editor.setValue("new content\n");
    expect(editor.getValue()).toBe("new content\n");
    editor.destroy();
  });

  test("onChange fires when content changes", () => {
    let lastValue = null;
    const editor = createCodeEditor({
      container,
      value: "initial\n",
      onChange: (val) => {
        lastValue = val;
      },
    });
    editor.setValue("changed\n");
    expect(lastValue).toBe("changed\n");
    editor.destroy();
  });

  test("goToLine returns false for invalid line", () => {
    const editor = createCodeEditor({
      container,
      value: "line1\nline2\nline3\n",
    });
    expect(editor.goToLine(0)).toBe(false);
    expect(editor.goToLine(-1)).toBe(false);
    expect(editor.goToLine(5)).toBe(false);
    expect(editor.goToLine(1.5)).toBe(false);
    editor.destroy();
  });

  test("goToLine returns true for valid line", () => {
    const editor = createCodeEditor({
      container,
      value: "line1\nline2\nline3\n",
    });
    expect(editor.goToLine(2)).toBe(true);
    editor.destroy();
  });

  test("destroy removes editor DOM", () => {
    const editor = createCodeEditor({
      container,
      value: "test\n",
    });
    expect(container.querySelectorAll(".cm-editor").length).toBe(1);
    editor.destroy();
    // After destroy, the editor DOM should be cleaned up.
    expect(container.querySelectorAll(".cm-editor").length).toBe(0);
  });

  test("calls onViewReady and onViewDestroy lifecycle callbacks", () => {
    let readyCalled = false;
    let destroyCalled = false;
    const editor = createCodeEditor({
      container,
      value: "test\n",
      onViewReady: () => {
        readyCalled = true;
      },
      onViewDestroy: () => {
        destroyCalled = true;
      },
    });
    expect(readyCalled).toBe(true);
    editor.destroy();
    expect(destroyCalled).toBe(true);
  });

  test("setReadOnly toggles editable state without recreating editor", () => {
    const editor = createCodeEditor({
      container,
      value: "test\n",
      readOnly: true,
    });
    // Should not throw
    editor.setReadOnly(false);
    editor.setReadOnly(true);
    expect(editor.getValue()).toBe("test\n");
    editor.destroy();
  });

  test("setWrapLines toggles line wrapping", () => {
    const editor = createCodeEditor({
      container,
      value: "test\n",
      wrapLines: false,
    });
    // Should not throw
    editor.setWrapLines(true);
    editor.setWrapLines(false);
    editor.destroy();
  });

  test("openSearch does not throw", () => {
    const editor = createCodeEditor({
      container,
      value: "test\n",
    });
    expect(() => editor.openSearch()).not.toThrow();
    editor.destroy();
  });
});
