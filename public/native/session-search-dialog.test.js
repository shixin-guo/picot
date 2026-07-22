import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSessionSearchDialog } from "./session-search-dialog.js";

describe("session search dialog", () => {
  let dom;
  let triggerInput;
  let triggerClear;
  let overlay;
  let dialog;
  let input;
  let list;

  beforeEach(() => {
    dom = new JSDOM(`
      <input id="session-search-input" />
      <button id="session-search-clear" class="hidden"></button>
      <div id="session-search-overlay" class="hidden"></div>
      <div id="session-search-dialog" class="hidden">
        <input id="session-search-dialog-input" />
        <div id="session-search-results"></div>
      </div>
    `);
    globalThis.document = dom.window.document;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.requestAnimationFrame = (callback) => callback();
    triggerInput = document.getElementById("session-search-input");
    triggerClear = document.getElementById("session-search-clear");
    overlay = document.getElementById("session-search-overlay");
    dialog = document.getElementById("session-search-dialog");
    input = document.getElementById("session-search-dialog-input");
    list = document.getElementById("session-search-results");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.document;
    delete globalThis.KeyboardEvent;
    delete globalThis.requestAnimationFrame;
  });

  it("shows a Cmd/Ctrl+K hint in the sidebar search placeholder", () => {
    setupSessionSearchDialog({
      triggerInput,
      triggerClear,
      overlay,
      dialog,
      input,
      list,
      getSessions: () => [],
    });

    expect(triggerInput.placeholder).toMatch(/Ctrl\+K|⌘K/);
  });

  it("opens the dialog with the Cmd/Ctrl+K shortcut from anywhere", () => {
    setupSessionSearchDialog({
      triggerInput,
      triggerClear,
      overlay,
      dialog,
      input,
      list,
      getSessions: () => [{ id: "s1", name: "Fix pinyin submit" }],
    });

    document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "k", metaKey: true, cancelable: true }),
    );

    expect(dialog.classList.contains("hidden")).toBe(false);
    expect(overlay.classList.contains("hidden")).toBe(false);
  });

  it("opens a centered dialog from the narrow sidebar search", () => {
    setupSessionSearchDialog({
      triggerInput,
      triggerClear,
      overlay,
      dialog,
      input,
      list,
      getSessions: () => [{ id: "s1", name: "Fix pinyin submit", projectName: "pi-web-ui" }],
    });

    triggerInput.focus();

    expect(dialog.classList.contains("hidden")).toBe(false);
    expect(overlay.classList.contains("hidden")).toBe(false);
    expect(list.textContent).toContain("Fix pinyin submit");
  });

  it("selects the active result with enter and keeps the query", () => {
    const onSelect = vi.fn();
    setupSessionSearchDialog({
      triggerInput,
      triggerClear,
      overlay,
      dialog,
      input,
      list,
      getSessions: () => [
        { id: "s1", name: "Alpha" },
        { id: "s2", name: "Beta" },
      ],
      onSelect,
    });

    triggerInput.value = "beta";
    triggerInput.focus();
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown" }));
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));

    expect(onSelect).toHaveBeenCalledWith({ id: "s2", name: "Beta" }, { query: "beta" });
    expect(triggerInput.value).toBe("beta");
    expect(dialog.classList.contains("hidden")).toBe(true);
  });

  it("closes on document escape without clearing the search input", () => {
    setupSessionSearchDialog({
      triggerInput,
      triggerClear,
      overlay,
      dialog,
      input,
      list,
      getSessions: () => [{ id: "s1", name: "AI task" }],
    });

    triggerInput.value = "AI";
    triggerInput.focus();
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape" }));

    expect(dialog.classList.contains("hidden")).toBe(true);
    expect(overlay.classList.contains("hidden")).toBe(true);
    expect(triggerInput.value).toBe("AI");
  });

  it("clears search without opening the dialog when the clear button is clicked", () => {
    const onQueryChange = vi.fn();
    setupSessionSearchDialog({
      triggerInput,
      triggerClear,
      overlay,
      dialog,
      input,
      list,
      getSessions: () => [{ id: "s1", name: "AI task" }],
      onQueryChange,
    });

    triggerInput.value = "AI";
    triggerClear.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    triggerInput.focus();
    triggerClear.click();

    expect(triggerInput.value).toBe("");
    expect(dialog.classList.contains("hidden")).toBe(true);
    expect(overlay.classList.contains("hidden")).toBe(true);
    expect(onQueryChange).toHaveBeenLastCalledWith("");
  });
});
