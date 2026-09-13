import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n.js";
import "./ssh-remote-settings-panel.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

async function flushPromises(count = 10) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

function mountPanel() {
  const nav = document.createElement("button");
  nav.className = "settings-nav-item";
  nav.dataset.settingsTab = "ssh-remote";
  document.body.append(nav);
  const panel = document.createElement("ssh-remote-settings-panel");
  document.body.append(panel);
  return panel;
}

/** The panel asks for both scopes on load; answer them with one stub. */
function stubConfig({ config, hosts = {}, trusted = true, path = "/ws/.pi/settings.json", extra }) {
  const calls = [];
  window.__picotConfigCall = vi.fn(async (op, params) => {
    calls.push([op, params]);
    if (op === "get_ssh_remote_config") {
      return { ok: true, data: { config, hosts, trusted, path } };
    }
    if (op === "get_ssh_hosts") return { ok: true, data: { hosts, sshConfigHosts: [] } };
    const handled = extra?.(op, params);
    if (handled) return handled;
    throw new Error(`unexpected op ${op}`);
  });
  return calls;
}

describe("ssh-remote-settings-panel", () => {
  beforeEach(async () => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/locales/")) return { ok: true, json: async () => enMessages };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
  });

  afterEach(() => {
    delete window.__picotConfigCall;
  });

  it("says where the project runs and keeps the editor collapsed", async () => {
    stubConfig({
      config: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" },
      hosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } },
    });
    const panel = mountPanel();
    await flushPromises();

    expect(panel.querySelector("[data-binding-summary]").textContent).toBe(
      "This project runs on gpu-box · ubuntu@10.0.0.5 /srv/app",
    );
    expect(panel.querySelector("[data-binding-form]").classList.contains("hidden")).toBe(true);
    expect(panel.querySelector("[data-settings-path]").textContent).toBe("/ws/.pi/settings.json");

    panel.querySelector('[data-action="edit"]').click();
    expect(panel.querySelector("[data-binding-form]").classList.contains("hidden")).toBe(false);
  });

  it("reports a local project and hides the switch-back action", async () => {
    stubConfig({ config: { enabled: false, host: "" } });
    const panel = mountPanel();
    await flushPromises();

    expect(panel.querySelector("[data-binding-summary]").textContent).toBe(
      "This project runs locally.",
    );
    expect(panel.querySelector('[data-action="disable"]').classList.contains("hidden")).toBe(true);
  });

  it("disables the form for an untrusted project", async () => {
    stubConfig({ config: { enabled: true, host: "example.com" }, trusted: false });
    const panel = mountPanel();
    await flushPromises();

    expect(panel.querySelector("[data-untrusted-notice]").classList.contains("hidden")).toBe(false);
    expect(panel.querySelector('[data-binding-form] [data-field="host"]').disabled).toBe(true);
    expect(panel.querySelector('[data-binding-form] [data-action="save"]').disabled).toBe(true);
  });

  it("blocks save and shows an error without a host", async () => {
    const calls = stubConfig({ config: { enabled: false, host: "" } });
    const panel = mountPanel();
    await flushPromises();

    panel.querySelector('[data-binding-form] [data-action="save"]').click();
    await flushPromises();

    expect(panel.querySelector("[data-status]").textContent).toBe("Host is required.");
    expect(calls.map(([op]) => op)).not.toContain("set_ssh_remote_config");
  });

  it("saves an inline binding as enabled", async () => {
    const calls = stubConfig({
      config: { enabled: false, host: "" },
      extra: (op, params) =>
        op === "set_ssh_remote_config" ? { ok: true, data: { config: params.config } } : null,
    });
    const panel = mountPanel();
    await flushPromises();

    panel.querySelector('[data-action="edit"]').click();
    panel.querySelector('[data-binding-form] [data-field="host"]').value = "example.com";
    panel.querySelector('[data-binding-form] [data-action="save"]').click();
    await flushPromises();

    expect(calls).toContainEqual([
      "set_ssh_remote_config",
      {
        config: { enabled: true, host: "example.com", user: "", remotePath: "", identityFile: "" },
      },
    ]);
    expect(panel.querySelector("[data-status]").textContent).toBe("Saved.");
  });

  it("switches the project back to local while keeping the binding", async () => {
    const calls = stubConfig({
      config: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" },
      hosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } },
      extra: (op, params) =>
        op === "set_ssh_remote_config" ? { ok: true, data: { config: params.config } } : null,
    });
    const panel = mountPanel();
    await flushPromises();

    panel.querySelector('[data-action="disable"]').click();
    await flushPromises();

    expect(calls).toContainEqual([
      "set_ssh_remote_config",
      { config: { enabled: false, hostRef: "gpu-box", remotePath: "/srv/app" } },
    ]);
    expect(panel.querySelector("[data-binding-summary]").textContent).toBe(
      "This project runs locally.",
    );
  });

  it("hides the fields a saved host owns", async () => {
    stubConfig({
      config: { enabled: true, hostRef: "gpu-box", remotePath: "/srv/app" },
      hosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } },
    });
    const panel = mountPanel();
    await flushPromises();

    expect(panel.querySelector('[data-field="hostRef"]').value).toBe("gpu-box");
    const hostField = panel
      .querySelector('[data-binding-form] [data-field="host"]')
      .closest(".ssh-remote-field");
    expect(hostField.classList.contains("hidden")).toBe(true);
  });

  it("keeps a deleted alias visible instead of reading it as an inline host", async () => {
    stubConfig({ config: { enabled: true, hostRef: "gone", remotePath: "/srv/app" }, hosts: {} });
    const panel = mountPanel();
    await flushPromises();

    const select = panel.querySelector('[data-binding-form] [data-field="hostRef"]');
    expect(select.value).toBe("gone");
    expect(select.selectedOptions[0].textContent).toBe("gone (no longer saved)");
  });

  it("re-renders the alias list when the host registry changes", async () => {
    stubConfig({ config: { enabled: false, host: "" }, hosts: {} });
    const panel = mountPanel();
    await flushPromises();

    panel.dispatchEvent(
      new CustomEvent("ssh-hosts-changed", {
        detail: { hosts: { builder: { host: "10.0.0.9", user: "root" } } },
      }),
    );

    const options = [
      ...panel.querySelectorAll('[data-binding-form] [data-field="hostRef"] option'),
    ].map((option) => option.value);
    expect(options).toContain("builder");
  });

  it("renders a failed connection test", async () => {
    stubConfig({
      config: { enabled: true, host: "example.com" },
      extra: (op) =>
        op === "test_ssh_remote_config"
          ? { ok: true, data: { ok: false, message: "Connection refused" } }
          : null,
    });
    const panel = mountPanel();
    await flushPromises();

    panel.querySelector('[data-binding-form] [data-action="test"]').click();
    await flushPromises();

    expect(panel.querySelector("[data-status]").textContent).toBe(
      "Connection failed: Connection refused",
    );
  });
});
