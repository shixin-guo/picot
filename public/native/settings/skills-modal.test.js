// @vitest-environment jsdom

// ABOUTME: Verifies the shared Skills modal-dialog focus management helper:
// ABOUTME: focus trap, Escape-to-cancel, background inert, and focus restoration.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { manageModalDialog } from "./skills-modal.js";

describe("manageModalDialog", () => {
  let container;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.replaceChildren(container);
  });

  function mountDialog() {
    const bg = document.createElement("button");
    bg.id = "bg";
    bg.textContent = "background";
    container.appendChild(bg);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    const first = document.createElement("button");
    first.id = "first";
    first.textContent = "first";
    const last = document.createElement("button");
    last.id = "last";
    last.textContent = "last";
    dialog.append(first, last);
    container.appendChild(dialog);
    return { bg, dialog, first, last };
  }

  it("inerts background siblings and moves focus to initialFocus on open", () => {
    const { bg, dialog, first } = mountDialog();
    manageModalDialog(dialog, { initialFocus: first });
    expect(bg.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("wraps Tab forward from the last focusable back to the first", () => {
    const { dialog, first, last } = mountDialog();
    manageModalDialog(dialog, { initialFocus: last });
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab backward from the first focusable to the last", () => {
    const { dialog, first, last } = mountDialog();
    manageModalDialog(dialog, { initialFocus: first });
    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(document.activeElement).toBe(last);
  });

  it("invokes onCancel on Escape", () => {
    const onCancel = vi.fn();
    const { dialog, first } = mountDialog();
    manageModalDialog(dialog, { initialFocus: first, onCancel });
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("inerts all background branches up to inertRoot", () => {
    const outside = document.createElement("button");
    const panel = document.createElement("div");
    container.append(outside, panel);
    const { dialog } = mountDialog();
    panel.appendChild(dialog);
    manageModalDialog(dialog, { inertRoot: container });
    expect(outside.hasAttribute("inert")).toBe(true);
  });

  it("removes inert and restores focus through a post-render resolver", () => {
    const { bg, dialog, first } = mountDialog();
    let opener = document.createElement("button");
    opener.id = "opener";
    container.appendChild(opener);
    manageModalDialog(dialog, { initialFocus: first, restoreFocusTo: () => opener });
    // Simulate a rendering pass replacing the old opener before cleanup.
    opener.remove();
    opener = document.createElement("button");
    container.appendChild(opener);
    manageModalDialog(null); // close
    expect(bg.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});
