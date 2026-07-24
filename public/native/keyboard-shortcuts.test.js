import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupAppKeyboardShortcuts } from "./keyboard-shortcuts.js";

describe("app keyboard shortcuts", () => {
  let dom;
  let input;

  beforeEach(() => {
    dom = new JSDOM(`
      <div id="settings-panel" class="hidden"></div>
      <div id="model-dropdown-menu" class="hidden"></div>
      <textarea id="message-input"></textarea>
      <button id="other-button"></button>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    input = document.getElementById("message-input");
  });

  afterEach(() => {
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.KeyboardEvent;
  });

  it("focuses the composer with / when focus is outside editable controls", () => {
    document.getElementById("other-button").focus();
    setupAppKeyboardShortcuts({ input, abort: vi.fn(), isWorking: () => false });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", cancelable: true }));

    expect(document.activeElement).toBe(input);
  });

  it("does not steal / from editable controls", () => {
    const abort = vi.fn();
    input.focus();
    setupAppKeyboardShortcuts({ input, abort, isWorking: () => false });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "/", cancelable: true }));

    expect(document.activeElement).toBe(input);
    expect(abort).not.toHaveBeenCalled();
  });

  it("aborts the running agent with Escape", () => {
    const abort = vi.fn();
    setupAppKeyboardShortcuts({ input, abort, isWorking: () => true });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not abort Escape when an overlay owns the key", () => {
    document.getElementById("settings-panel").classList.remove("hidden");
    const abort = vi.fn();
    setupAppKeyboardShortcuts({ input, abort, isWorking: () => true });

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

    expect(abort).not.toHaveBeenCalled();
  });
});
