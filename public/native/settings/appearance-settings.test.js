// ABOUTME: Tests the Appearance settings module: segmented font controls,
// theme selects, terminal inputs, host preference persistence, and DB
// reconciliation where the stored value wins over the first-paint cookie.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../i18n.js", () => ({
  t: (key) => key,
  onLocaleChange: () => () => {},
}));

import { loadAppearanceCookie, saveAppearanceCookie } from "./appearance-preferences.js";
import { setupAppearanceSettings } from "./appearance-settings.js";

function renderAppearanceDom() {
  document.body.innerHTML = `
    <div id="settings-panel">
      <div class="theme-grid" id="theme-grid"></div>
      <div class="thinking-effort" id="settings-chat-font-size" role="radiogroup">
        <span class="thinking-effort-name" id="settings-chat-font-size-name"></span>
        <div class="thinking-effort-track" id="settings-chat-font-size-steps">
          <span class="thinking-effort-thumb" id="settings-chat-font-size-marker"></span>
          <input type="radio" class="thinking-effort-dot" data-level="small" name="chat" />
          <input type="radio" class="thinking-effort-dot" data-level="normal" name="chat" />
          <input type="radio" class="thinking-effort-dot" data-level="medium" name="chat" />
          <input type="radio" class="thinking-effort-dot" data-level="large" name="chat" />
          <input type="radio" class="thinking-effort-dot" data-level="xlarge" name="chat" />
        </div>
      </div>
      <div class="thinking-effort" id="settings-preview-font-size" role="radiogroup">
        <span class="thinking-effort-name" id="settings-preview-font-size-name"></span>
        <div class="thinking-effort-track" id="settings-preview-font-size-steps">
          <span class="thinking-effort-thumb" id="settings-preview-font-size-marker"></span>
          <input type="radio" class="thinking-effort-dot" data-level="small" name="preview" />
          <input type="radio" class="thinking-effort-dot" data-level="normal" name="preview" />
          <input type="radio" class="thinking-effort-dot" data-level="medium" name="preview" />
          <input type="radio" class="thinking-effort-dot" data-level="large" name="preview" />
          <input type="radio" class="thinking-effort-dot" data-level="xlarge" name="preview" />
        </div>
      </div>
      <div class="thinking-effort" id="settings-terminal-font-size" role="radiogroup">
        <span class="thinking-effort-name" id="settings-terminal-font-size-name"></span>
        <div class="thinking-effort-track" id="settings-terminal-font-size-steps">
          <span class="thinking-effort-thumb" id="settings-terminal-font-size-marker"></span>
          <input type="radio" class="thinking-effort-dot" data-level="small" name="terminal" />
          <input type="radio" class="thinking-effort-dot" data-level="normal" name="terminal" />
          <input type="radio" class="thinking-effort-dot" data-level="medium" name="terminal" />
          <input type="radio" class="thinking-effort-dot" data-level="large" name="terminal" />
          <input type="radio" class="thinking-effort-dot" data-level="xlarge" name="terminal" />
        </div>
      </div>
      <select id="settings-preview-theme-select"></select>
      <select id="settings-terminal-theme-select"></select>
      <input type="number" id="settings-terminal-scrollback-input" />
      <input type="number" id="settings-terminal-smooth-scroll-input" />
      <button type="button" id="toggle-terminal-webgl" role="switch"></button>
    </div>
  `;
}

function fakePreferences(db = {}) {
  return {
    get: vi.fn(async (key) => (key in db ? db[key] : null)),
    set: vi.fn(async () => {}),
  };
}

function fakeTerminal() {
  return {
    applyPreferences: vi.fn(),
  };
}

function clearAppearanceState() {
  document.cookie = "picot-appearance=; Max-Age=0; Path=/";
  document.documentElement.removeAttribute("data-preview-theme");
  document.documentElement.style.removeProperty("--chat-font-size");
  document.documentElement.style.removeProperty("--preview-font-size");
}

beforeEach(() => {
  renderAppearanceDom();
  clearAppearanceState();
});

afterEach(() => {
  document.body.innerHTML = "";
  clearAppearanceState();
});

describe("setupAppearanceSettings", () => {
  test("renders cookie state into the segmented controls on setup", () => {
    saveAppearanceCookie({ chatFontSize: "large", previewTheme: "light" });
    const terminal = fakeTerminal();
    setupAppearanceSettings({ preferences: fakePreferences(), terminal });

    expect(document.querySelector('#settings-chat-font-size [data-level="large"]').checked).toBe(
      true,
    );
    expect(document.getElementById("settings-chat-font-size-name").textContent).toBe(
      "settings.fontLevel.large",
    );
    expect(document.documentElement.getAttribute("data-preview-theme")).toBe("light");
    const previewOptions = [
      ...document.querySelectorAll("#settings-preview-theme-select option"),
    ].map((option) => option.value);
    expect(previewOptions).toEqual(["system", "light", "dark"]);
    expect(document.getElementById("settings-preview-theme-select").value).toBe("light");
  });

  test("clicking a font dot updates cookie, DOM, DB, and live surfaces", async () => {
    const preferences = fakePreferences();
    const terminal = fakeTerminal();
    setupAppearanceSettings({ preferences, terminal });

    document.querySelector('#settings-chat-font-size [data-level="medium"]').click();
    await Promise.resolve();

    expect(loadAppearanceCookie().chatFontSize).toBe("medium");
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("18px");
    expect(preferences.set).toHaveBeenCalledWith("ui.chatFontSize", "medium");

    document.querySelector('#settings-terminal-font-size [data-level="xlarge"]').click();
    await Promise.resolve();
    expect(terminal.applyPreferences).toHaveBeenCalledWith({ fontSize: 26 });
  });

  test("theme selects and terminal inputs persist and apply", async () => {
    const preferences = fakePreferences();
    const terminal = fakeTerminal();
    setupAppearanceSettings({ preferences, terminal });

    const previewSelect = document.getElementById("settings-preview-theme-select");
    previewSelect.value = "dark";
    previewSelect.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(document.documentElement.getAttribute("data-preview-theme")).toBe("dark");
    expect(preferences.set).toHaveBeenCalledWith("ui.previewTheme", "dark");

    const terminalSelect = document.getElementById("settings-terminal-theme-select");
    terminalSelect.value = "light";
    terminalSelect.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(terminal.applyPreferences).toHaveBeenCalledWith({ themeMode: "light" });

    const scrollback = document.getElementById("settings-terminal-scrollback-input");
    scrollback.value = "250";
    scrollback.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(terminal.applyPreferences).toHaveBeenCalledWith({ scrollbackLimit: 250 });

    const smooth = document.getElementById("settings-terminal-smooth-scroll-input");
    smooth.value = "80";
    smooth.dispatchEvent(new Event("change"));
    await Promise.resolve();
    expect(terminal.applyPreferences).toHaveBeenCalledWith({ smoothScrollDuration: 80 });
  });

  test("WebGL toggle flips state and applies to the terminal", async () => {
    const preferences = fakePreferences();
    const terminal = fakeTerminal();
    setupAppearanceSettings({ preferences, terminal });

    const toggle = document.getElementById("toggle-terminal-webgl");
    toggle.click();
    await Promise.resolve();

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(loadAppearanceCookie().terminalWebglRenderer).toBe(true);
    expect(terminal.applyPreferences).toHaveBeenCalledWith({ webglRenderer: true });
  });

  test("reconcile prefers DB values and seeds missing keys from the cookie", async () => {
    saveAppearanceCookie({ chatFontSize: "large" });
    const preferences = fakePreferences({ "ui.chatFontSize": "xlarge" });
    const terminal = fakeTerminal();
    const controls = setupAppearanceSettings({ preferences, terminal });

    await controls.reconcile();

    // DB value wins over the cookie.
    expect(loadAppearanceCookie().chatFontSize).toBe("xlarge");
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("22px");
    // Cookie-only values are seeded into the DB exactly once.
    expect(preferences.set).toHaveBeenCalledWith("ui.previewTheme", "system");
    expect(preferences.set).not.toHaveBeenCalledWith("ui.chatFontSize", expect.anything());
  });

  test("a preference gateway failure degrades to cookie-only operation", async () => {
    saveAppearanceCookie({ chatFontSize: "medium" });
    const preferences = {
      get: vi.fn(async () => {
        throw new Error("host down");
      }),
      set: vi.fn(async () => {
        throw new Error("host down");
      }),
    };
    const terminal = fakeTerminal();
    const controls = setupAppearanceSettings({ preferences, terminal });

    await expect(controls.reconcile()).resolves.toBeUndefined();
    expect(preferences.set).not.toHaveBeenCalled();

    document.querySelector('#settings-chat-font-size [data-level="small"]').click();
    await Promise.resolve();
    // Local application still happens despite the persistence failure.
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("14px");
  });

  test("does not let a DB read overwrite a newer local setting", async () => {
    saveAppearanceCookie({ chatFontSize: "medium" });
    let resolveRead;
    const read = new Promise((resolve) => {
      resolveRead = resolve;
    });
    const preferences = {
      get: vi.fn(async (key) => {
        if (key === "ui.chatFontSize") {
          await read;
          return "xlarge";
        }
        return null;
      }),
      set: vi.fn(async () => {}),
    };
    const controls = setupAppearanceSettings({ preferences, terminal: fakeTerminal() });
    const reconciliation = controls.reconcile();

    document.querySelector('#settings-chat-font-size [data-level="small"]').click();
    resolveRead();
    await reconciliation;

    expect(loadAppearanceCookie().chatFontSize).toBe("small");
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("14px");
  });
});
