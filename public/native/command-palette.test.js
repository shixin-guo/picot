import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupCommandPalette } from "./command-palette.js";

describe("command palette", () => {
  let dom;
  let button;
  let palette;
  let overlay;
  let list;

  beforeEach(() => {
    dom = new JSDOM(`
      <button id="command-btn" type="button"></button>
      <div id="command-palette-overlay" class="hidden"></div>
      <div id="command-palette" class="hidden"><div id="command-list"></div></div>
    `);
    globalThis.document = dom.window.document;
    globalThis.KeyboardEvent = dom.window.KeyboardEvent;
    button = document.getElementById("command-btn");
    palette = document.getElementById("command-palette");
    overlay = document.getElementById("command-palette-overlay");
    list = document.getElementById("command-list");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.document;
    delete globalThis.KeyboardEvent;
  });

  it("opens command actions from the command button", () => {
    const action = vi.fn();
    setupCommandPalette({
      button,
      palette,
      overlay,
      list,
      commands: [{ icon: "⚙️", label: "Settings", desc: "Open settings", action }],
    });

    button.click();

    expect(palette.classList.contains("hidden")).toBe(false);
    expect(list.textContent).toContain("Settings");

    list.querySelector(".command-item").click();

    expect(action).toHaveBeenCalledTimes(1);
    expect(palette.classList.contains("hidden")).toBe(true);
  });
});
