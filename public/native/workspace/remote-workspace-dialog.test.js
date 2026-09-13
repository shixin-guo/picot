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
    });
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
