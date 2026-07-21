import { describe, expect, it, vi } from "vitest";
import { HostDataGateway } from "./data-gateway.js";
import { createInMemoryRuntimeAdapter } from "./runtime-gateway.js";

describe("HostDataGateway", () => {
  it("keeps read-only data requests separate from runtime requests", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const data = new HostDataGateway(adapter);
    const response = data.listFiles("workspace-a", "src");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "data_request",
      operation: "list_files",
      workspaceId: "workspace-a",
      path: "src",
    });
    adapter.receive({
      type: "data_response",
      requestId: sent.requestId,
      entries: [{ name: "app.js" }],
    });
    await expect(response).resolves.toMatchObject({ entries: [{ name: "app.js" }] });
    await expect(data.request("delete_workspace")).rejects.toThrow("Unsupported read-only");
  });

  it("rejects pending reads on disconnect", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const data = new HostDataGateway(adapter);
    const response = data.listSessions("workspace-a");
    adapter.disconnect();
    await expect(response).rejects.toThrow("disconnected");
  });

  it("waits for the host connection before sending data requests", async () => {
    let resolveReady;
    const adapter = {
      send: vi.fn(),
      setReceiver: vi.fn(),
      setConnectionListener: vi.fn(),
      ready: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveReady = resolve;
          }),
      ),
    };
    const data = new HostDataGateway(adapter);
    const response = data.listAllSessions("workspace-a");
    expect(adapter.send).not.toHaveBeenCalled();

    resolveReady();
    await vi.waitFor(() =>
      expect(adapter.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "data_request",
          operation: "list_all_sessions",
          workspaceId: "workspace-a",
        }),
      ),
    );
    adapter.setReceiver.mock.calls[0][0]({
      type: "data_response",
      requestId: adapter.send.mock.calls[0][0].requestId,
      sessions: [],
    });
    await expect(response).resolves.toMatchObject({ sessions: [] });
  });

  it("rejects instead of hanging when the host never becomes ready", async () => {
    vi.useFakeTimers();
    try {
      const adapter = {
        send: vi.fn(),
        setReceiver: vi.fn(),
        setConnectionListener: vi.fn(),
        ready: vi.fn(() => new Promise(() => {})),
      };
      const data = new HostDataGateway(adapter, { hostReadyTimeoutMs: 100 });

      const response = data.listSessions("workspace-a");
      const assertion = expect(response).rejects.toThrow(
        "timed out before the data request could start",
      );
      await vi.advanceTimersByTimeAsync(100);

      expect(adapter.send).not.toHaveBeenCalled();
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects instead of hanging when the host does not answer a data request", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createInMemoryRuntimeAdapter();
      const data = new HostDataGateway(adapter, { dataRequestTimeoutMs: 100 });

      const response = data.listSessions("workspace-a");
      const assertion = expect(response).rejects.toThrow("Host data request timed out");
      expect(adapter.takeSent()).toMatchObject({
        type: "data_request",
        operation: "list_sessions",
      });

      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads all sessions over HTTP when a fetch implementation is provided", async () => {
    const adapter = {
      send: vi.fn(),
      setReceiver: vi.fn(),
      setConnectionListener: vi.fn(),
      ready: vi.fn(),
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ sessions: [{ id: "session-a" }] }),
    });
    const data = new HostDataGateway(adapter, {
      fetchImpl,
      location: { origin: "http://127.0.0.1:4000" },
    });

    await expect(data.listAllSessions("workspace-a")).resolves.toMatchObject({
      sessions: [{ id: "session-a" }],
    });

    expect(adapter.ready).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][0].toString()).toBe(
      "http://127.0.0.1:4000/v2/sessions?workspaceId=workspace-a",
    );
  });

  it("falls back to the websocket request when the HTTP session list hangs", async () => {
    vi.useFakeTimers();
    try {
      const adapter = createInMemoryRuntimeAdapter();
      const fetchImpl = vi.fn(() => new Promise(() => {}));
      const data = new HostDataGateway(adapter, {
        fetchImpl,
        location: { origin: "http://127.0.0.1:4000" },
        sessionListHttpTimeoutMs: 100,
      });

      const response = data.listAllSessions("workspace-a");
      expect(adapter.takeSent()).toBeUndefined();

      await vi.advanceTimersByTimeAsync(100);
      const sent = adapter.takeSent();
      expect(sent).toMatchObject({
        type: "data_request",
        operation: "list_all_sessions",
        workspaceId: "workspace-a",
      });

      adapter.receive({
        type: "data_response",
        requestId: sent.requestId,
        sessions: [{ id: "session-a" }],
      });
      await expect(response).resolves.toMatchObject({
        sessions: [{ id: "session-a" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends search_sessions with the query text", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const data = new HostDataGateway(adapter);
    const response = data.searchSessions("workspace-a", "widget");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "data_request",
      operation: "search_sessions",
      workspaceId: "workspace-a",
      query: "widget",
    });
    adapter.receive({
      type: "data_response",
      requestId: sent.requestId,
      results: [{ sessionId: "session-a" }],
    });
    await expect(response).resolves.toMatchObject({
      results: [{ sessionId: "session-a" }],
    });
  });

  it("sends cost_dashboard for the workspace", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const data = new HostDataGateway(adapter);
    const response = data.costDashboard("workspace-a");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "data_request",
      operation: "cost_dashboard",
      workspaceId: "workspace-a",
    });
    adapter.receive({
      type: "data_response",
      requestId: sent.requestId,
      dashboard: { summary: { sessionCount: 2 } },
    });
    await expect(response).resolves.toMatchObject({
      dashboard: { summary: { sessionCount: 2 } },
    });
  });
});
