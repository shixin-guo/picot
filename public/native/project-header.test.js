import { afterEach, describe, expect, it, vi } from "vitest";
import { setupProjectHeader } from "./project-header.js";

describe("project header", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows the full workspace path in the header pill", async () => {
    document.body.innerHTML = '<div id="workspace-indicator" class="hidden"></div>';
    const fullPath = "/Users/ShixinGuo/code/pi/pi-web-ui";
    const data = {
      workspaceInfo: vi.fn().mockResolvedValue({ info: { path: fullPath } }),
    };

    await setupProjectHeader({ data, workspaceId: "workspace-a" });

    const indicator = document.getElementById("workspace-indicator");
    expect(data.workspaceInfo).toHaveBeenCalledWith("workspace-a");
    expect(indicator.textContent).toBe(fullPath);
    expect(indicator.title).toBe(fullPath);
    expect(indicator.classList.contains("hidden")).toBe(false);
  });
});
