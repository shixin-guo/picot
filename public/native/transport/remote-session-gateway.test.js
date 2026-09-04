import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteSessionGateway } from "./remote-session-gateway.js";

const session = {
  id: "session-1",
  machineId: "machine-1",
  projectPath: "/Users/apple",
};

describe("RemoteSessionGateway", () => {
  afterEach(() => vi.useRealTimers());

  it("loads history, status, and the in-flight assistant message", async () => {
    const responses = [
      { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
      { isStreaming: true },
      { seq: 4, partial: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    ];
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => responses.shift() }));
    const gateway = new RemoteSessionGateway(fetchImpl);

    const snapshot = await gateway.snapshot(session);

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.status.isStreaming).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("sends prompts through the native host proxy", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ accepted: true }) }));
    const gateway = new RemoteSessionGateway(fetchImpl);

    await gateway.prompt(session, { text: "continue", streamingBehavior: "followUp" });

    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      machineId: "machine-1",
      sessionId: "session-1",
      cwd: "/Users/apple",
      operation: "prompt",
      payload: { text: "continue", streamingBehavior: "followUp" },
    });
  });

  it("creates a session on the selected remote workspace", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "session-2", cwd: "/Users/apple" }),
    }));
    const gateway = new RemoteSessionGateway(fetchImpl);

    await gateway.create(session);

    expect(fetchImpl).toHaveBeenCalledWith("/v2/remote-session/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: "machine-1", cwd: "/Users/apple" }),
    });
  });
});
