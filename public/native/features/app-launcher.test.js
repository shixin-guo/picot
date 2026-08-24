import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRemoteAuth: vi.fn(),
  pendingDeviceRequest: vi.fn(() => null),
  clearPendingDeviceRequest: vi.fn(),
  createDeviceAccessRequest: vi.fn(),
  claimDeviceAccess: vi.fn(),
}));

vi.mock("../../i18n.js", () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  t: (key) =>
    ({
      "launcher.title": "Projects",
      "launcher.hint": "Choose a project or saved session from the sidebar.",
      "launcher.composerHint": "Select a saved session to start chatting",
      "launcher.accessHint": "Request access from desktop Picot.",
      "launcher.requestAccess": "Request access",
      "launcher.requestingAccess": "Requesting access…",
      "launcher.waitingApproval": "Waiting for approval in desktop Picot…",
      "launcher.accessApproved": "Access approved.",
      "launcher.accessDenied": "Access denied.",
      "launcher.accessExpired": "Access expired.",
      "launcher.accessNetworkError": "Network error.",
      "launcher.invalidSession": "This saved session cannot be opened.",
    })[key] ?? key,
}));
vi.mock("../../themes.js", () => ({
  applyTheme: vi.fn(),
  getCurrentTheme: vi.fn(() => "night"),
}));
vi.mock("./remote-auth.js", () => ({
  DEVICE_TOKEN_KEY: "picot-remote-device-token",
  resolveRemoteAuth: mocks.resolveRemoteAuth,
  pendingDeviceRequest: mocks.pendingDeviceRequest,
  clearPendingDeviceRequest: mocks.clearPendingDeviceRequest,
  createDeviceAccessRequest: mocks.createDeviceAccessRequest,
  claimDeviceAccess: mocks.claimDeviceAccess,
}));

function renderShell() {
  document.documentElement.className = "swapping-instance-pending";
  document.body.className = "swapping-instance";
  document.body.innerHTML = `
    <div id="instance-swap-overlay" data-visible="true"></div>
    <div id="sidebar">
      <div class="sidebar-primary-nav"></div>
      <div id="session-list">Loading sessions...</div>
      <div class="sidebar-footer"></div>
    </div>
    <div id="sidebar-overlay"></div>
    <div class="session-header">
      <div class="header-left"><button id="sidebar-toggle"></button></div>
      <div class="header-right"></div>
    </div>
    <div id="messages">
      <div class="welcome"><p class="hint"></p><div class="shortcuts-hint"></div></div>
    </div>
    <button id="new-session-btn"></button>
    <button id="open-folder-btn"></button>
    <button id="refresh-sessions-btn"></button>
    <input id="session-search-input" />
    <button id="session-search-clear"></button>
    <div id="composer-card"><textarea id="message-input"></textarea><button></button></div>
  `;
  sessionStorage.setItem("pi-studio:swapping-instance", "1");
}

beforeEach(() => {
  vi.resetModules();
  window.dispatchEvent(new Event("pagehide"));
  mocks.resolveRemoteAuth.mockReset();
  mocks.pendingDeviceRequest.mockReset();
  mocks.pendingDeviceRequest.mockReturnValue(null);
  mocks.clearPendingDeviceRequest.mockReset();
  mocks.createDeviceAccessRequest.mockReset();
  mocks.claimDeviceAccess.mockReset();
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  sessionStorage.clear();
  renderShell();
});

describe("app launcher startup", () => {
  it("shows Request access without creating a runtime or paste form", async () => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });

    await import("./app-launcher.js?unpaired-remote");

    expect(document.getElementById("session-list").textContent).toBe("");
    expect(document.querySelector(".launcher-access button")?.textContent).toBe("Request access");
    expect(document.querySelector(".launcher-access")).not.toBeNull();
    expect(document.querySelector("input[type='text']")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
    expect(document.getElementById("message-input").disabled).toBe(true);
  });

  it("creates a request, polls pending, then stores the approved token and reloads", async () => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });
    mocks.createDeviceAccessRequest.mockResolvedValue({
      requestId: "request-1",
      deviceId: "device-1",
      claimSecret: "a".repeat(64),
      expiresAt: 4_000_000_000,
      pollAfterMs: 1,
    });
    mocks.claimDeviceAccess.mockResolvedValue({
      status: 200,
      body: { status: "approved", deviceToken: "device-token" },
    });
    const { setupRemoteAccessLauncher } = await import("./app-launcher.js?request-approved");
    const reload = vi.fn();
    const cleanup = setupRemoteAccessLauncher({ reload });
    document.querySelector(".launcher-access-button").click();
    await vi.waitFor(() => expect(mocks.claimDeviceAccess).toHaveBeenCalled());

    expect(document.querySelector(".launcher-access-status").textContent).toBe("Access approved.");
    expect(localStorage.getItem("picot-remote-device-token")).toBe("device-token");
    expect(mocks.clearPendingDeviceRequest).toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
    cleanup();
  });

  it("resumes pending requests and gates claims while hidden or offline", async () => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });
    mocks.pendingDeviceRequest.mockReturnValue({
      requestId: "request-1",
      deviceId: "device-1",
      claimSecret: "a".repeat(64),
      expiresAt: 4_000_000_000,
      pollAfterMs: 1,
    });
    mocks.claimDeviceAccess.mockResolvedValue({ status: 202, body: { status: "pending" } });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });

    await import("./app-launcher.js?pending-hidden");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.claimDeviceAccess).not.toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(mocks.claimDeviceAccess).toHaveBeenCalled());
    expect(document.querySelector(".launcher-access-status").textContent).toBe(
      "Waiting for approval in desktop Picot…",
    );
  });

  it.each([404, 410])("renders %s as expired and allows a fresh retry", async (status) => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });
    mocks.pendingDeviceRequest.mockReturnValue(null);
    mocks.claimDeviceAccess.mockResolvedValueOnce({ status, body: {} }).mockResolvedValueOnce({
      status: 200,
      body: { status: "approved", deviceToken: "fresh-token" },
    });
    mocks.createDeviceAccessRequest.mockResolvedValue({
      requestId: "request-new",
      deviceId: "device-1",
      claimSecret: "b".repeat(64),
      expiresAt: 4_000_000_000,
      pollAfterMs: 1,
    });

    const { setupRemoteAccessLauncher } = await import("./app-launcher.js?expired");
    mocks.pendingDeviceRequest.mockReturnValue({
      requestId: "request-old",
      deviceId: "device-1",
      claimSecret: "a".repeat(64),
      expiresAt: 4_000_000_000,
      pollAfterMs: 1,
    });
    const reload = vi.fn();
    const cleanup = setupRemoteAccessLauncher({ reload });
    await vi.waitFor(() =>
      expect(document.querySelector(".launcher-access-status").textContent).toBe("Access expired."),
    );
    expect(mocks.clearPendingDeviceRequest).toHaveBeenCalled();
    mocks.pendingDeviceRequest.mockReturnValue(null);
    document.querySelector(".launcher-access-button").click();
    await vi.waitFor(() => expect(reload).toHaveBeenCalled());
    expect(localStorage.getItem("picot-remote-device-token")).toBe("fresh-token");
    cleanup();
  });

  it("uses the server polling interval without polling early", async () => {
    vi.useFakeTimers();
    try {
      mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });
      mocks.pendingDeviceRequest.mockReturnValue(null);
      mocks.claimDeviceAccess.mockResolvedValue({ status: 202, body: { status: "pending" } });
      const { setupRemoteAccessLauncher } = await import("./app-launcher.js?backoff");
      mocks.pendingDeviceRequest.mockReturnValue({
        requestId: "request-1",
        deviceId: "device-1",
        claimSecret: "a".repeat(64),
        expiresAt: 4_000_000_000,
        pollAfterMs: 100,
      });
      const cleanup = setupRemoteAccessLauncher();
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.claimDeviceAccess).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(99);
      expect(mocks.claimDeviceAccess).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(mocks.claimDeviceAccess).toHaveBeenCalledTimes(2));
      cleanup();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders denial and network failures as retryable states", async () => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });
    mocks.createDeviceAccessRequest.mockResolvedValue({
      requestId: "request-1",
      deviceId: "device-1",
      claimSecret: "a".repeat(64),
      expiresAt: 4_000_000_000,
      pollAfterMs: 1,
    });
    mocks.claimDeviceAccess.mockResolvedValue({ status: 403, body: { status: "denied" } });

    await import("./app-launcher.js?request-denied");
    document.querySelector(".launcher-access-button").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".launcher-access-status").textContent).toBe("Access denied."),
    );
    expect(document.querySelector(".launcher-access-button").disabled).toBe(false);

    mocks.createDeviceAccessRequest.mockRejectedValueOnce(new Error("offline"));
    document.querySelector(".launcher-access-button").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".launcher-error").textContent).toBe("offline"),
    );
  });

  it("resolves a project before navigating and does not navigate on failure", async () => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });
    const { openLauncherSession } = await import("./app-launcher.js?session-navigation");
    const navigate = vi.fn();
    const control = { resolveWorkspace: vi.fn().mockResolvedValue("workspace-a") };
    const session = { id: "session-a", projectPath: "/projects/a" };

    await openLauncherSession(session, { control, navigate });

    expect(control.resolveWorkspace).toHaveBeenCalledWith("/projects/a");
    expect(navigate).toHaveBeenCalledWith("/app/workspaces/workspace-a/sessions/session-a");

    control.resolveWorkspace.mockRejectedValueOnce(new Error("project not found"));
    await expect(openLauncherSession(session, { control, navigate })).rejects.toThrow(
      "project not found",
    );
    expect(navigate).toHaveBeenCalledOnce();
  });
});
