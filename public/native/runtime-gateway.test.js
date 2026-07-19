import { describe, expect, it } from "vitest";
import { createInMemoryRuntimeAdapter, RuntimeGateway } from "./runtime-gateway.js";

const target = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
};

describe("RuntimeGateway", () => {
  it("requires identity and an idempotency key for mutations", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);

    await expect(gateway.request({ type: "prompt", message: "hi" }, target)).rejects.toThrow(
      "idempotencyKey",
    );
    const request = gateway.request({ type: "prompt", message: "hi" }, target, {
      idempotencyKey: "intent-1",
    });
    const frame = adapter.takeSent();
    expect(frame.type).toBe("runtime_request");
    expect(frame.target).toEqual(target);
    adapter.receive({
      type: "runtime_response",
      requestId: frame.requestId,
      acceptance: "accepted",
      response: { success: true },
    });
    await expect(request).resolves.toMatchObject({ acceptance: "accepted" });
  });

  it("rejects pending requests on disconnect and ignores stale responses after reconnect", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const gateway = new RuntimeGateway(adapter);
    const pending = gateway.snapshot(target.sessionId);
    const oldFrame = adapter.takeSent();

    adapter.disconnect();
    await expect(pending).rejects.toThrow("disconnected");
    adapter.reconnect();
    adapter.receive({
      type: "runtime_response",
      requestId: oldFrame.requestId,
      response: { stale: true },
    });

    const fresh = gateway.snapshot(target.sessionId);
    const freshFrame = adapter.takeSent();
    adapter.receive({
      type: "runtime_snapshot",
      requestId: freshFrame.requestId,
      target,
      sequence: 4,
      state: { lifecycle: "idle" },
    });
    await expect(fresh).resolves.toMatchObject({ sequence: 4 });
  });
});
