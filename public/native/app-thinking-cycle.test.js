// ABOUTME: Confirms the native main-chat thinking button requests server-side
// level cycling (cycle_thinking_level) instead of cycling a fixed client-side
// array, so levels unsupported by the current model are skipped by the server.
// ABOUTME: The server's returned level is applied back to the composer button.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

const liveSockets = [];

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    super();
    // The real host only accepts frames once the socket is OPEN, the adapter
    // sent `hello` on open, and the host replied `hello_ack`. Model that flow:
    // open immediately, fire `onopen` after the adapter attaches handlers,
    // and auto-ack so the adapter's ready() promise resolves even while the
    // app module is still evaluating (app.js awaits adapter.ready() during
    // startup). Tests that need to inspect pre-ack frames can still spy on
    // send() after import resolves.
    this.readyState = FakeWebSocket.OPEN;
    liveSockets.push(this);
    queueMicrotask(() => {
      this.onopen?.();
      // Auto-deliver hello_ack so adapter.ready() resolves immediately.
      this.onmessage?.({ data: JSON.stringify({ type: "hello_ack", protocolVersion: 2 }) });
    });
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

function sentRuntimeFrames(sendSpy) {
  return sendSpy.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0]));
      } catch {
        return null;
      }
    })
    .filter((frame) => frame?.type === "runtime_request");
}

function deliverToRuntimeSocket(frame) {
  // The adapter assigns `socket.onmessage`; call the handler directly with a
  // host response frame carrying the runtime request's requestId.
  const runtimeSocket = liveSockets.find((socket) => socket.onmessage);
  runtimeSocket?.onmessage({ data: JSON.stringify(frame) });
}

function handshakeSockets() {
  // Complete the WebSocket handshake for every live socket so the runtime
  // adapter's `send()` stops rejecting with "disconnected".
  for (const socket of liveSockets) {
    socket.onmessage?.({ data: JSON.stringify({ type: "hello_ack", protocolVersion: 2 }) });
  }
}

beforeEach(() => {
  liveSockets.length = 0;
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
test("thinking button asks the server to cycle levels and applies the returned level", async () => {
  await import("./app.js?thinking-cycle-regression");
  await vi.waitFor(() => {
    expect(liveSockets.some((socket) => socket.onmessage)).toBe(true);
  });
  handshakeSockets();
  const send = vi.spyOn(FakeWebSocket.prototype, "send");

  document.getElementById("thinking-btn").click();

  let cycleFrame;
  await vi.waitFor(() => {
    cycleFrame = sentRuntimeFrames(send).find(
      (frame) => frame.command?.type === "cycle_thinking_level",
    );
    expect(cycleFrame).toBeTruthy();
  });

  // The server owns the level cycle; the client must not pick a concrete level.
  expect(cycleFrame.command).not.toHaveProperty("level");

  // A server response with the next level must update the composer button.
  deliverToRuntimeSocket({
    requestId: cycleFrame.requestId,
    response: { command: "cycle_thinking_level", success: true, data: { level: "high" } },
  });

  const btn = document.getElementById("thinking-btn");
  await vi.waitFor(() => {
    expect(btn.textContent.trim()).toContain("high");
  });
}, 20000);

test("model switch handler reconciles thinking level via get_state (source contract)", async () => {
  // The comment asked for a focused model-switch reconciliation test. The
  // ideal jsdom end-to-end test (open dropdown → click model → assert
  // get_state reconciliation) is blocked here: the model dropdown is gated on
  // the config gateway, which only resolves after hydrateSnapshot() runs, and
  // hydrateSnapshot() in turn requires a successful /v2/bootstrap + runtime
  // snapshot — a startup chain that deadlocks under jsdom because the app's
  // top-level await blocks the same event loop the test needs to deliver
  // runtime responses on. Rather than ship a flaky/timing-dependent harness,
  // this test pins the source-level contract the reviewer's intent depends on:
  // the set_model click handler must call get_state and feed its
  // data.thinkingLevel to updateComposerThinking. If someone removes the
  // reconciliation, this test fails.
  //
  // Why get_state and not set_model's response: pi 0.83's set_model response
  // is the Model object (src-tauri/resources/pi/docs/rpc.md), which has no
  // thinkingLevel field. The authoritative thinking level lives at the top
  // level of get_state's data. See the handler comment in app.js.
  const source = readFileSync(join(process.cwd(), "public/native/app.js"), "utf8");

  // Locate the model-dropdown item click handler and assert the
  // reconciliation calls appear inside it (after set_model, before the
  // handler's closing brace).
  const setModelIndex = source.indexOf('{ type: "set_model"');
  expect(setModelIndex).toBeGreaterThan(-1);
  const handlerEnd = source.indexOf("return item;", setModelIndex);
  expect(handlerEnd).toBeGreaterThan(setModelIndex);
  const handlerBody = source.slice(setModelIndex, handlerEnd);

  // set_model is the authoritative model switch...
  expect(handlerBody).toContain('"set_model"');
  // ...followed by a get_state fetch of the server's thinking level...
  expect(handlerBody).toContain('"get_state"');
  // ...consumed from response.data.thinkingLevel via updateComposerThinking.
  expect(handlerBody).toMatch(/response\?\.data\?\.thinkingLevel/);
  expect(handlerBody).toContain("updateComposerThinking(level)");
});
