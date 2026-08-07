// ABOUTME: Tests the accessible shell coordinating the three Skills setting tabs.
// ABOUTME: Verifies tab order, keyboard selection, lazy activation, and persistent panels.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupSkillsTabShell } from "./skills-tab-shell.js";

function createTab(name, active = false) {
  const tab = document.createElement("button");
  tab.dataset.skillsPageTab = name;
  if (active) tab.classList.add("active");
  return tab;
}

describe("Skills tab shell", () => {
  let tabs;
  let panels;
  let activate;

  beforeEach(() => {
    tabs = [createTab("discovered", true), createTab("install"), createTab("packages")];
    document.body.replaceChildren(...tabs);
    panels = Object.fromEntries(
      tabs.map((tab) => [tab.dataset.skillsPageTab, document.createElement("section")]),
    );
    activate = vi.fn();
  });

  it("selects tabs with roving tabindex and lazy activation", () => {
    setupSkillsTabShell({ tabs, panels, activate });
    tabs[1].click();
    expect(activate).toHaveBeenCalledWith("install");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(-1);
    expect(tabs[1].tabIndex).toBe(0);
    expect(panels.discovered.classList.contains("hidden")).toBe(true);
    expect(panels.install.classList.contains("hidden")).toBe(false);
  });

  it("moves through the exact three-tab order with keyboard navigation", () => {
    setupSkillsTabShell({ tabs, panels, activate });
    tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(activate).toHaveBeenCalledWith("install");
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End" }));
    expect(activate).toHaveBeenLastCalledWith("packages");
    expect(document.activeElement).toBe(tabs[2]);
  });
});
