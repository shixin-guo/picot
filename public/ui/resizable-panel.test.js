// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { setupResizablePanel } from "./resizable-panel.js";

describe("setupResizablePanel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("adds a left-edge resize handle and persists the dragged width", () => {
    const panel = document.createElement("aside");
    panel.className = "app-side-panel";
    document.body.appendChild(panel);

    setupResizablePanel(panel, {
      storageKey: "test-panel-width",
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 520,
    });

    const handle = panel.querySelector(".app-side-panel-resize-handle");
    expect(handle).not.toBeNull();
    expect(panel.style.getPropertyValue("--panel-width")).toBe("320px");

    handle.dispatchEvent(new MouseEvent("pointerdown", { clientX: 700, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 620, bubbles: true }));
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));

    expect(panel.style.getPropertyValue("--panel-width")).toBe("400px");
    expect(localStorage.getItem("test-panel-width")).toBe("400");
  });

  it("restores a stored width and clamps it to the configured bounds", () => {
    localStorage.setItem("test-panel-width", "900");
    const panel = document.createElement("aside");
    document.body.appendChild(panel);

    setupResizablePanel(panel, {
      storageKey: "test-panel-width",
      defaultWidth: 320,
      minWidth: 280,
      maxWidth: 520,
    });

    expect(panel.style.getPropertyValue("--panel-width")).toBe("520px");
  });
});
