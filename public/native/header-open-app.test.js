import { afterEach, describe, expect, it, vi } from "vitest";
import { setupHeaderOpenApp } from "./header-open-app.js";

function renderControl() {
  document.body.innerHTML = `
    <span class="header-open-app hidden" id="header-open-app">
      <button id="header-open-app-btn"><span id="header-open-app-logo"></span></button>
      <button id="header-open-app-toggle"></button>
      <div class="header-open-app-menu hidden" id="header-open-app-menu"></div>
    </span>
  `;
}

describe("header open app", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
  });

  it("shows VS Code when installed and opens the workspace with its app name", async () => {
    renderControl();
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({ info: { path: "/tmp/picot" } }),
    };
    const control = {
      listInstalledApps: vi
        .fn()
        .mockResolvedValue([{ id: "vscode", label: "VS Code", appName: "Visual Studio Code" }]),
      openInApp: vi.fn().mockResolvedValue(undefined),
    };

    expect(setupHeaderOpenApp({ data, control, workspaceId: "workspace-a" })).toBe(true);
    await vi.waitFor(() =>
      expect(document.getElementById("header-open-app").classList.contains("hidden")).toBe(false),
    );

    expect(data.workspaceInfo).toHaveBeenCalledWith("workspace-a");
    expect(document.getElementById("header-open-app-btn").title).toContain("VS Code");
    document.getElementById("header-open-app-btn").click();
    await vi.waitFor(() => expect(control.openInApp).toHaveBeenCalled());
    expect(control.openInApp).toHaveBeenCalledWith("/tmp/picot", {
      appName: "Visual Studio Code",
      command: null,
    });
  });

  it("renders the app menu and uses the selected app", async () => {
    renderControl();
    const control = {
      listInstalledApps: vi.fn().mockResolvedValue([
        { id: "vscode", label: "VS Code", appName: "Visual Studio Code" },
        { id: "cursor", label: "Cursor", appName: "Cursor" },
      ]),
      openInApp: vi.fn().mockResolvedValue(undefined),
    };

    setupHeaderOpenApp({
      data: { workspaceInfo: vi.fn().mockResolvedValue({ info: { path: "/tmp/picot" } }) },
      control,
      workspaceId: "workspace-a",
    });
    await vi.waitFor(() =>
      expect(document.getElementById("header-open-app").classList.contains("hidden")).toBe(false),
    );

    document.getElementById("header-open-app-toggle").click();
    const items = [...document.querySelectorAll(".header-open-app-menu-item")];
    expect(items.map((item) => item.textContent.trim())).toEqual(["VS Code", "Cursor"]);
    items[1].click();

    await vi.waitFor(() => expect(control.openInApp).toHaveBeenCalled());
    expect(control.openInApp).toHaveBeenCalledWith("/tmp/picot", {
      appName: "Cursor",
      command: null,
    });
    expect(localStorage.getItem("picot-open-app")).toBe("cursor");
  });
});
