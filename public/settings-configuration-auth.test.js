import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test } from "vitest";

describe("settings authentication placement", () => {
  const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
  const appJs = readFileSync(join(process.cwd(), "public/app.js"), "utf8");

  test("removes the Authentication tab and shows API keys inside Configuration", () => {
    const dom = new JSDOM(html);
    const { document } = dom.window;

    expect(document.querySelector('[data-settings-tab="auth"]')).toBeNull();
    expect(document.querySelector('[data-settings-panel="auth"]')).toBeNull();

    const configurationPanel = document.querySelector('[data-settings-panel="configuration"]');
    expect(configurationPanel).not.toBeNull();
    expect(configurationPanel.querySelector("#settings-api-keys")).not.toBeNull();
    expect(configurationPanel.querySelector("#settings-auth-section")).not.toBeNull();
  });

  test("opens API key setup through the Configuration settings tab", () => {
    expect(appJs).toContain('selectSettingsTab("configuration")');
    expect(appJs).not.toContain('selectSettingsTab("auth")');
  });

  test("keeps LAN access behind the QR code instead of showing the raw URL", () => {
    const dom = new JSDOM(html);
    const { document } = dom.window;

    expect(Boolean(document.querySelector("#setting-lan-url-value"))).toBe(false);
    expect(document.querySelector("#lan-qr-btn")).not.toBeNull();
    expect(document.querySelector("#lan-qr-modal")).not.toBeNull();
  });
});
