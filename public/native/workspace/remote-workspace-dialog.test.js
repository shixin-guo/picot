import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../../i18n.js";
import { setupRemoteWorkspaceDialog } from "./remote-workspace-dialog.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

async function flushPromises(count = 10) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

function trigger() {
  const button = document.createElement("button");
  button.id = "open-remote-btn";
  document.body.append(button);
  return button;
}

function field(name) {
  return document.querySelector(`.remote-workspace-dialog [data-field="${name}"]`);
}

function click(action) {
  document.querySelector(`.remote-workspace-dialog [data-action="${action}"]`).click();
}

describe("remote-workspace-dialog", () => {
  let invoke;

  beforeEach(async () => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/locales/")) return { ok: true, json: async () => enMessages };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
    invoke = vi.fn(async () => "/Users/me/.picot/remotes/ubuntu@10.0.0.5/app");
    globalThis.__TAURI__ = { core: { invoke } };
  });

  afterEach(() => {
    delete globalThis.__TAURI__;
    delete window.__picotConfigCall;
  });

  it("hides the trigger when there is no native shell to open a window", () => {
    delete globalThis.__TAURI__;
    const button = trigger();
    setupRemoteWorkspaceDialog({ buttonEl: button });
    expect(button.classList.contains("hidden")).toBe(true);
  });

  it("offers saved hosts and ~/.ssh/config suggestions", async () => {
    window.__picotConfigCall = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") {
        return {
          ok: true,
          data: {
            hosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } },
            sshConfigHosts: [{ alias: "builder", host: "10.0.0.9", user: "root" }],
          },
        };
      }
      throw new Error(`unexpected op ${op}`);
    });

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();

    const options = [...field("savedHost").querySelectorAll("option")].map((o) => o.value);
    expect(options).toContain("gpu-box");
    expect(options).toContain("ssh-config:builder");
  });

  it("copies an ~/.ssh/config pick into the manual fields", async () => {
    window.__picotConfigCall = vi.fn(async () => ({
      ok: true,
      data: {
        hosts: {},
        sshConfigHosts: [{ alias: "builder", host: "10.0.0.9", user: "root", port: 2022 }],
      },
    }));

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();

    const select = field("savedHost");
    select.value = "ssh-config:builder";
    select.dispatchEvent(new Event("change"));

    expect(field("host").value).toBe("10.0.0.9");
    expect(field("user").value).toBe("root");
    expect(field("port").value).toBe("2022");
    expect(field("alias").value).toBe("builder");
    expect(select.value).toBe("");
  });

  it("keeps the config alias so ssh resolves the Host block itself", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") {
        return {
          ok: true,
          data: {
            hosts: {},
            sshConfigHosts: [
              {
                alias: "builder",
                host: "10.0.0.9",
                user: "root",
                port: 2022,
                configAlias: "builder",
              },
            ],
          },
        };
      }
      if (op === "set_ssh_host") return { ok: true, data: {} };
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    const select = field("savedHost");
    select.value = "ssh-config:builder";
    select.dispatchEvent(new Event("change"));
    field("remotePath").value = "/srv/app";
    click("connect");
    await flushPromises();

    expect(call).toHaveBeenCalledWith("set_ssh_host", {
      alias: "builder",
      config: expect.objectContaining({ configAlias: "builder" }),
    });
  });

  it("drops the config alias once the connection is edited by hand", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") {
        return {
          ok: true,
          data: {
            hosts: {},
            sshConfigHosts: [{ alias: "builder", host: "10.0.0.9", configAlias: "builder" }],
          },
        };
      }
      if (op === "set_ssh_host") return { ok: true, data: {} };
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    const select = field("savedHost");
    select.value = "ssh-config:builder";
    select.dispatchEvent(new Event("change"));
    // The alias no longer describes this connection, so ssh must not resolve it.
    field("host").value = "10.0.0.10";
    field("remotePath").value = "/srv/app";
    click("connect");
    await flushPromises();

    const [, payload] = call.mock.calls.find(([op]) => op === "set_ssh_host");
    expect(payload.config.configAlias).toBeUndefined();
  });

  it("saves a newly typed host before opening the workspace", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") return { ok: true, data: { hosts: {}, sshConfigHosts: [] } };
      if (op === "set_ssh_host") return { ok: true, data: {} };
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    field("host").value = "10.0.0.5";
    field("user").value = "ubuntu";
    field("alias").value = "gpu-box";
    field("remotePath").value = "/srv/app";
    click("connect");
    await flushPromises();

    expect(call).toHaveBeenCalledWith("set_ssh_host", {
      alias: "gpu-box",
      config: expect.objectContaining({ host: "10.0.0.5", user: "ubuntu" }),
    });
    // Saved, so the workspace binds by alias rather than copying credentials.
    expect(invoke).toHaveBeenCalledWith("open_remote_workspace", {
      connection: expect.objectContaining({ hostRef: "gpu-box", remotePath: "/srv/app" }),
      password: null,
    });
  });

  it("refuses to connect without a remote path", async () => {
    window.__picotConfigCall = vi.fn(async () => ({
      ok: true,
      data: { hosts: {}, sshConfigHosts: [] },
    }));

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    field("host").value = "10.0.0.5";
    click("connect");
    await flushPromises();

    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector("[data-status]").textContent).toBe(
      enMessages.remoteWorkspace.remotePathRequired,
    );
  });

  it("stays usable with no config channel, which is the launcher case", async () => {
    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();

    expect(document.querySelector('[data-action="test"]').disabled).toBe(true);
    expect(document.querySelector('[data-action="browse"]').disabled).toBe(true);
    expect(document.querySelector("[data-status]").textContent).toBe(
      enMessages.remoteWorkspace.needsSession,
    );

    field("host").value = "10.0.0.5";
    field("remotePath").value = "/srv/app";
    click("connect");
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith("open_remote_workspace", {
      connection: expect.objectContaining({ host: "10.0.0.5", remotePath: "/srv/app" }),
      password: null,
    });
  });

  it("hands the password to the new window instead of saving it anywhere", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") return { ok: true, data: { hosts: {}, sshConfigHosts: [] } };
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    const dialog = setupRemoteWorkspaceDialog({ buttonEl: trigger() });
    dialog.open();
    await flushPromises();
    field("host").value = "10.0.0.5";
    field("remotePath").value = "/srv/app";
    field("password").value = "hunter2";
    click("connect");
    await flushPromises();

    expect(invoke).toHaveBeenCalledWith("open_remote_workspace", {
      connection: expect.objectContaining({ host: "10.0.0.5" }),
      password: "hunter2",
    });
    // Nothing wrote it to the registry, and closing clears the field.
    expect(call).not.toHaveBeenCalledWith("set_ssh_host", expect.anything());
    expect(field("password").value).toBe("");
  });

  it("passes the password along to a connection test", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") return { ok: true, data: { hosts: {}, sshConfigHosts: [] } };
      if (op === "test_ssh_remote_config") {
        return { ok: true, data: { ok: true, remotePath: "/home/ubuntu" } };
      }
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    field("host").value = "10.0.0.5";
    field("password").value = "hunter2";
    click("test");
    await flushPromises();

    expect(call).toHaveBeenCalledWith("test_ssh_remote_config", {
      config: expect.objectContaining({ host: "10.0.0.5" }),
      password: "hunter2",
    });
  });

  it("saves a host from the dialog and selects it", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") return { ok: true, data: { hosts: {}, sshConfigHosts: [] } };
      if (op === "set_ssh_host") {
        return { ok: true, data: { hosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } } } };
      }
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    field("host").value = "10.0.0.5";
    field("user").value = "ubuntu";
    field("alias").value = "gpu-box";
    click("save-host");
    await flushPromises();

    expect(call).toHaveBeenCalledWith("set_ssh_host", {
      alias: "gpu-box",
      config: expect.objectContaining({ host: "10.0.0.5", user: "ubuntu" }),
    });
    expect(field("savedHost").value).toBe("gpu-box");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("deletes a saved host only on the second click", async () => {
    const call = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") {
        return {
          ok: true,
          data: { hosts: { "gpu-box": { host: "10.0.0.5" } }, sshConfigHosts: [] },
        };
      }
      if (op === "delete_ssh_host") return { ok: true, data: { hosts: {} } };
      throw new Error(`unexpected op ${op}`);
    });
    window.__picotConfigCall = call;

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    const select = field("savedHost");
    select.value = "gpu-box";
    select.dispatchEvent(new Event("change"));

    click("delete-host");
    await flushPromises();
    expect(call).not.toHaveBeenCalledWith("delete_ssh_host", expect.anything());

    click("delete-host");
    await flushPromises();
    expect(call).toHaveBeenCalledWith("delete_ssh_host", { alias: "gpu-box" });
    expect([...select.querySelectorAll("option")].map((o) => o.value)).toEqual([""]);
  });

  it("opens on an existing binding when the header pill hands one over", async () => {
    window.__picotConfigCall = vi.fn(async () => ({
      ok: true,
      data: { hosts: { "gpu-box": { host: "10.0.0.5" } }, sshConfigHosts: [] },
    }));

    const dialog = setupRemoteWorkspaceDialog({ buttonEl: trigger() });
    dialog.open({ prefill: { hostRef: "gpu-box", remotePath: "/srv/app" } });
    await flushPromises();

    expect(field("savedHost").value).toBe("gpu-box");
    expect(field("remotePath").value).toBe("/srv/app");
  });

  it("shows a status banner when reopened after an auth failure", async () => {
    window.__picotConfigCall = vi.fn(async () => ({
      ok: true,
      data: { hosts: {}, sshConfigHosts: [] },
    }));

    const dialog = setupRemoteWorkspaceDialog({ buttonEl: trigger() });
    dialog.open({
      prefill: { host: "10.0.0.5", remotePath: "/srv/app" },
      statusMessage: "Reconnect please",
    });
    await flushPromises();

    const status = document.querySelector(".remote-workspace-dialog [data-status]");
    expect(status.textContent).toBe("Reconnect please");
    expect(status.classList.contains("hidden")).toBe(false);
    expect(status.dataset.tone).toBe("error");
  });

  it("reports open/closed state for callers that reopen it programmatically", async () => {
    window.__picotConfigCall = vi.fn(async () => ({
      ok: true,
      data: { hosts: {}, sshConfigHosts: [] },
    }));

    const dialog = setupRemoteWorkspaceDialog({ buttonEl: trigger() });
    expect(dialog.isOpen()).toBe(false);
    dialog.open();
    await flushPromises();
    expect(dialog.isOpen()).toBe(true);
    click("cancel");
    expect(dialog.isOpen()).toBe(false);
  });

  it("browses the remote host and fills the path from the listing", async () => {
    window.__picotConfigCall = vi.fn(async (op, params) => {
      if (op === "get_ssh_hosts") return { ok: true, data: { hosts: {}, sshConfigHosts: [] } };
      if (op === "list_ssh_remote_dir") {
        return params.path === "/home/ubuntu/code"
          ? { ok: true, data: { path: "/home/ubuntu/code", directories: [] } }
          : { ok: true, data: { path: "/home/ubuntu", directories: ["code", "notes"] } };
      }
      throw new Error(`unexpected op ${op}`);
    });

    setupRemoteWorkspaceDialog({ buttonEl: trigger() }).open();
    await flushPromises();
    field("host").value = "10.0.0.5";
    click("browse");
    await flushPromises();

    expect(field("remotePath").value).toBe("/home/ubuntu");
    const rows = [...document.querySelectorAll(".remote-workspace-browser-item")];
    expect(rows.map((row) => row.textContent)).toEqual([
      enMessages.remoteWorkspace.parentDirectory,
      "code",
      "notes",
    ]);

    rows[1].click();
    await flushPromises();
    expect(field("remotePath").value).toBe("/home/ubuntu/code");
  });
});
