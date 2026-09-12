// ABOUTME: Tests host preference request correlation: matching responses,
// error frames, disconnect cleanup, and dispose semantics.

import { afterEach, describe, expect, test, vi } from "vitest";
import { PreferenceGateway } from "./preference-gateway.js";

function fakeAdapter() {
  const listeners = { receiver: null, connection: null };
  return {
    sent: [],
    setReceiver(fn) {
      listeners.receiver = fn;
    },
    setConnectionListener(fn) {
      listeners.connection = fn;
    },
    send(frame) {
      this.sent.push(frame);
    },
    receive(frame) {
      listeners.receiver?.(frame);
    },
    disconnect() {
      listeners.connection?.(false);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PreferenceGateway", () => {
  test("sends host_request frames and resolves the matching response value", async () => {
    const adapter = fakeAdapter();
    const gateway = new PreferenceGateway(adapter);

    const pending = gateway.get("ui.chatFontSize");
    const setPending = gateway.set("ui.chatFontSize", "large");

    expect(adapter.sent[0]).toMatchObject({
      type: "host_request",
      operation: "get_preference",
      key: "ui.chatFontSize",
    });
    expect(adapter.sent[1]).toMatchObject({
      type: "host_request",
      operation: "set_preference",
      key: "ui.chatFontSize",
      value: "large",
    });

    adapter.receive({
      type: "host_response",
      requestId: adapter.sent[0].requestId,
      operation: "get_preference",
      value: "large",
    });
    adapter.receive({
      type: "host_response",
      requestId: adapter.sent[1].requestId,
      operation: "set_preference",
      value: "large",
    });

    await expect(pending).resolves.toBe("large");
    await expect(setPending).resolves.toBe("large");
  });

  test("get resolves null for an absent value and remove reports removal", async () => {
    const adapter = fakeAdapter();
    const gateway = new PreferenceGateway(adapter);

    const missing = gateway.get("ui.missing");
    adapter.receive({
      type: "host_response",
      requestId: adapter.sent[0].requestId,
      operation: "get_preference",
      value: null,
    });
    await expect(missing).resolves.toBeNull();

    const removed = gateway.remove("ui.missing");
    adapter.receive({
      type: "host_response",
      requestId: adapter.sent[1].requestId,
      operation: "remove_preference",
      removed: true,
    });
    await expect(removed).resolves.toBe(true);
  });

  test("rejects when the host answers with a structured error frame", async () => {
    const adapter = fakeAdapter();
    const gateway = new PreferenceGateway(adapter);

    const pending = gateway.set("agent.forbidden", "x");
    adapter.receive({
      type: "error",
      requestId: adapter.sent[0].requestId,
      error: { code: "invalid_preference", message: "Only ui.* keys are supported" },
    });

    await expect(pending).rejects.toThrow("Only ui.* keys are supported");
  });

  test("rejects stale-generation responses after a reconnect", async () => {
    const adapter = fakeAdapter();
    const gateway = new PreferenceGateway(adapter);

    const stale = gateway.get("ui.chatFontSize");
    adapter.disconnect();
    await expect(stale).rejects.toThrow("disconnected");

    // A request issued after reconnect resolves normally.
    const fresh = gateway.get("ui.chatFontSize");
    adapter.receive({
      type: "host_response",
      requestId: adapter.sent[1].requestId,
      operation: "get_preference",
      value: "medium",
    });
    await expect(fresh).resolves.toBe("medium");
  });

  test("times out pending requests and ignores responses after dispose", async () => {
    vi.useFakeTimers();
    const adapter = fakeAdapter();
    const gateway = new PreferenceGateway(adapter, { timeoutMs: 5000 });

    const pending = gateway.get("ui.chatFontSize");
    const assertion = expect(pending).rejects.toThrow("timed out");
    vi.advanceTimersByTime(5001);
    await assertion;

    gateway.dispose();
    adapter.receive({
      type: "host_response",
      requestId: adapter.sent[0].requestId,
      operation: "get_preference",
      value: "large",
    });
  });
});
