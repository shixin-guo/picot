import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeHashQuery, matchAgents, setupComposerAgentMenu } from "./composer-agent-menu.js";

const AGENTS = [
  { id: "claude-code", token: "claude", label: "Claude Code", description: "Delegate a task via ACP" },
];

describe("composer agent menu", () => {
  let dom;
  let input;
  let menu;

  beforeEach(() => {
    dom = new JSDOM(`
      <form id="composer-form">
        <textarea id="message-input"></textarea>
      </form>
      <div id="agent-picker-menu" class="hidden"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    globalThis.queueMicrotask = (callback) => callback();
    dom.window.HTMLElement.prototype.scrollIntoView = vi.fn();
    input = document.getElementById("message-input");
    menu = document.getElementById("agent-picker-menu");
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

  it("recognizes hash queries only at the start of the composer", () => {
    input.value = "#cla";
    input.setSelectionRange(input.value.length, input.value.length);
    expect(activeHashQuery(input)).toEqual({ query: "cla", end: 4 });

    input.value = "please #cla";
    input.setSelectionRange(input.value.length, input.value.length);
    expect(activeHashQuery(input)).toBeNull();
  });

  it("filters agents by id, label, or description", () => {
    expect(matchAgents(AGENTS, "claude")).toEqual([AGENTS[0]]);
    expect(matchAgents(AGENTS, "acp")).toEqual([AGENTS[0]]);
    expect(matchAgents(AGENTS, "")).toEqual(AGENTS);
    expect(matchAgents(AGENTS, "nope")).toEqual([]);
  });

  it("inserts a `#<token> ` prefix and keeps the rest of the line on click", async () => {
    const onSelect = vi.fn();
    const controller = setupComposerAgentMenu({
      input,
      container: menu,
      getAgents: () => AGENTS,
      onSelect,
    });

    input.value = "#cla";
    input.setSelectionRange(input.value.length, input.value.length);
    await controller.update();

    const options = menu.querySelectorAll(".skill-slash-option");
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("Claude Code");

    options[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith(AGENTS[0]);
    expect(input.value).toBe("#claude ");
    expect(input.selectionStart).toBe("#claude ".length);
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  it("closes without selecting on Escape", async () => {
    const onSelect = vi.fn();
    const controller = setupComposerAgentMenu({
      input,
      container: menu,
      getAgents: () => AGENTS,
      onSelect,
    });

    input.value = "#";
    input.setSelectionRange(input.value.length, input.value.length);
    await controller.update();
    expect(menu.classList.contains("hidden")).toBe(false);

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
