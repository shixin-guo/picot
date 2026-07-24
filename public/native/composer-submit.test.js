import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupComposerSubmitHandling } from "./composer-submit.js";

describe("composer submit handling", () => {
  let dom;
  let input;
  let form;
  let onSubmit;
  let controller;

  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM(`
      <form id="chat-form">
        <textarea id="message-input"></textarea>
      </form>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.CompositionEvent = dom.window.CompositionEvent;
    input = document.getElementById("message-input");
    form = document.getElementById("chat-form");
    onSubmit = vi.fn();
    controller = setupComposerSubmitHandling({ input, form, onSubmit });
  });

  afterEach(() => {
    controller.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.KeyboardEvent;
    delete globalThis.CompositionEvent;
  });

  it("submits on Enter outside IME composition", () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });

    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledWith({ altKey: false });
  });

  it("preserves Alt+Enter submit intent", () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true }));

    expect(onSubmit).toHaveBeenCalledWith({ altKey: true });
  });

  it("does not submit while an IME composition is active", () => {
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("does not submit from WebKit's compositionend-confirming Enter sequence", () => {
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.dispatchEvent(new CompositionEvent("compositionend"));

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));

    expect(onSubmit).not.toHaveBeenCalled();

    vi.runOnlyPendingTimers();
    form.dispatchEvent(new Event("submit", { cancelable: true }));

    expect(onSubmit).toHaveBeenCalledWith({ altKey: false });
  });

  it("does not submit for keyCode 229 IME keydown", () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229 }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
