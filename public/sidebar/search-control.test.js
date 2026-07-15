import { JSDOM } from "jsdom";
import { describe, expect, test, vi } from "vitest";
import { setupSidebarSearchControl } from "./search-control.js";

describe("setupSidebarSearchControl", () => {
  test("shows clear button when input has text and clears through the same change path", () => {
    const dom = new JSDOM(
      `
        <div>
          <input id="search" type="text" />
          <button id="clear" type="button" class="hidden"></button>
        </div>
      `,
      { url: "http://localhost" },
    );
    globalThis.document = dom.window.document;

    const input = document.getElementById("search");
    const clearButton = document.getElementById("clear");
    const onChange = vi.fn();

    setupSidebarSearchControl({ input, clearButton, onChange });

    expect(clearButton.classList.contains("hidden")).toBe(true);

    input.value = "alpha";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

    expect(onChange).toHaveBeenLastCalledWith("alpha");
    expect(clearButton.classList.contains("hidden")).toBe(false);

    clearButton.click();

    expect(input.value).toBe("");
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(clearButton.classList.contains("hidden")).toBe(true);
  });
});
