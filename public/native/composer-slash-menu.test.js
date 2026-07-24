import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeSlashQuery,
  setupComposerSlashMenu,
  titleCaseCommandName,
} from "./composer-slash-menu.js";

describe("composer slash menu", () => {
  let dom;
  let input;
  let menu;

  beforeEach(() => {
    dom = new JSDOM(`
      <textarea id="message-input"></textarea>
      <button id="command-btn" type="button"></button>
      <div id="skill-slash-menu" class="hidden"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.queueMicrotask = (callback) => callback();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    input = document.getElementById("message-input");
    menu = document.getElementById("skill-slash-menu");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.Event;
    delete globalThis.KeyboardEvent;
    delete globalThis.queueMicrotask;
  });

  it("recognizes slash queries at the start of the composer", () => {
    input.value = "/skill:res";
    input.setSelectionRange(input.value.length, input.value.length);
    expect(activeSlashQuery(input)).toEqual({ query: "skill:res", end: 10 });

    input.value = "please /skill:res";
    input.setSelectionRange(input.value.length, input.value.length);
    expect(activeSlashQuery(input)).toBeNull();
  });

  it("inserts selected skill commands", async () => {
    const formSubmit = vi.fn();
    input.form?.addEventListener("submit", formSubmit);
    const controller = setupComposerSlashMenu({
      input,
      container: menu,
      getCommands: () => [
        { name: "settings", description: "Open settings", type: "builtin", scope: "picot" },
        {
          name: "skill:research",
          description: "Investigate primary sources",
          type: "skill",
          scope: "user",
        },
      ],
    });

    input.value = "/";
    input.setSelectionRange(input.value.length, input.value.length);
    await controller.update();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

    expect(input.value).toBe("/skill:research ");
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(formSubmit).not.toHaveBeenCalled();
  });

  it("filters skills while typing a slash query", async () => {
    const controller = setupComposerSlashMenu({
      input,
      container: menu,
      getCommands: () => [
        { name: "skill:code-review", description: "Review a diff", type: "skill", scope: "user" },
        {
          name: "skill:research",
          description: "Investigate primary sources",
          type: "skill",
          scope: "project",
        },
      ],
    });

    input.value = "/res";
    input.setSelectionRange(input.value.length, input.value.length);
    await controller.update();

    expect(menu.classList.contains("hidden")).toBe(false);
    expect(menu.querySelectorAll(".skill-slash-option")).toHaveLength(1);
    expect(menu.textContent).toContain("Research");
    expect(menu.textContent).toContain("Project");
  });

  it("formats command names for display", () => {
    expect(titleCaseCommandName("skill:code-review")).toBe("Code Review");
  });
});
