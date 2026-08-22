// ABOUTME: Covers the Advanced Configuration tab markdown editors ported from
// feature-v3: AGENTS.md and APPEND_SYSTEM.md load/save through the injected
// config gateway, with no JSON validation on plain-text content.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n, setLocale } from "../../i18n.js";
import { setupSettingsConfig } from "./settings-config.js";

describe("settings configuration tab editors", () => {
  let dom;
  let call;

  beforeEach(async () => {
    dom = new JSDOM(`
      <span id="inline-config-path"></span>
      <textarea id="inline-config-textarea"></textarea>
      <div id="inline-config-error" class="hidden"></div>
      <button id="inline-config-save">Save</button>
      <span id="agents-md-path"></span>
      <textarea id="agents-md-textarea"></textarea>
      <div id="agents-md-error" class="hidden"></div>
      <button id="agents-md-save">Save</button>
      <span id="append-system-md-path"></span>
      <textarea id="append-system-md-textarea"></textarea>
      <div id="append-system-md-error" class="hidden"></div>
      <button id="append-system-md-save">Save</button>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    call = vi.fn(async (operation) => {
      if (operation === "read_agent_config") {
        return {
          ok: true,
          data: { path: "/home/.pi/agent/settings.json", content: '{"foo":true}' },
        };
      }
      if (operation === "write_agent_config") return { ok: true };
      if (operation === "read_agents_md") {
        return {
          ok: true,
          data: { path: "/home/.pi/agent/AGENTS.md", content: "# Global rules", exists: true },
        };
      }
      if (operation === "write_agents_md") return { ok: true };
      if (operation === "read_append_system_md") {
        return {
          ok: true,
          data: { path: "/home/.pi/agent/APPEND_SYSTEM.md", content: "", exists: false },
        };
      }
      if (operation === "write_append_system_md") return { ok: true };
      throw new Error(`Unexpected operation: ${operation}`);
    });
    vi.stubGlobal("fetch", async (url) => {
      const locale = String(url).includes("/zh") ? "zh" : "en";
      const content = readFileSync(join(process.cwd(), "public/locales", `${locale}.json`), "utf8");
      return { ok: true, status: 200, json: async () => JSON.parse(content) };
    });
    await initI18n();
    await setLocale("en");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  function createEditors() {
    return setupSettingsConfig({ configGateway: { call } });
  }

  test("loads and pretty-prints settings.json", async () => {
    const editors = createEditors();
    await editors.loadInlineConfigEditor();

    expect(document.querySelector("#inline-config-path").textContent).toBe(
      "/home/.pi/agent/settings.json",
    );
    expect(document.querySelector("#inline-config-textarea").value).toBe('{\n  "foo": true\n}');
  });

  test("does not write invalid settings.json content", async () => {
    createEditors();
    document.querySelector("#inline-config-textarea").value = "{invalid";
    document.querySelector("#inline-config-save").click();

    // Validation fails client-side before any gateway call is made.
    expect(call).not.toHaveBeenCalledWith("write_agent_config", expect.anything());
    const errorEl = document.querySelector("#inline-config-error");
    expect(errorEl.classList.contains("hidden")).toBe(false);
    expect(errorEl.dataset.tone).toBe("error");
    expect(errorEl.textContent).toContain("Invalid JSON");
  });

  test("writes valid settings.json content", async () => {
    createEditors();
    document.querySelector("#inline-config-textarea").value = '{"foo":true}';
    document.querySelector("#inline-config-save").click();

    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        "write_agent_config",
        { content: '{"foo":true}' },
        undefined,
      ),
    );
  });

  test("loads AGENTS.md verbatim", async () => {
    const editors = createEditors();
    await editors.loadAgentsMdEditor();

    expect(document.querySelector("#agents-md-path").textContent).toBe("/home/.pi/agent/AGENTS.md");
    expect(document.querySelector("#agents-md-textarea").value).toBe("# Global rules");
  });

  test("writes AGENTS.md content without JSON validation", async () => {
    createEditors();
    document.querySelector("#agents-md-textarea").value = "Not JSON: just markdown {";
    document.querySelector("#agents-md-save").click();

    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith("write_agents_md", {
        content: "Not JSON: just markdown {",
      }),
    );
  });

  test("loads a missing APPEND_SYSTEM.md as empty content with its path", async () => {
    const editors = createEditors();
    await editors.loadAppendSystemMdEditor();

    expect(document.querySelector("#append-system-md-path").textContent).toBe(
      "/home/.pi/agent/APPEND_SYSTEM.md",
    );
    expect(document.querySelector("#append-system-md-textarea").value).toBe("");
  });

  test("writes APPEND_SYSTEM.md content", async () => {
    createEditors();
    document.querySelector("#append-system-md-textarea").value = "Always answer briefly.";
    document.querySelector("#append-system-md-save").click();

    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith("write_append_system_md", {
        content: "Always answer briefly.",
      }),
    );
  });

  test("shows the gateway error when an agents-md read fails", async () => {
    call.mockImplementation(async (operation) => {
      if (operation === "read_agents_md") return { ok: false, error: "disk on fire" };
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const editors = createEditors();
    await editors.loadAgentsMdEditor();

    const errorEl = document.querySelector("#agents-md-error");
    expect(errorEl.classList.contains("hidden")).toBe(false);
    expect(errorEl.textContent).toBe("disk on fire");
  });
});
