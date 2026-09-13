// ABOUTME: Confirms the native main-chat composer wires the @-file-mention controller and popup.
// ABOUTME: Enter-ordering behavior is covered by ui/at-file-mention.test.js.
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

beforeEach(() => {
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
  document.documentElement.replaceChildren();
  delete globalThis.WebSocket;
  delete globalThis.fetch;
  delete globalThis.requestAnimationFrame;
  delete globalThis.ResizeObserver;
});

// Booting the whole native entry is inherently slow (seconds, not
// milliseconds); the 5s default timeout is marginal once the suite runs it
// alongside everything else.
test("installs the mention popup and controller on the native main composer", async () => {
  await import("./app.js?at-file-mention-regression");

  const menu = document.getElementById("at-file-mention-menu");
  const input = document.getElementById("message-input");

  expect(menu).not.toBeNull();
  expect(input.getAttribute("aria-autocomplete")).toBe("list");

  input.value = "@ind";
  input.setSelectionRange(input.value.length, input.value.length);
  await input.dispatchEvent(new Event("input", { bubbles: true }));

  await vi.waitFor(() => {
    const calls = globalThis.fetch.mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.includes("/api/file-mentions"))).toBe(true);
  });
}, 20000);
