import { describe, expect, it } from "vitest";
import { HostRuntimeAdapter } from "./runtime-adapter.js";
import { RuntimeGateway } from "./runtime-gateway.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const target = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
};

describe("HostRuntimeAdapter", () => {
  it("performs v2 handshake, subscribes by opaque target, and forwards frames", async () => {
    FakeWebSocket.instances.length = 0;
    const adapter = new HostRuntimeAdapter({
      url: "ws://127.0.0.1:9000/v2/ws",
      WebSocketImpl: FakeWebSocket,
      clientId: "desktop-a",
    });
    const gateway = new RuntimeGateway(adapter);
    const events = [];
    gateway.subscribe((event) => events.push(event));
    adapter.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    expect(socket.sent[0]).toEqual({
      type: "hello",
      protocolVersion: 2,
      clientType: "desktop",
      clientId: "desktop-a",
    });
    socket.receive({ type: "hello_ack", protocolVersion: 2 });

    const pending = gateway.request({ type: "prompt", message: "hello" }, target, {
      idempotencyKey: "intent-1",
    });
    expect(socket.sent[1]).toMatchObject({ type: "runtime_subscribe", target });
    const request = socket.sent[2];
    expect(request).toMatchObject({ type: "runtime_request", target });
    socket.receive({
      type: "runtime_response",
      requestId: request.requestId,
      acceptance: "accepted",
      response: { success: true },
    });
    await expect(pending).resolves.toMatchObject({ acceptance: "accepted" });

    socket.receive({ type: "runtime_event", target, sequence: 1, event: { type: "agent_start" } });
    expect(events).toHaveLength(1);
  });

  it("sends a remote device token only in hello and resubscribes after reconnect", () => {
    FakeWebSocket.instances.length = 0;
    const adapter = new HostRuntimeAdapter({
      url: "ws://host/v2/ws",
      WebSocketImpl: FakeWebSocket,
      clientType: "remote",
      clientId: "phone",
      deviceToken: "device-secret",
    });
    adapter.setReceiver(() => {});
    adapter.setConnectionListener(() => {});
    adapter.connect();
    let socket = FakeWebSocket.instances[0];
    socket.open();
    expect(socket.sent[0].deviceToken).toBe("device-secret");
    socket.receive({ type: "hello_ack", protocolVersion: 2 });
    adapter.subscribeTarget(target);
    expect(JSON.stringify(socket.sent.slice(1))).not.toContain("device-secret");

    socket.close();
    adapter.connect();
    socket = FakeWebSocket.instances[1];
    socket.open();
    socket.receive({ type: "hello_ack", protocolVersion: 2 });
    expect(socket.sent[1]).toMatchObject({ type: "runtime_subscribe", target });
  });
});
