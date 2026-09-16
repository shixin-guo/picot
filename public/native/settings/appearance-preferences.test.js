// ABOUTME: Tests appearance normalization, cookie round-trip, legacy terminal
// preference migration, and first-paint DOM application.

import { afterEach, describe, expect, test } from "vitest";
import {
  applyAppearanceToDom,
  CHAT_FONT_SIZE_PX,
  DEFAULT_FONT_SIZE_LEVEL,
  DEFAULT_PREVIEW_THEME_MODE,
  DEFAULT_SCROLLBACK_LIMIT,
  DEFAULT_TERMINAL_THEME_MODE,
  defaultWebglRenderer,
  FONT_SIZE_LEVELS,
  loadAppearanceCookie,
  migrateLegacyTerminalPreferences,
  nearestFontLevel,
  normalizeFontLevel,
  normalizePreviewThemeMode,
  normalizeScrollbackLimit,
  normalizeSmoothScrollDuration,
  normalizeThemeMode,
  PREVIEW_FONT_SIZE_PX,
  resolvePreviewTheme,
  saveAppearanceCookie,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_THEME_MODES,
} from "./appearance-preferences.js";

const COOKIE_KEY = "picot-appearance";

function clearCookie() {
  document.cookie = `${COOKIE_KEY}=; Max-Age=0; Path=/`;
}

afterEach(() => {
  clearCookie();
  document.documentElement.removeAttribute("data-preview-theme");
  for (const name of ["--chat-font-size", "--preview-font-size"]) {
    document.documentElement.style.removeProperty(name);
  }
});

describe("appearance level tables", () => {
  test("exposes five levels with source-compatible px maps", () => {
    expect(FONT_SIZE_LEVELS).toEqual(["small", "normal", "medium", "large", "xlarge"]);
    expect(DEFAULT_FONT_SIZE_LEVEL).toBe("normal");
    expect(CHAT_FONT_SIZE_PX).toEqual({ small: 14, normal: 16, medium: 18, large: 20, xlarge: 22 });
    expect(PREVIEW_FONT_SIZE_PX).toEqual({
      small: 11,
      normal: 13,
      medium: 15,
      large: 17,
      xlarge: 19,
    });
    expect(TERMINAL_FONT_SIZE_PX).toEqual({
      small: 12,
      normal: 15,
      medium: 18,
      large: 22,
      xlarge: 26,
    });
    expect(DEFAULT_PREVIEW_THEME_MODE).toBe("system");
    expect(DEFAULT_TERMINAL_THEME_MODE).toBe("dark");
    expect(TERMINAL_THEME_MODES).toEqual(["system", "light", "dark"]);
    expect(DEFAULT_SCROLLBACK_LIMIT).toBe(1000);
  });

  test("normalizes unknown values to defaults", () => {
    expect(normalizeFontLevel("huge")).toBe("normal");
    expect(normalizePreviewThemeMode("sepia")).toBe("system");
    expect(normalizeThemeMode("sepia")).toBe("dark");
    expect(normalizeScrollbackLimit(50)).toBe(100);
    expect(normalizeScrollbackLimit(60000)).toBe(50000);
    expect(normalizeScrollbackLimit("bad")).toBe(1000);
    expect(normalizeSmoothScrollDuration(-5)).toBe(0);
    expect(normalizeSmoothScrollDuration(99999)).toBe(1000);
  });

  test("maps legacy px values onto the nearest level with ties going lower", () => {
    expect(nearestFontLevel(15, TERMINAL_FONT_SIZE_PX)).toBe("normal");
    expect(nearestFontLevel(26, TERMINAL_FONT_SIZE_PX)).toBe("xlarge");
    expect(nearestFontLevel(10, TERMINAL_FONT_SIZE_PX)).toBe("small");
    expect(nearestFontLevel(32, TERMINAL_FONT_SIZE_PX)).toBe("xlarge");
    expect(nearestFontLevel(17, TERMINAL_FONT_SIZE_PX)).toBe("medium");
    expect(nearestFontLevel("bad", TERMINAL_FONT_SIZE_PX)).toBe("normal");
  });

  test("resolves the effective preview theme", () => {
    expect(resolvePreviewTheme("light", true)).toBe("light");
    expect(resolvePreviewTheme("dark", false)).toBe("dark");
    expect(resolvePreviewTheme("system", true)).toBe("dark");
    expect(resolvePreviewTheme("system", false)).toBe("light");
  });

  test("defaults the WebGL renderer off only on Windows", () => {
    expect(
      defaultWebglRenderer("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15"),
    ).toBe(true);
    expect(
      defaultWebglRenderer("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"),
    ).toBe(false);
  });
});

describe("appearance cookie", () => {
  test("round-trips and normalizes partial writes", () => {
    saveAppearanceCookie({ chatFontSize: "large", terminalFontSize: "xlarge" });
    expect(loadAppearanceCookie()).toEqual({
      chatFontSize: "large",
      previewFontSize: "normal",
      previewTheme: "system",
      terminalFontSize: "xlarge",
      terminalThemeMode: "dark",
      terminalScrollbackLimit: 1000,
      terminalSmoothScrollDuration: 0,
      terminalWebglRenderer: undefined,
    });

    saveAppearanceCookie({ previewFontSize: "small", previewTheme: "light" });
    expect(loadAppearanceCookie()).toEqual({
      chatFontSize: "large",
      previewFontSize: "small",
      previewTheme: "light",
      terminalFontSize: "xlarge",
      terminalThemeMode: "dark",
      terminalScrollbackLimit: 1000,
      terminalSmoothScrollDuration: 0,
      terminalWebglRenderer: undefined,
    });
  });

  test("recovers from corrupt cookie data", () => {
    document.cookie = `${COOKIE_KEY}=%%%not-json; Path=/`;
    expect(loadAppearanceCookie()).toEqual({
      chatFontSize: "normal",
      previewFontSize: "normal",
      previewTheme: "system",
      terminalFontSize: "normal",
      terminalThemeMode: "dark",
      terminalScrollbackLimit: 1000,
      terminalSmoothScrollDuration: 0,
      terminalWebglRenderer: undefined,
    });
  });

  test("keeps terminalWebglRenderer only for boolean values", () => {
    saveAppearanceCookie({ terminalWebglRenderer: false });
    expect(loadAppearanceCookie().terminalWebglRenderer).toBe(false);
    saveAppearanceCookie({ terminalWebglRenderer: true });
    expect(loadAppearanceCookie().terminalWebglRenderer).toBe(true);
    saveAppearanceCookie({ terminalWebglRenderer: "yes" });
    expect(loadAppearanceCookie().terminalWebglRenderer).toBeUndefined();
  });
});

describe("legacy terminal preference migration", () => {
  function memStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => map.set(key, String(value)),
      removeItem: (key) => map.delete(key),
      _map: map,
    };
  }

  test("lifts customized legacy values and removes the storage key", () => {
    const storage = memStorage({
      "picot.terminal.preferences": JSON.stringify({
        fontSize: 22,
        themeMode: "light",
        scrollbackLimit: 5000,
        smoothScrollDuration: 120,
        webglRenderer: false,
      }),
    });

    migrateLegacyTerminalPreferences(storage);

    const cookie = loadAppearanceCookie();
    expect(cookie.terminalFontSize).toBe("large");
    expect(cookie.terminalThemeMode).toBe("light");
    expect(cookie.terminalScrollbackLimit).toBe(5000);
    expect(cookie.terminalSmoothScrollDuration).toBe(120);
    // Windows-only explicit false is preserved; on the jsdom UA (not Windows)
    // false differs from the platform default so it migrates.
    expect(cookie.terminalWebglRenderer).toBe(false);
    expect(storage.getItem("picot.terminal.preferences")).toBeNull();
  });

  test("is a no-op without stored preferences and skips defaults", () => {
    const storage = memStorage();
    migrateLegacyTerminalPreferences(storage);
    expect(loadAppearanceCookie().terminalFontSize).toBe("normal");

    storage.setItem(
      "picot.terminal.preferences",
      JSON.stringify({ fontSize: 15, themeMode: "dark", scrollbackLimit: 1000 }),
    );
    migrateLegacyTerminalPreferences(storage);
    expect(loadAppearanceCookie().terminalFontSize).toBe("normal");
    expect(loadAppearanceCookie().terminalScrollbackLimit).toBe(1000);
    // The key is consumed either way.
    expect(storage.getItem("picot.terminal.preferences")).toBeNull();
  });
});

describe("applyAppearanceToDom", () => {
  test("sets font variables and the resolved preview theme attribute", () => {
    applyAppearanceToDom({
      chatFontSize: "large",
      previewFontSize: "medium",
      previewTheme: "dark",
      picotThemeIsDark: false,
    });
    expect(document.documentElement.style.getPropertyValue("--chat-font-size")).toBe("20px");
    expect(document.documentElement.style.getPropertyValue("--preview-font-size")).toBe("15px");
    expect(document.documentElement.getAttribute("data-preview-theme")).toBe("dark");
  });

  test("removes the forced theme attribute in system mode", () => {
    document.documentElement.setAttribute("data-preview-theme", "light");
    applyAppearanceToDom({
      chatFontSize: "normal",
      previewFontSize: "normal",
      previewTheme: "system",
      picotThemeIsDark: true,
    });
    expect(document.documentElement.getAttribute("data-preview-theme")).toBeNull();
  });
});
