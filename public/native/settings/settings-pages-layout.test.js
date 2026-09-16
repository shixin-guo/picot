// ABOUTME: Asserts the Settings page split between Advanced Configuration and Models.
// ABOUTME: Locks navigation, panel placement, activation routing, and locale titles.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

describe("settings page split", () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const settingsPanelJs = readFileSync(
    join(process.cwd(), "public/native/settings/settings-panel.js"),
    "utf8",
  );

  test("adds a Models navigation entry", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    expect(document.querySelector('[data-settings-tab="models"]')).not.toBeNull();
    expect(document.querySelector('[data-settings-tab="models"]').dataset.i18n).toBe(
      "settings.models.title",
    );
    expect(document.querySelector('[data-settings-panel="models"]')).not.toBeNull();
  });

  test("owns theme and display controls in a dedicated Appearance panel", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    const appearanceTab = document.querySelector('[data-settings-tab="appearance"]');
    expect(appearanceTab).not.toBeNull();
    expect(appearanceTab.dataset.i18n).toBe("settings.appearance");
    const general = document.querySelector('[data-settings-panel="general"]');
    const appearance = document.querySelector('[data-settings-panel="appearance"]');
    expect(appearance).not.toBeNull();
    // Theme grid moves out of General; language and Agent rows stay.
    expect(appearance.querySelector("#theme-grid")).not.toBeNull();
    expect(general.querySelector("#theme-grid")).toBeNull();
    expect(general.querySelector("#setting-language")).not.toBeNull();
    expect(general.querySelector("#toggle-auto-compact")).not.toBeNull();
    // Chat / preview / terminal display controls live on the Appearance page.
    expect(appearance.querySelector("#settings-chat-font-size")).not.toBeNull();
    expect(appearance.querySelector("#settings-preview-theme-select")).not.toBeNull();
    expect(appearance.querySelector("#settings-preview-font-size")).not.toBeNull();
    expect(appearance.querySelector("#settings-terminal-theme-select")).not.toBeNull();
    expect(appearance.querySelector("#settings-terminal-font-size")).not.toBeNull();
    expect(appearance.querySelector("#settings-terminal-scrollback-input")).not.toBeNull();
    expect(appearance.querySelector("#settings-terminal-smooth-scroll-input")).not.toBeNull();
    expect(appearance.querySelector("#toggle-terminal-webgl")).not.toBeNull();
    // Nav order: Appearance sits right after General.
    const tabs = [...document.querySelectorAll(".settings-nav-item")].map(
      (item) => item.dataset.settingsTab,
    );
    expect(tabs.indexOf("appearance")).toBe(tabs.indexOf("general") + 1);
  });

  test("splits Configuration and Models panels by ownership", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    const configurationPanel = document.querySelector('[data-settings-panel="configuration"]');
    const modelsPanel = document.querySelector('[data-settings-panel="models"]');

    expect(configurationPanel).not.toBeNull();
    expect(modelsPanel).not.toBeNull();
    expect(configurationPanel.querySelector("#inline-config-textarea")).not.toBeNull();
    expect(configurationPanel.querySelector("#settings-api-keys")).toBeNull();
    expect(configurationPanel.querySelector("#inline-models-textarea")).toBeNull();
    expect(modelsPanel.querySelector("#settings-api-keys")).not.toBeNull();
    expect(modelsPanel.querySelector("#inline-models-textarea")).not.toBeNull();
  });

  test("removes the non-functional Protection markup", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    expect(document.querySelector("#settings-auth-section")).toBeNull();
    expect(document.querySelector("#toggle-auth")).toBeNull();
  });

  test("activates the Models page through settings-panel routing", () => {
    const settingsConfigJs = readFileSync(
      join(process.cwd(), "public/native/settings/settings-config.js"),
      "utf8",
    );
    const modelsPageJs = readFileSync(
      join(process.cwd(), "public/native/settings/models-page.js"),
      "utf8",
    );

    // settings-panel dispatches the Models tab to the extracted module.
    expect(settingsPanelJs).toContain('import { setupModelsPage } from "./models-page.js";');
    expect(settingsPanelJs).toContain('if (target === "models") loadModels();');
    // The slimmed Advanced Configuration module no longer owns provider/models UI.
    expect(settingsConfigJs).not.toContain("loadApiKeysPanel");
    expect(settingsConfigJs).not.toContain("loadInlineModelsEditor");
    // The Models module owns both.
    expect(modelsPageJs).toContain("export function setupModelsPage");
    expect(modelsPageJs).toContain("loadApiKeysPanel");
    expect(modelsPageJs).toContain("loadInlineModelsEditor");
  });

  test("keeps the Agent Inbox tab enabled and orders navigation", () => {
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;

    const tabs = [...document.querySelectorAll(".settings-nav-item")].map(
      (item) => item.dataset.settingsTab,
    );
    // Models sits before Advanced Configuration; chat stays usable (native arch).
    expect(tabs.indexOf("models")).toBeGreaterThan(tabs.indexOf("general"));
    expect(tabs.indexOf("configuration")).toBeGreaterThan(tabs.indexOf("models"));
    expect(document.querySelector('[data-settings-tab="chat"]')?.disabled).not.toBe(true);
  });
});
