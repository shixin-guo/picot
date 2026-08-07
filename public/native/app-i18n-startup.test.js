import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    super();
    this.readyState = FakeWebSocket.CONNECTING;
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function clearLanguageCookie() {
  document.cookie = "picot-language=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

beforeEach(() => {
  clearLanguageCookie();
  const fixture = new DOMParser().parseFromString(
    readFileSync(join(process.cwd(), "public/index.html"), "utf8"),
    "text/html",
  );
  document.documentElement.replaceChildren(...fixture.documentElement.childNodes);
  window.history.replaceState(null, "", "/app/workspaces/workspace-a/sessions/session-a");
  const storage = new Map();
  const storageApi = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  vi.stubGlobal("localStorage", storageApi);
  vi.stubGlobal("sessionStorage", storageApi);
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input) === "/locales/en.json") {
      return new Response(JSON.stringify(enMessages));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  globalThis.requestAnimationFrame = (callback) => callback();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearLanguageCookie();
  document.documentElement.replaceChildren();
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.ResizeObserver;
});

test("native entry initializes i18n before rendering welcome and settings language", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

  await import("./app.js?startup-i18n-regression");
  await vi.waitFor(() => {
    expect(document.querySelector("#messages .welcome")?.textContent).toContain("Welcome to Picot");
  });

  expect(document.querySelector("#messages .welcome")?.textContent).not.toContain("app.welcome");
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("[i18n] missing key:"));

  document.getElementById("settings-btn").click();
  const languageOptions = Array.from(
    document.querySelectorAll("#settings-language-select option"),
  ).map((option) => option.value);
  expect(languageOptions).toEqual(["system", "en", "zh", "ja", "es"]);
});
