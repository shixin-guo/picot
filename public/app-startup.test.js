// ABOUTME: Verifies the browser entry module initializes against the production document.
// ABOUTME: Prevents startup errors from blocking the Settings dialog and every other control.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";

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

beforeEach(async () => {
  document.documentElement.innerHTML = readFileSync(
    join(process.cwd(), "public/index.html"),
    "utf8",
  );
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
  await initI18n();
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
  document.documentElement.innerHTML = "";
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.ResizeObserver;
});

test("places the preview workspace below the shared header", () => {
  const workspace = document.querySelector(".workspace");
  const content = document.querySelector(".workspace-content");

  expect(workspace).not.toBeNull();
  expect(workspace).toContain(document.querySelector(".header"));
  expect(workspace).toContain(content);
  expect(content).toContain(document.querySelector(".main"));
  expect(content).toContain(document.getElementById("file-preview-resizer"));
  expect(content).toContain(document.getElementById("file-preview-panel"));
  expect(content).toContain(document.getElementById("file-sidebar"));
});

test("initializes the application and opens Settings", async () => {
  await import("./app.js?startup-regression");

  document.getElementById("settings-btn").click();

  expect(document.getElementById("settings-panel").classList.contains("hidden")).toBe(false);
});
