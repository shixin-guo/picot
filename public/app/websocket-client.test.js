import { describe, expect, test } from "vitest";
import { resolveWebSocketUrl, WebSocketClient } from "./websocket-client.js";

function fakeSessionStorage() {
  const store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
}

describe("resolveWebSocketUrl", () => {
  test("uses the broker URL from the ?brokerWs= query param", () => {
    const brokerUrl = "ws://127.0.0.1:49000/ui-ws";

    expect(
      resolveWebSocketUrl({
        location: {
          protocol: "http:",
          host: "127.0.0.1:47821",
          search: `?brokerWs=${encodeURIComponent(brokerUrl)}`,
        },
        sessionStorage: fakeSessionStorage(),
      }),
    ).toBe(brokerUrl);
  });

  test("recovers the broker URL from sessionStorage on a param-less reload", () => {
    const brokerUrl = "ws://127.0.0.1:49000/ui-ws";
    const sessionStorage = fakeSessionStorage();
    // First load carries the param and persists it.
    resolveWebSocketUrl({
      location: { protocol: "http:", host: "127.0.0.1:47821", search: `?brokerWs=${brokerUrl}` },
      sessionStorage,
    });
    // Reload without the param still resolves to the broker.
    expect(
      resolveWebSocketUrl({
        location: { protocol: "http:", host: "127.0.0.1:47821", search: "" },
        sessionStorage,
      }),
    ).toBe(brokerUrl);
  });

  test("falls back to the page-local pi websocket when no broker URL is present", () => {
    expect(
      resolveWebSocketUrl({
        location: { protocol: "https:", host: "studio.local", search: "" },
        sessionStorage: fakeSessionStorage(),
      }),
    ).toBe("wss://studio.local/ws");
  });
});

describe("WebSocketClient control commands", () => {
  function openClient() {
    const sent = [];
    const client = new WebSocketClient("ws://broker/ui-ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    return { client, sent };
  }

  test("sendControl emits a broker_control envelope and resolves on control_response", async () => {
    const { client, sent } = openClient();
    const result = client.sendControl("get_pi_version", {});

    expect(sent[0]).toMatchObject({
      type: "broker_control",
      command: "get_pi_version",
      requestId: "ctl-1",
    });

    client.handleMessage({
      type: "control_response",
      requestId: "ctl-1",
      ok: true,
      result: "1.2.3",
    });
    await expect(result).resolves.toBe("1.2.3");
  });

  test("sendControl rejects on an error control_response", async () => {
    const { client } = openClient();
    const result = client.sendControl("new_session", {});
    client.handleMessage({
      type: "control_response",
      requestId: "ctl-1",
      ok: false,
      error: "boom",
    });
    await expect(result).rejects.toThrow("boom");
  });

  test("control_progress frames invoke the onProgress callback", async () => {
    const { client } = openClient();
    const events = [];
    const result = client.sendControl(
      "download_and_install_update",
      {},
      { onProgress: (data) => events.push(data), timeoutMs: 0 },
    );

    client.handleMessage({
      type: "control_progress",
      requestId: "ctl-1",
      data: { phase: "started", contentLength: 100 },
    });
    client.handleMessage({
      type: "control_progress",
      requestId: "ctl-1",
      data: { phase: "progress", downloaded: 50, contentLength: 100 },
    });
    client.handleMessage({
      type: "control_response",
      requestId: "ctl-1",
      ok: true,
      result: { installed: true },
    });

    await expect(result).resolves.toEqual({ installed: true });
    expect(events).toEqual([
      { phase: "started", contentLength: 100 },
      { phase: "progress", downloaded: 50, contentLength: 100 },
    ]);
  });

  test("the capabilities handshake updates client.capabilities and emits an event", () => {
    const client = new WebSocketClient("ws://broker/ui-ws");
    const seen = [];
    client.addEventListener("capabilities", (event) => seen.push(event.detail));

    client.handleMessage({ type: "capabilities", native: true });

    expect(client.capabilities).toEqual({ native: true });
    expect(seen).toEqual([{ native: true }]);
  });

  test("disconnecting rejects pending control requests", async () => {
    const { client } = openClient();
    const result = client.sendControl("get_pi_version", {});
    client.rejectAllControls(new Error("WebSocket disconnected"));
    await expect(result).rejects.toThrow("WebSocket disconnected");
  });
});

describe("WebSocketClient broker routing", () => {
  test("wraps commands with the current session route", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
    });

    client.send({ type: "mirror_sync_request" });

    expect(sent).toEqual([
      {
        type: "broker_command",
        protocolVersion: 1,
        requestId: "req-1",
        workspaceId: "workspace:/tmp/project",
        sessionId: "/tmp/project/session-a.jsonl",
        payload: { type: "mirror_sync_request" },
      },
    ]);
  });

  test("attaches broker route metadata to unwrapped rpc events", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    const events = [];
    client.addEventListener("rpcEvent", (event) => events.push(event.detail));

    client.handleMessage({
      type: "broker_event",
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-b.jsonl",
      sourcePort: 47822,
      payload: {
        type: "event",
        event: { type: "agent_start" },
      },
    });

    expect(events).toEqual([
      {
        type: "agent_start",
        __broker: {
          workspaceId: "workspace:/tmp/project",
          sessionId: "/tmp/project/session-b.jsonl",
          sourcePort: 47822,
        },
      },
    ]);
  });

  test("can clear the current session route for a new active process", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
    });
    client.setRoutingContext({ sessionId: null });

    client.send({ type: "prompt", message: "hello" });

    expect(sent[0].sessionId).toBeUndefined();
    expect(sent[0].workspaceId).toBe("workspace:/tmp/project");
  });

  test("mirror_sync does not hijack the routing context", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    // User is actively viewing session A on port 47821.
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
      sourcePort: 47821,
    });

    // A background process (session B on port 47822) broadcasts a mirror_sync.
    client.handleMessage({
      type: "broker_event",
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-b.jsonl",
      sourcePort: 47822,
      payload: { type: "mirror_sync", sessionFile: "/tmp/project/session-b.jsonl" },
    });

    // The next command must still target session A, not the background B.
    client.send({ type: "prompt", message: "hello" });
    expect(sent[0].sessionId).toBe("/tmp/project/session-a.jsonl");
    expect(sent[0].sourcePort).toBe(47821);
  });

  test("mirror_sync surfaces the broker source port to listeners", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    const syncs = [];
    client.addEventListener("mirrorSync", (event) => syncs.push(event.detail));

    client.handleMessage({
      type: "broker_event",
      sessionId: "/tmp/project/session-b.jsonl",
      sourcePort: 47822,
      payload: { type: "mirror_sync", sessionFile: "/tmp/project/session-b.jsonl" },
    });

    expect(syncs).toHaveLength(1);
    expect(syncs[0].port).toBe(47822);
  });

  test("send returns the requestId so callers can correlate delivery failures", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    client.ws = { readyState: WebSocket.OPEN, send: () => {} };

    expect(client.send({ type: "prompt", message: "hello" })).toBe("req-1");
    // Pre-wrapped broker_command envelopes keep their own requestId.
    expect(client.send({ type: "broker_command", requestId: "req-custom" })).toBe("req-custom");
    // Not connected: nothing is sent and there is no requestId to track.
    client.ws = { readyState: WebSocket.CLOSED, send: () => {} };
    expect(client.send({ type: "prompt", message: "later" })).toBeNull();
  });

  test("command_undeliverable dispatches a commandUndeliverable event", () => {
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    const seen = [];
    client.addEventListener("commandUndeliverable", (event) => seen.push(event.detail));

    client.handleMessage({
      type: "command_undeliverable",
      requestId: "req-7",
      command: "prompt",
      reason: "upstream_unavailable",
      sessionId: "/tmp/project/session-a.jsonl",
    });

    expect(seen).toEqual([
      {
        type: "command_undeliverable",
        requestId: "req-7",
        command: "prompt",
        reason: "upstream_unavailable",
        sessionId: "/tmp/project/session-a.jsonl",
      },
    ]);
  });

  test("wraps commands with the active source port", () => {
    const sent = [];
    const client = new WebSocketClient("ws://127.0.0.1:49000/ui-ws");
    client.ws = {
      readyState: WebSocket.OPEN,
      send: (message) => sent.push(JSON.parse(message)),
    };
    client.setRoutingContext({
      workspaceId: "workspace:/tmp/project",
      sessionId: "/tmp/project/session-a.jsonl",
      sourcePort: 47822,
    });

    client.send({ type: "mirror_sync_request" });

    expect(sent[0].sourcePort).toBe(47822);
  });
});
