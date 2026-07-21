import { afterEach, describe, expect, it, vi } from "vitest";
import { setupNewSessionButton } from "./workspace-actions.js";

function installTauriInvoke(invoke) {
  globalThis.__TAURI__ = { core: { invoke } };
}

describe("workspace actions", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    delete globalThis.__TAURI__;
    vi.restoreAllMocks();
  });

  it("starts a new session from Command+N", async () => {
    document.body.innerHTML = '<button id="new-session-btn">New Session</button>';
    const invoke = vi.fn().mockResolvedValue(undefined);
    installTauriInvoke(invoke);
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({ info: { path: "/tmp/picot" } }),
    };

    setupNewSessionButton({ data, workspaceId: "workspace-a" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true }));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());

    expect(data.workspaceInfo).toHaveBeenCalledWith("workspace-a");
    expect(invoke).toHaveBeenCalledWith("open_new_session_in_workspace", {
      projectPath: "/tmp/picot",
    });
  });

  it("uses host API to create session when Tauri is unavailable", async () => {
    document.body.innerHTML = '<button id="new-session-btn">New Session</button>';
    // No Tauri installed — LAN/remote client
    delete globalThis.__TAURI__;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          workspaceId: "workspace-a",
          sessionId: "temporary-abc123",
          instanceId: "instance-xyz",
        }),
    });
    globalThis.fetch = fetchMock;

    const originalLocation = globalThis.window?.location;
    Object.defineProperty(globalThis, "location", {
      value: { href: "" },
      writable: true,
      configurable: true,
    });

    setupNewSessionButton({ data: {}, workspaceId: "workspace-a" });
    document.getElementById("new-session-btn").click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/v2/new-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "workspace-a" }),
    });
    await vi.waitFor(() =>
      expect(globalThis.location.href).toBe(
        "/app/workspaces/workspace-a/sessions/temporary-abc123",
      ),
    );

    if (originalLocation !== undefined) {
      Object.defineProperty(globalThis, "location", {
        value: originalLocation,
        writable: true,
        configurable: true,
      });
    }
    delete globalThis.fetch;
  });

  it("does not hijack Command+N while typing", async () => {
    document.body.innerHTML = `
      <button id="new-session-btn">New Session</button>
      <textarea id="composer"></textarea>
    `;
    const invoke = vi.fn().mockResolvedValue(undefined);
    installTauriInvoke(invoke);
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({ info: { path: "/tmp/picot" } }),
    };

    setupNewSessionButton({ data, workspaceId: "workspace-a" });
    document
      .getElementById("composer")
      .dispatchEvent(new KeyboardEvent("keydown", { key: "n", metaKey: true, bubbles: true }));

    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
  });
});
