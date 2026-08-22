import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupSettingsToggles } from "./settings-toggles.js";

describe("setupSettingsToggles", () => {
  let container;

  beforeEach(() => {
    // Clear localStorage
    localStorage.clear();

    // Clear body dataset
    delete document.body.dataset.autoCompact;
    delete document.body.dataset.showThinking;

    // Setup DOM
    document.body.innerHTML = "";
    container = document.createElement("div");
    container.innerHTML = `
      <button class="settings-toggle" id="toggle-auto-compact"></button>
      <button class="settings-toggle on" id="toggle-show-thinking"></button>
      <button class="settings-toggle" id="toggle-task-notifications"></button>
      <button class="settings-toggle" id="toggle-beta-updates"></button>
    `;
    document.body.appendChild(container);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("initializes toggles with default values", () => {
    setupSettingsToggles();

    const autoCompactBtn = document.getElementById("toggle-auto-compact");
    const showThinkingBtn = document.getElementById("toggle-show-thinking");
    const taskNotificationsBtn = document.getElementById("toggle-task-notifications");
    const betaBtn = document.getElementById("toggle-beta-updates");

    expect(autoCompactBtn.classList.contains("on")).toBe(true);
    expect(showThinkingBtn.classList.contains("on")).toBe(true);
    expect(taskNotificationsBtn.classList.contains("on")).toBe(true);

    expect(autoCompactBtn.getAttribute("aria-checked")).toBe("true");
    expect(showThinkingBtn.getAttribute("aria-checked")).toBe("true");
    expect(taskNotificationsBtn.getAttribute("aria-checked")).toBe("true");
    expect(betaBtn.classList.contains("on")).toBe(false);
    expect(betaBtn.getAttribute("aria-checked")).toBe("false");
  });

  it("loads state from localStorage", () => {
    localStorage.setItem("picot-settings-auto-compact", "true");
    localStorage.setItem("picot-settings-show-thinking", "false");

    setupSettingsToggles();

    const autoCompactBtn = document.getElementById("toggle-auto-compact");
    const showThinkingBtn = document.getElementById("toggle-show-thinking");

    expect(autoCompactBtn.classList.contains("on")).toBe(true);
    expect(showThinkingBtn.classList.contains("on")).toBe(false);
  });

  it("persists auto-compaction to config on click", async () => {
    const configGateway = { call: vi.fn().mockResolvedValue({ ok: true }) };
    const control = setupSettingsToggles({ configGateway });

    const autoCompactBtn = document.getElementById("toggle-auto-compact");
    expect(autoCompactBtn.classList.contains("on")).toBe(true);

    autoCompactBtn.click();
    await vi.waitFor(() => {
      expect(configGateway.call).toHaveBeenCalledWith("set_default_auto_compaction", {
        enabled: false,
        scope: "global",
      });
    });

    expect(autoCompactBtn.classList.contains("on")).toBe(false);
    expect(autoCompactBtn.getAttribute("aria-checked")).toBe("false");
    expect(localStorage.getItem("picot-settings-auto-compact")).toBeNull();
    expect(control.getToggleState("auto-compact")).toBe(false);
  });

  it("applies onChange callbacks", () => {
    setupSettingsToggles();

    const showThinkingBtn = document.getElementById("toggle-show-thinking");

    // Initially on
    expect(document.body.dataset.showThinking).toBe("on");

    // Toggle off
    showThinkingBtn.click();
    expect(document.body.dataset.showThinking).toBe("off");

    // Toggle back on
    showThinkingBtn.click();
    expect(document.body.dataset.showThinking).toBe("on");
  });

  it("provides getToggleState API", () => {
    localStorage.setItem("picot-settings-auto-compact", "true");
    const control = setupSettingsToggles();

    expect(control.getToggleState("auto-compact")).toBe(true);
    expect(control.getToggleState("show-thinking")).toBe(true); // default
    expect(control.getToggleState("task-notifications")).toBe(true); // default
    expect(control.getToggleState("beta-updates")).toBe(false); // default
  });

  it("persists beta update channel changes", () => {
    const control = setupSettingsToggles();
    const betaBtn = document.getElementById("toggle-beta-updates");
    const channelChanged = vi.fn();
    window.addEventListener("picot-update-channel-changed", channelChanged);

    betaBtn.click();

    expect(localStorage.getItem("picot-settings-beta-updates")).toBe("true");
    expect(control.getToggleState("beta-updates")).toBe(true);
    expect(channelChanged).toHaveBeenCalledOnce();
    expect(channelChanged.mock.calls[0][0].detail).toEqual({ beta: true });
    window.removeEventListener("picot-update-channel-changed", channelChanged);
  });

  it("provides setToggleState API", () => {
    const control = setupSettingsToggles();

    control.setToggleState("auto-compact", true);

    const autoCompactBtn = document.getElementById("toggle-auto-compact");
    expect(autoCompactBtn.classList.contains("on")).toBe(true);
    expect(localStorage.getItem("picot-settings-auto-compact")).toBeNull();
    expect(document.body.dataset.autoCompact).toBe("on");
  });

  it("handles missing toggle elements gracefully", () => {
    document.body.innerHTML = "";
    expect(() => setupSettingsToggles()).not.toThrow();
  });
});
