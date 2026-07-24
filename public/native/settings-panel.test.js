import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setupSettingsPanel } from "./settings-panel.js";

function renderSettingsDom() {
  document.body.innerHTML = `
    <button id="settings-btn"></button>
    <div class="settings-overlay hidden" id="settings-overlay"></div>
    <div class="settings-panel hidden" id="settings-panel">
      <aside class="settings-nav">
        <button class="settings-nav-item active" data-settings-tab="general">General</button>
        <button class="settings-nav-item" data-settings-tab="extensions">Extensions</button>
        <button class="settings-nav-item" data-settings-tab="usage">Usage</button>
        <button class="settings-nav-item" data-settings-tab="configuration">Configuration</button>
        <button class="settings-nav-back" id="settings-close">Back</button>
      </aside>
      <section class="settings-content">
        <div class="settings-tab active" data-settings-panel="general"></div>
        <div class="settings-tab" data-settings-panel="extensions"></div>
        <div class="settings-tab" data-settings-panel="usage"></div>
        <div class="settings-tab" data-settings-panel="configuration"></div>
      </section>
    </div>
  `;
}

describe("settings panel hash routing", () => {
  beforeEach(() => {
    renderSettingsDom();
    history.replaceState(null, "", "/app/workspaces/workspace-a/sessions/session-a");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState(null, "", "/app/workspaces/workspace-a/sessions/session-a");
  });

  it("writes #/settings/<tab> to the URL hash when a tab is opened", () => {
    const panel = setupSettingsPanel();
    panel.openSettings("usage");

    expect(window.location.hash).toBe("#/settings/usage");
    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(false);
  });

  it("clears the hash when settings is closed", () => {
    const panel = setupSettingsPanel();
    panel.openSettings("general");
    panel.closeSettings();

    expect(window.location.hash).toBe("");
    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(true);
  });

  it("reopens the settings panel on the saved tab when the hash is already present at load", () => {
    // Simulates a page refresh: the hash survives reload, so setup must
    // restore settings-open state instead of leaving the user on chat.
    window.location.hash = "#/settings/configuration";

    setupSettingsPanel();

    const panel = document.getElementById("settings-panel");
    expect(panel.classList.contains("hidden")).toBe(false);
    const configTab = document.querySelector('[data-settings-panel="configuration"]');
    expect(configTab.classList.contains("active")).toBe(true);
  });

  it("falls back to the general tab for an unknown hash tab key", () => {
    window.location.hash = "#/settings/does-not-exist";

    setupSettingsPanel();

    const generalTab = document.querySelector('[data-settings-panel="general"]');
    expect(generalTab.classList.contains("active")).toBe(true);
  });

  it("responds to hashchange events fired after setup (e.g. back/forward navigation)", () => {
    setupSettingsPanel();
    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(true);

    window.location.hash = "#/settings/extensions";
    window.dispatchEvent(new HashChangeEvent("hashchange"));

    expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(false);
    const extensionsTab = document.querySelector('[data-settings-panel="extensions"]');
    expect(extensionsTab.classList.contains("active")).toBe(true);
  });
});
