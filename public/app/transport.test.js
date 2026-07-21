import { describe, expect, test, vi } from "vitest";
import { createTransport, WsTransport } from "./transport.js";

function fakeWsClient(capabilities = { native: true }) {
  return {
    capabilities,
    sendControl: vi.fn((command) => Promise.resolve(`ok:${command}`)),
  };
}

describe("WsTransport", () => {
  test("create project (openWorkspace) sends an open_workspace control command", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: { location: { port: "47821" } } });

    await transport.openWorkspace("/tmp/proj", { forceNewSession: true, openWindow: false });

    expect(ws.sendControl).toHaveBeenCalledWith(
      "open_workspace",
      expect.objectContaining({ cwd: "/tmp/proj", forceNewSession: true, openWindow: false }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  test("create new session sends a new_session control command", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: {} });

    await transport.newSession(47999);

    expect(ws.sendControl).toHaveBeenCalledWith("new_session", { port: 47999 }, {});
  });

  test("switchSession sends a switch_session control command", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.switchSession("/tmp/session.jsonl", 47822);

    expect(ws.sendControl).toHaveBeenCalledWith(
      "switch_session",
      { sessionPath: "/tmp/session.jsonl", port: 47822 },
      {},
    );
  });

  test("fork sends a fork control command with the entry id", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.fork("entry-123", 47822);

    expect(ws.sendControl).toHaveBeenCalledWith("fork", { entryId: "entry-123", port: 47822 }, {});
  });

  test("native ops map to their control commands", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: { location: { port: "47821" } } });

    await transport.pickFolder();
    await transport.openExternal("https://example.com");

    expect(ws.sendControl).toHaveBeenCalledWith("pick_folder", {}, { timeoutMs: 0 });
    expect(ws.sendControl).toHaveBeenCalledWith(
      "open_external",
      { url: "https://example.com" },
      {},
    );
  });

  test("pickImageFiles sends a pick_image_files control command with initialDir and no timeout", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: { location: { port: "47821" } } });

    await transport.pickImageFiles("/tmp/workspace");

    expect(ws.sendControl).toHaveBeenCalledWith(
      "pick_image_files",
      { initialDir: "/tmp/workspace" },
      { timeoutMs: 0 },
    );
  });

  test("pickImageFiles sends null initialDir when no path is provided", async () => {
    const ws = fakeWsClient();
    const transport = createTransport({ wsClient: ws, env: { location: { port: "47821" } } });

    await transport.pickImageFiles();

    expect(ws.sendControl).toHaveBeenCalledWith(
      "pick_image_files",
      { initialDir: null },
      { timeoutMs: 0 },
    );
  });

  test("capabilities reflect the underlying ws client", () => {
    const transport = new WsTransport(fakeWsClient({ native: false }), {});
    expect(transport.capabilities.native).toBe(false);
    expect(transport.hasUpdater).toBe(false);
  });

  test("downloadAndInstallUpdate forwards the progress callback with no timeout", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});
    const onProgress = () => {};

    await transport.downloadAndInstallUpdate(onProgress);

    expect(ws.sendControl).toHaveBeenCalledWith(
      "download_and_install_update",
      {},
      { onProgress, timeoutMs: 0 },
    );
  });

  test("currentPort + brokerWsUrl derive from the environment", () => {
    const env = {
      location: { port: "48010", search: "?brokerWs=ws://x/ui-ws" },
      sessionStorage: { getItem: () => null, setItem: () => {} },
    };
    const transport = new WsTransport(fakeWsClient(), env);

    expect(transport.currentPort()).toBe(48010);
    expect(transport.brokerWsUrl()).toBe("ws://x/ui-ws");
  });

  test("relaunchApp swallows the disconnect that follows a host restart", async () => {
    const ws = {
      capabilities: { native: true },
      sendControl: vi.fn(() => Promise.reject(new Error("WebSocket disconnected"))),
    };
    const transport = new WsTransport(ws, {});

    await expect(transport.relaunchApp()).resolves.toBeUndefined();
  });

  test("ephemeral lifecycle methods issue their control commands", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.createEphemeral("side-chat");
    await transport.replaceQuickChat();
    await transport.closeEphemeral("inst-1", 2);
    await transport.getEphemeralBootstrap();
    await transport.updateEphemeralUi("inst-1", 2, { title: "Hi", unread: true });

    expect(ws.sendControl).toHaveBeenCalledWith(
      "ephemeral_create",
      { kind: "side-chat" },
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "ephemeral_close",
      {
        instanceId: "inst-1",
        generation: 2,
      },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith("ephemeral_bootstrap", {}, {});
    expect(ws.sendControl).toHaveBeenCalledWith(
      "ephemeral_update_ui",
      {
        instanceId: "inst-1",
        generation: 2,
        title: "Hi",
        unread: true,
      },
      {},
    );
  });

  test("workspace transition + close methods issue their control commands", async () => {
    const ws = fakeWsClient();
    const transport = new WsTransport(ws, {});

    await transport.prepareWorkspaceTarget("/tmp/b", { forceNewSession: true });
    await transport.commitWorkspaceTransition(7);
    await transport.cancelWorkspaceTransition(7);
    await transport.approveWindowClose("close-1");

    expect(ws.sendControl).toHaveBeenCalledWith(
      "workspace_target_prepare",
      expect.objectContaining({ targetCwd: "/tmp/b", forceNewSession: true }),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "workspace_transition_commit",
      {
        transitionGeneration: 7,
      },
      {},
    );
    expect(ws.sendControl).toHaveBeenCalledWith(
      "window_close_approve",
      { requestId: "close-1" },
      {},
    );
  });

  test("sendEphemeral forwards to the wsClient and returns its requestId", () => {
    const ws = {
      capabilities: { native: true },
      sendControl: vi.fn(),
      sendEphemeral: vi.fn(() => "ep-9"),
    };
    const transport = new WsTransport(ws, {});
    expect(transport.sendEphemeral("inst-1", 3, { type: "prompt" })).toBe("ep-9");
    expect(ws.sendEphemeral).toHaveBeenCalledWith("inst-1", 3, { type: "prompt" });
  });
});
