import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initI18n } from "../i18n.js";
import "./ssh-hosts-manager.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

async function flushPromises(count = 10) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

function mount() {
  const element = document.createElement("ssh-hosts-manager");
  document.body.append(element);
  return element;
}

function rows(element) {
  return [...element.querySelectorAll(".ssh-hosts-row")];
}

describe("ssh-hosts-manager", () => {
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

  it("lists saved hosts with their connection details", async () => {
    window.__picotConfigCall = vi.fn(async () => ({
      ok: true,
      data: {
        hosts: {
          "gpu-box": { host: "10.0.0.5", user: "ubuntu", port: 2222, identityFile: "~/.ssh/id" },
          builder: { host: "10.0.0.9" },
        },
      },
    }));
    const element = mount();
    await flushPromises();

    expect(rows(element).map((row) => row.querySelector("strong").textContent)).toEqual([
      "builder",
      "gpu-box",
    ]);
    expect(rows(element)[1].querySelector(".ssh-hosts-row-detail").textContent).toBe(
      "ubuntu@10.0.0.5:2222 · ~/.ssh/id",
    );
  });

  it("shows the empty state when nothing is saved", async () => {
    window.__picotConfigCall = vi.fn(async () => ({ ok: true, data: { hosts: {} } }));
    const element = mount();
    await flushPromises();

    expect(element.querySelector("[data-empty]").classList.contains("hidden")).toBe(false);
  });

  it("adds a host and announces the change", async () => {
    const calls = [];
    window.__picotConfigCall = vi.fn(async (op, params) => {
      calls.push([op, params]);
      if (op === "get_ssh_hosts") return { ok: true, data: { hosts: {} } };
      if (op === "set_ssh_host") {
        return { ok: true, data: { hosts: { "gpu-box": params.config } } };
      }
      throw new Error(`unexpected op ${op}`);
    });
    const element = mount();
    await flushPromises();
    const changed = vi.fn();
    element.addEventListener("ssh-hosts-changed", changed);

    element.querySelector('[data-action="add-host"]').click();
    element.querySelector('[data-field="alias"]').value = "gpu-box";
    element.querySelector('[data-field="host"]').value = "10.0.0.5";
    element.querySelector('[data-field="user"]').value = "ubuntu";
    element.querySelector('[data-action="save-host"]').click();
    await flushPromises();

    expect(calls).toContainEqual([
      "set_ssh_host",
      { alias: "gpu-box", config: { host: "10.0.0.5", user: "ubuntu", identityFile: "" } },
    ]);
    expect(changed).toHaveBeenCalled();
    expect(rows(element)).toHaveLength(1);
    expect(element.querySelector("[data-editor]").classList.contains("hidden")).toBe(true);
  });

  it("refuses to save without a name or host", async () => {
    const calls = [];
    window.__picotConfigCall = vi.fn(async (op, params) => {
      calls.push([op, params]);
      return { ok: true, data: { hosts: {} } };
    });
    const element = mount();
    await flushPromises();

    element.querySelector('[data-action="add-host"]').click();
    element.querySelector('[data-action="save-host"]').click();
    await flushPromises();
    expect(element.querySelector("[data-hosts-status]").textContent).toBe("A name is required.");

    element.querySelector('[data-field="alias"]').value = "gpu-box";
    element.querySelector('[data-action="save-host"]').click();
    await flushPromises();
    expect(element.querySelector("[data-hosts-status]").textContent).toBe("Host is required.");
    expect(calls.map(([op]) => op)).not.toContain("set_ssh_host");
  });

  it("edits an existing host without letting its name change", async () => {
    const calls = [];
    window.__picotConfigCall = vi.fn(async (op, params) => {
      calls.push([op, params]);
      if (op === "get_ssh_hosts") {
        return { ok: true, data: { hosts: { "gpu-box": { host: "10.0.0.5", user: "ubuntu" } } } };
      }
      return { ok: true, data: { hosts: { "gpu-box": params.config } } };
    });
    const element = mount();
    await flushPromises();

    element.querySelector('[data-action="edit-host"]').click();
    expect(element.querySelector('[data-field="alias"]').disabled).toBe(true);
    expect(element.querySelector('[data-field="host"]').value).toBe("10.0.0.5");

    element.querySelector('[data-field="host"]').value = "10.0.0.6";
    element.querySelector('[data-action="save-host"]').click();
    await flushPromises();

    expect(calls).toContainEqual([
      "set_ssh_host",
      { alias: "gpu-box", config: { host: "10.0.0.6", user: "ubuntu", identityFile: "" } },
    ]);
  });

  it("requires a second click to delete a host", async () => {
    const calls = [];
    window.__picotConfigCall = vi.fn(async (op, params) => {
      calls.push([op, params]);
      if (op === "get_ssh_hosts") {
        return { ok: true, data: { hosts: { "gpu-box": { host: "10.0.0.5" } } } };
      }
      return { ok: true, data: { hosts: {} } };
    });
    const element = mount();
    await flushPromises();

    element.querySelector('[data-action="delete-host"]').click();
    await flushPromises();
    expect(calls.map(([op]) => op)).not.toContain("delete_ssh_host");
    expect(element.querySelector('[data-action="delete-host"]').textContent).toBe("Confirm delete");

    element.querySelector('[data-action="delete-host"]').click();
    await flushPromises();
    expect(calls).toContainEqual(["delete_ssh_host", { alias: "gpu-box" }]);
    expect(rows(element)).toHaveLength(0);
  });

  it("disarms a pending delete when another action is used", async () => {
    window.__picotConfigCall = vi.fn(async (op) => {
      if (op === "get_ssh_hosts") {
        return { ok: true, data: { hosts: { "gpu-box": { host: "10.0.0.5" } } } };
      }
      throw new Error(`unexpected op ${op}`);
    });
    const element = mount();
    await flushPromises();

    element.querySelector('[data-action="delete-host"]').click();
    await flushPromises();
    element.querySelector('[data-action="add-host"]').click();

    expect(element.querySelector('[data-action="delete-host"]').textContent).toBe("Delete");
  });

  it("surfaces a failing registry read instead of rendering stale hosts", async () => {
    window.__picotConfigCall = vi.fn(async () => ({ ok: false, error: "no runtime" }));
    const element = mount();
    await flushPromises();

    expect(element.querySelector("[data-hosts-status]").textContent).toBe("no runtime");
    expect(rows(element)).toHaveLength(0);
  });
});
