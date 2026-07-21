import { describe, expect, it } from "vitest";
import { HostControlGateway } from "./control-gateway.js";
import { createInMemoryRuntimeAdapter } from "./runtime-gateway.js";

describe("HostControlGateway", () => {
  it("lists configured pi packages via a host_request", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.listPiPackages();
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({ type: "host_request", operation: "list_pi_packages" });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "list_pi_packages",
      packages: ["npm:pi-web-access"],
    });
    await expect(response).resolves.toEqual(["npm:pi-web-access"]);
  });

  it("sends the source with install/remove requests", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const install = control.installPiPackage("npm:foo");
    const installFrame = adapter.takeSent();
    expect(installFrame).toMatchObject({
      type: "host_request",
      operation: "install_pi_package",
      source: "npm:foo",
    });
    adapter.receive({ type: "host_response", requestId: installFrame.requestId, ok: true });
    await expect(install).resolves.toBeUndefined();

    const remove = control.removePiPackage("npm:foo");
    const removeFrame = adapter.takeSent();
    expect(removeFrame).toMatchObject({ operation: "remove_pi_package", source: "npm:foo" });
    adapter.receive({ type: "host_response", requestId: removeFrame.requestId, ok: true });
    await expect(remove).resolves.toBeUndefined();
  });

  it("rejects the request when the host returns an error", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.installPiPackage("npm:bad");
    const sent = adapter.takeSent();
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      error: { message: "npm is not installed" },
    });
    await expect(response).rejects.toThrow("npm is not installed");
  });

  it("lists installed external apps", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.listInstalledApps();
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({ type: "host_request", operation: "list_installed_apps" });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "list_installed_apps",
      apps: [{ id: "vscode", label: "VS Code" }],
    });
    await expect(response).resolves.toEqual([{ id: "vscode", label: "VS Code" }]);
  });

  it("opens a workspace in an external app", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.openInApp("/tmp/picot", { appName: "Visual Studio Code" });
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "open_in_app",
      path: "/tmp/picot",
      appName: "Visual Studio Code",
      command: null,
    });
    adapter.receive({ type: "host_response", requestId: sent.requestId, ok: true });
    await expect(response).resolves.toBeUndefined();
  });

  it("deletes sessions by id and normalizes the deleted/errors arrays", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.deleteSessions(["s-1", "s-2"]);
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "delete_sessions",
      sessionIds: ["s-1", "s-2"],
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "delete_sessions",
      deleted: ["s-1"],
      errors: ["s-2"],
    });
    await expect(response).resolves.toEqual({ deleted: ["s-1"], errors: ["s-2"] });
  });

  it("rejects pending requests on disconnect", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.openExternal("https://example.com");
    adapter.disconnect();
    await expect(response).rejects.toThrow("disconnected");
  });
});
