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

  it("passes the local (project scope) flag on install/remove", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const install = control.installPiPackage("npm:foo", { local: true });
    const installFrame = adapter.takeSent();
    expect(installFrame).toMatchObject({
      operation: "install_pi_package",
      source: "npm:foo",
      local: true,
    });
    adapter.receive({ type: "host_response", requestId: installFrame.requestId, ok: true });
    await expect(install).resolves.toBeUndefined();

    const remove = control.removePiPackage("npm:foo", { local: true });
    const removeFrame = adapter.takeSent();
    expect(removeFrame).toMatchObject({
      operation: "remove_pi_package",
      source: "npm:foo",
      local: true,
    });
    adapter.receive({ type: "host_response", requestId: removeFrame.requestId, ok: true });
    await expect(remove).resolves.toBeUndefined();
  });

  it("sends the source for an update request", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.updatePiPackage("npm:foo");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "update_pi_package",
      source: "npm:foo",
    });
    adapter.receive({ type: "host_response", requestId: sent.requestId, ok: true });
    await expect(response).resolves.toBeUndefined();
  });

  it("reports whether a disable returned a change", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.setPiPackageDisabled("npm:foo", "global", true, "/tmp");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "set_pi_package_disabled",
      source: "npm:foo",
      scope: "global",
      disabled: true,
      cwd: "/tmp",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "set_pi_package_disabled",
      changed: true,
    });
    await expect(response).resolves.toBe(true);
  });

  it("returns the new instance id after a runtime restart", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.restartRuntime("ws-1", "s-1");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "restart_runtime",
      workspaceId: "ws-1",
      sessionId: "s-1",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      operation: "restart_runtime",
      instanceId: "instance-new",
    });
    await expect(response).resolves.toBe("instance-new");
  });

  it("resolves a project path to a workspace id", async () => {
    const adapter = createInMemoryRuntimeAdapter();
    const control = new HostControlGateway(adapter);
    const response = control.resolveWorkspace("/tmp/project");
    const sent = adapter.takeSent();
    expect(sent).toMatchObject({
      type: "host_request",
      operation: "resolve_workspace",
      projectPath: "/tmp/project",
    });
    adapter.receive({
      type: "host_response",
      requestId: sent.requestId,
      workspaceId: "workspace-a",
    });
    await expect(response).resolves.toBe("workspace-a");
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
