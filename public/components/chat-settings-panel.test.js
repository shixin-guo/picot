import { beforeEach, describe, expect, it, vi } from "vitest";

import "./chat-settings-panel.js";

async function flushPromises(count = 8) {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

describe("chat-settings-panel", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
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
});
