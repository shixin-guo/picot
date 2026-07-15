import { describe, expect, test, vi } from "vitest";
import { createAppUpdater } from "./updater.js";

function createUpdaterHarness({ checkForUpdate } = {}) {
  document.body.innerHTML = `
    <meta name="app-version" content="1.0.0" />
    <span id="app-version"></span>
    <section id="updater-section"></section>
    <button id="check-updates">Check now</button>
    <div id="status-row" hidden><span id="status"></span></div>
    <div id="install-row" hidden>
      <span id="install-label"></span>
      <button id="install-update">Download & install</button>
    </div>
    <button id="sidebar-update" class="hidden">Update</button>
  `;

  const transport = {
    capabilities: { native: true },
    hasUpdater: true,
    isDev: vi.fn().mockResolvedValue(false),
    checkForUpdate:
      checkForUpdate ??
      vi.fn().mockResolvedValue({
        version: "1.1.0",
        currentVersion: "1.0.0",
      }),
    downloadAndInstallUpdate: vi.fn().mockImplementation(async (onProgress) => {
      onProgress?.({ phase: "started", contentLength: 100 });
      onProgress?.({ phase: "progress", downloaded: 100, contentLength: 100 });
      onProgress?.({ phase: "finished" });
    }),
    relaunchApp: vi.fn().mockResolvedValue(),
  };
  const onOpenSettings = vi.fn().mockResolvedValue();

  const updater = createAppUpdater({
    transport,
    appVersionValue: document.getElementById("app-version"),
    updaterSection: document.getElementById("updater-section"),
    checkUpdatesBtn: document.getElementById("check-updates"),
    updateStatusRow: document.getElementById("status-row"),
    updateStatusEl: document.getElementById("status"),
    updateInstallRow: document.getElementById("install-row"),
    updateInstallLabel: document.getElementById("install-label"),
    installUpdateBtn: document.getElementById("install-update"),
    sidebarUpdateBtn: document.getElementById("sidebar-update"),
    onOpenSettings,
  });

  return { updater, transport, onOpenSettings };
}

describe("createAppUpdater", () => {
  test("starts installing from the sidebar update button without opening settings", async () => {
    vi.useFakeTimers();
    try {
      const { updater, transport, onOpenSettings } = createUpdaterHarness();

      await updater.initUpdaterUI();
      document.getElementById("check-updates").click();
      await vi.waitFor(() => {
        expect(document.getElementById("sidebar-update").classList.contains("hidden")).toBe(false);
      });

      await updater.openUpdatesFromSidebar();

      expect(onOpenSettings).not.toHaveBeenCalled();
      expect(transport.downloadAndInstallUpdate).toHaveBeenCalledTimes(1);
      expect(document.getElementById("status").textContent).toBe("Update installed. Restarting...");
    } finally {
      vi.useRealTimers();
    }
  });

  test("keeps the sidebar update button hidden while checking for updates", async () => {
    let resolveCheck;
    const checkForUpdate = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const { updater } = createUpdaterHarness({ checkForUpdate });

    await updater.initUpdaterUI();
    document.getElementById("check-updates").click();

    expect(checkForUpdate).toHaveBeenCalledTimes(1);
    expect(document.getElementById("sidebar-update").classList.contains("hidden")).toBe(true);

    resolveCheck(null);
    await vi.waitFor(() => {
      expect(document.getElementById("status").textContent).toBe("You're on the latest version.");
    });
  });
});
