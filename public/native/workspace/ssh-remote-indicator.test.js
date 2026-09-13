import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../../i18n.js";
import {
  formatRemoteTarget,
  refreshSshRemoteIndicator,
  setupSshRemoteIndicator,
} from "./ssh-remote-indicator.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

function mountPill() {
  const button = document.createElement("button");
  button.id = "ssh-remote-indicator";
  button.className = "ssh-remote-indicator hidden";
  const label = document.createElement("span");
  label.dataset.sshRemoteLabel = "";
  button.append(label);
  document.body.append(button);
  return { button, label };
}

describe("ssh-remote-indicator", () => {
  beforeEach(async () => {
    document.body.replaceChildren();
    window.location.hash = "";
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/locales/")) return { ok: true, json: async () => enMessages };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
  });

  it("formats the target as user@host with its remote path", () => {
    expect(
      formatRemoteTarget({ host: "10.0.0.5", user: "ubuntu", port: 2222, remotePath: "/srv/app" }),
    ).toBe("ubuntu@10.0.0.5:2222 /srv/app");
    expect(formatRemoteTarget({ host: "10.0.0.5" })).toBe("10.0.0.5");
    expect(formatRemoteTarget(null)).toBe("");
  });

  it("shows the resolved target for a remote workspace", async () => {
    const { button, label } = mountPill();
    await refreshSshRemoteIndicator({
      call: async () => ({
        ok: true,
        data: {
          config: { enabled: true, hostRef: "gpu-box" },
          resolved: { enabled: true, host: "10.0.0.5", user: "ubuntu", remotePath: "/srv/app" },
        },
      }),
    });
    expect(button.classList.contains("hidden")).toBe(false);
    expect(label.textContent).toBe("ubuntu@10.0.0.5 /srv/app");
  });

  it("stays hidden for a local workspace", async () => {
    const { button } = mountPill();
    button.classList.remove("hidden");
    await refreshSshRemoteIndicator({
      call: async () => ({ ok: true, data: { config: { enabled: false, host: "" } } }),
    });
    expect(button.classList.contains("hidden")).toBe(true);
  });

  it("hides the pill when the config channel fails", async () => {
    const { button } = mountPill();
    button.classList.remove("hidden");
    await refreshSshRemoteIndicator({
      call: async () => {
        throw new Error("no runtime");
      },
    });
    expect(button.classList.contains("hidden")).toBe(true);
  });

  it("lets a stale probe lose to the newer one", async () => {
    const { button, label } = mountPill();
    let release;
    const slow = refreshSshRemoteIndicator({
      call: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              ok: true,
              data: { resolved: { enabled: true, host: "old-host", remotePath: "/old" } },
            });
        }),
    });
    await refreshSshRemoteIndicator({
      call: async () => ({
        ok: true,
        data: { resolved: { enabled: true, host: "new-host", remotePath: "/new" } },
      }),
    });
    release();
    await slow;
    expect(label.textContent).toBe("new-host /new");
    expect(button.classList.contains("hidden")).toBe(false);
  });

  it("opens the project's own settings tab when clicked", () => {
    const { button } = mountPill();
    setupSshRemoteIndicator();
    button.click();
    expect(window.location.hash).toBe("#/settings/ssh-remote");
  });
});
