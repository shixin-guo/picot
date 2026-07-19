import { describe, expect, it } from "vitest";
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
