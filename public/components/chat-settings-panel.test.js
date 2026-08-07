import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "./chat-settings-panel.js";

// The toggle persists to a cookie, but isSuperAgentEnabled() has a one-time
// migration that re-writes any legacy localStorage value back into the cookie.
// Both stores must be cleared together or a stale localStorage entry leaks in.
const SUPER_AGENT_COOKIE = "pi-studio-super-agent-enabled";

function clearSuperAgentPersistence() {
  document.cookie = `${SUPER_AGENT_COOKIE}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  localStorage.removeItem(SUPER_AGENT_COOKIE);
}

async function flushPromises(count = 8) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe("chat-settings-panel", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    clearSuperAgentPersistence();
    vi.restoreAllMocks();
  });

  it("renders Telegram doctor status and the Super Agent safety boundary", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url === "/api/chat-config") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            content: JSON.stringify({
              accounts: {
                "telegram-main": {
                  service: "telegram",
                  botToken: "token",
                  botUsername: "picot_shixin_bot",
                  channels: {
                    "dm-main": {
                      id: "6085028519",
                      name: "shixin",
                      dm: true,
                      access: { allowedUserIds: ["6085028519"] },
                    },
                  },
                },
              },
            }),
          }),
        };
      }
      if (url === "/api/chat-telegram/doctor") {
        return {
          ok: true,
          json: async () => ({
            success: true,
            report: {
              summary: "ready",
              checks: [
                {
                  id: "listener",
                  label: "Listener",
                  status: "ok",
                  message: "Telegram listener is connected.",
                },
                {
                  id: "security",
                  label: "Security",
                  status: "ok",
                  message: "Telegram is restricted to allowed user 6085028519.",
                },
              ],
            },
          }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const Panel = customElements.get("chat-settings-panel");
    const panel = new Panel();
    document.body.appendChild(panel);
    await flushPromises();

    expect(panel.querySelector("#setting-super-agent .settings-label-main")?.textContent).toBe(
      "Start automatically",
    );
    expect(panel.querySelector("#setting-super-agent .settings-label-sub")?.textContent).toBe(
      "Launch Agent Inbox when Picot opens",
    );
    expect(panel.querySelector("#toggle-super-agent")).not.toBeNull();
    expect(panel.querySelector("[data-token-input]")?.classList.contains("ui-input")).toBe(true);
    for (const button of panel.querySelectorAll("button[data-action]")) {
      expect(button.classList.contains("ui-button"), button.dataset.action).toBe(true);
    }
    expect(panel.textContent).toContain("Telegram listener is connected.");
    expect(panel.textContent).toContain("Telegram messages enter Agent Inbox first.");
    expect(panel.textContent).toContain("6085028519");
  });

  it("keeps the Super Agent startup toggle out of the General settings panel", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document: shellDocument } = dom.window;

    expect(shellDocument.querySelector('[data-settings-tab="chat"]')?.textContent.trim()).toBe(
      "Agent Inbox",
    );
    expect(
      shellDocument.querySelector('[data-settings-panel="general"] #setting-super-agent'),
    ).toBeNull();

    dom.window.close();
  });

  it("persists the Super Agent startup toggle as a cookie and notifies the app", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (url === "/api/chat-config") {
        return { ok: true, json: async () => ({ success: true, content: "{}" }) };
      }
      if (url === "/api/chat-telegram/doctor") {
        return {
          ok: true,
          json: async () => ({ success: true, report: { summary: "ready", checks: [] } }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    });

    const Panel = customElements.get("chat-settings-panel");
    const panel = new Panel();
    document.body.appendChild(panel);
    await flushPromises();

    const toggle = panel.querySelector("#toggle-super-agent");
    const changed = vi.fn();
    window.addEventListener("picot-super-agent-autostart-changed", changed);

    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("role")).toBe("switch");

    toggle.click();

    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.cookie).toContain(`${SUPER_AGENT_COOKIE}=true`);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].detail).toEqual({ enabled: true });

    toggle.click();

    expect(toggle.classList.contains("on")).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(document.cookie).toContain(`${SUPER_AGENT_COOKIE}=false`);
    expect(changed).toHaveBeenCalledTimes(2);

    window.removeEventListener("picot-super-agent-autostart-changed", changed);
  });
});

describe("chat-settings-panel Telegram connect flow", () => {
  // Each test injects window.__picotConfigCall to drive the transport layer
  // directly — the panel prefers it over fetch when present, so no fetch mock
  // is needed here. The deferred pattern lets us observe busy/cancel-button
  // state mid-flight and to resolve/reject on command.

  function installConfigCall(handlers) {
    const calls = [];
    const fn = vi.fn(async (op, params, options = {}) => {
      calls.push({ op, params, options });
      const handler = handlers[op];
      if (!handler) throw new Error(`__picotConfigCall: unhandled op ${op}`);
      return handler({ params, options, signal: options.signal });
    });
    window.__picotConfigCall = fn;
    return { fn, calls };
  }

  function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function setToken(panel, token) {
    const input = panel.querySelector("#telegram-bot-token");
    input.value = token;
    return input;
  }

  async function mountPanel(handlers) {
    installConfigCall(handlers);
    const Panel = customElements.get("chat-settings-panel");
    const panel = new Panel();
    document.body.appendChild(panel);
    await flushPromises();
    return panel;
  }

  it("rejects an empty bot token without leaving the busy state", async () => {
    const panel = await mountPanel({
      read_chat_config: () => ({ ok: true, data: { content: "{}" } }),
      telegram_doctor: () => ({ ok: true, data: { report: { summary: "ready", checks: [] } } }),
    });

    // Token is empty by default.
    panel.querySelector('[data-action="connect-telegram"]').click();
    await flushPromises();

    const status = panel.querySelector("[data-status]");
    expect(status.textContent).toBe("Paste your Telegram bot token first.");
    expect(panel.querySelector("#telegram-bot-token").disabled).toBe(false);
    expect(panel.querySelector('[data-action="connect-telegram"]').disabled).toBe(false);
    expect(panel.querySelector('[data-action="cancel-telegram"]').hidden).toBe(true);
  });

  it("surfaces a validation failure as an error and re-enables the form", async () => {
    const panel = await mountPanel({
      read_chat_config: () => ({ ok: true, data: { content: "{}" } }),
      telegram_doctor: () => ({ ok: true, data: { report: { summary: "ready", checks: [] } } }),
      telegram_validate: () => ({ ok: false, error: "Invalid bot token format" }),
    });
    setToken(panel, "not-a-real-token");

    panel.querySelector('[data-action="connect-telegram"]').click();
    await flushPromises();

    const status = panel.querySelector("[data-status]");
    expect(status.textContent).toBe("Invalid bot token format");
    expect(panel.querySelector('[data-action="connect-telegram"]').disabled).toBe(false);
    expect(panel.querySelector('[data-action="cancel-telegram"]').hidden).toBe(true);
    // No bind instructions should be rendered on failure.
    expect(panel.querySelector(".telegram-bind-title")).toBeNull();
  });

  it("renders bind instructions after validation and completes the bind", async () => {
    // Pause validate/bind so we can observe the mid-flight UI (instructions
    // appear after validate resolves but before bind completes).
    const validateDeferred = createDeferred();
    const bindDeferred = createDeferred();
    const panel = await mountPanel({
      read_chat_config: () => ({ ok: true, data: { content: "{}" } }),
      telegram_doctor: () => ({ ok: true, data: { report: { summary: "ready", checks: [] } } }),
      telegram_validate: () =>
        validateDeferred.promise.then(() => ({
          ok: true,
          data: {
            bot: { username: "picot_test_bot", webUrl: "https://t.me/picot_test_bot" },
            afterUpdateId: 42,
          },
        })),
      telegram_bind: () =>
        bindDeferred.promise.then(() => ({
          ok: true,
          data: {
            content: JSON.stringify({
              accounts: {
                "telegram-main": {
                  service: "telegram",
                  botUsername: "picot_test_bot",
                  channels: {
                    "dm-main": {
                      id: "111",
                      name: "dr_lin",
                      dm: true,
                      access: { allowedUserIds: ["111"] },
                    },
                  },
                },
              },
            }),
          },
        })),
      write_chat_config: () => ({ ok: true, data: {} }),
    });
    setToken(panel, "123:ABC");

    const updatedListener = vi.fn();
    window.addEventListener("picot-chat-config-updated", updatedListener);

    panel.querySelector('[data-action="connect-telegram"]').click();
    // Validate is in flight: the form is busy and the cancel button is visible.
    await flushPromises();
    expect(panel.querySelector('[data-action="connect-telegram"]').disabled).toBe(true);
    expect(panel.querySelector('[data-action="cancel-telegram"]').hidden).toBe(false);

    // Resolve validate → bind instructions render.
    validateDeferred.resolve();
    await flushPromises();
    expect(panel.querySelector(".telegram-bind-title")?.textContent).toBe(
      "Waiting for your Telegram DM…",
    );
    expect(panel.querySelector(".telegram-open-link").getAttribute("href")).toBe(
      "https://t.me/picot_test_bot",
    );

    // Resolve bind → success state, account card, cleared token, event fired.
    bindDeferred.resolve();
    await flushPromises();

    expect(panel.querySelector("#telegram-bot-token").value).toBe("");
    expect(panel.querySelector("[data-status]").textContent).toContain("Telegram connected");
    // Scope to the accounts list — the doctor card also uses .chat-account-name.
    const accountCard = panel.querySelector("[data-accounts-list] .chat-account-card");
    expect(accountCard.querySelector(".chat-account-name").textContent).toBe("@picot_test_bot");
    expect(accountCard.querySelector(".chat-account-detail").textContent).toContain("dr_lin");
    expect(updatedListener).toHaveBeenCalledTimes(1);
    // Bind instructions cleared after success.
    expect(panel.querySelector(".telegram-bind-title")).toBeNull();

    window.removeEventListener("picot-chat-config-updated", updatedListener);
  });

  it("aborts the in-flight setup when the user presses Cancel", async () => {
    const validateDeferred = createDeferred();
    const panel = await mountPanel({
      read_chat_config: () => ({ ok: true, data: { content: "{}" } }),
      telegram_doctor: () => ({ ok: true, data: { report: { summary: "ready", checks: [] } } }),
      telegram_validate: ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          validateDeferred.promise.then(resolve, reject);
        }),
    });
    setToken(panel, "123:ABC");

    panel.querySelector('[data-action="connect-telegram"]').click();
    await flushPromises();
    expect(panel.querySelector('[data-action="cancel-telegram"]').hidden).toBe(false);

    panel.querySelector('[data-action="cancel-telegram"]').click();
    await flushPromises();

    expect(panel.querySelector("[data-status]").textContent).toBe("Telegram setup canceled.");
    expect(panel.querySelector('[data-action="connect-telegram"]').disabled).toBe(false);
    expect(panel.querySelector('[data-action="cancel-telegram"]').hidden).toBe(true);
  });
});
