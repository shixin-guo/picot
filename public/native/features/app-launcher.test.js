import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRemoteAuth: vi.fn(),
}));

vi.mock("../../i18n.js", () => ({
  initI18n: vi.fn().mockResolvedValue(undefined),
  t: (key) =>
    ({
      "launcher.title": "Projects",
      "launcher.hint": "Choose a project or saved session from the sidebar.",
      "launcher.composerHint": "Select a saved session to start chatting",
      "launcher.pairingRequired": "Pair this device to load projects.",
      "launcher.pairingHelp": "Paste a fresh Picot pairing link from the desktop.",
      "launcher.pairingInput": "Paste pairing link or token",
      "launcher.pairDevice": "Pair device",
      "launcher.invalidPairing": "Enter a valid, unused Picot pairing link.",
    })[key] ?? key,
}));
vi.mock("../../themes.js", () => ({
  applyTheme: vi.fn(),
  getCurrentTheme: vi.fn(() => "night"),
}));
vi.mock("./remote-auth.js", () => ({ resolveRemoteAuth: mocks.resolveRemoteAuth }));

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
  mocks.resolveRemoteAuth.mockReset();
  localStorage.clear();
  sessionStorage.clear();
  renderShell();
});

describe("app launcher startup", () => {
  it("clears the swap overlay and renders pairing failures without reloading", async () => {
    mocks.resolveRemoteAuth.mockRejectedValue(new Error("LAN pairing expired"));

    await import("./app-launcher.js?pairing-failure");

    expect(document.body.classList.contains("swapping-instance")).toBe(false);
    expect(document.getElementById("instance-swap-overlay").hasAttribute("data-visible")).toBe(
      false,
    );
    expect(sessionStorage.getItem("pi-studio:swapping-instance")).toBeNull();
    expect(document.querySelector(".launcher-error")?.textContent).toBe("LAN pairing expired");
    expect(document.getElementById("message-input").disabled).toBe(true);
  });

  it("shows an actionable pairing state for an unpaired LAN client", async () => {
    mocks.resolveRemoteAuth.mockResolvedValue({ clientType: "remote", deviceToken: "" });

    const { pairingPathFromInput } = await import("./app-launcher.js?unpaired-remote");

    expect(document.getElementById("session-list").textContent).toContain("Pair this device");
    expect(document.querySelector(".launcher-pairing input")?.placeholder).toBe(
      "Paste pairing link or token",
    );
    expect(document.querySelector(".launcher-pairing button")?.textContent).toBe("Pair device");
    const pairingInput = document.querySelector(".launcher-pairing input");
    pairingInput.value = "not-a-token";
    document.querySelector(".launcher-pairing").requestSubmit();
    expect(document.querySelector(".launcher-pairing-error")?.textContent).toContain(
      "valid, unused",
    );
    expect(document.getElementById("message-input").placeholder).toBe(
      "Select a saved session to start chatting",
    );
    expect(
      pairingPathFromInput(
        "https://calico.example.ts.net/app?pairingToken=picot_pair_fresh",
        "https://calico.example.ts.net",
      ),
    ).toBe("/app?pairingToken=picot_pair_fresh");
    expect(pairingPathFromInput("not-a-token", "https://calico.example.ts.net")).toBeNull();
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
