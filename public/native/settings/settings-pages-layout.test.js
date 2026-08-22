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
