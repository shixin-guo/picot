import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "./sa-chat-header.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("sa-chat-header", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<super-agent-runtime class="super-agent-runtime collapsed"></super-agent-runtime>';
    delete window.__picotConfigCall;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps service controls visible and can restore the task board", () => {
    const Header = customElements.get("sa-chat-header");
    const header = new Header();
    document.body.appendChild(header);

    expect(header.textContent).toContain("Telegram");
    expect(header.querySelector('[data-action="simulate"]')).toBeNull();

    const taskToggle = header.querySelector('[data-action="runtime"]');
    expect(taskToggle).not.toBeNull();

    taskToggle.click();

    expect(document.querySelector("super-agent-runtime").classList.contains("collapsed")).toBe(
      false,
    );
  });

  it("uses the regular header layout contract and exposes the mobile QR affordance", async () => {
    document.body.innerHTML = `
      <button id="lan-qr-btn" class="hidden"></button>
      <super-agent-runtime class="super-agent-runtime collapsed"></super-agent-runtime>
    `;
    const Header = customElements.get("sa-chat-header");
    const header = new Header();
    header.id = "super-agent-chat-header";
    document.body.appendChild(header);

    expect(header.classList.contains("header")).toBe(true);
    expect(header.classList.contains("super-agent-chat-header")).toBe(true);
    expect(header.querySelector(".header-left")).not.toBeNull();
    expect(header.querySelector(".header-right")).not.toBeNull();

    const qrButton = header.querySelector('[data-action="lan-qr"]');
    expect(qrButton).not.toBeNull();
    expect(qrButton.classList.contains("lan-qr-btn")).toBe(true);
    expect(qrButton.classList.contains("hidden")).toBe(true);

    document.getElementById("lan-qr-btn").classList.remove("hidden");
    await Promise.resolve();
    expect(qrButton.classList.contains("hidden")).toBe(false);

    const leftControls = [...header.querySelector(".header-left").children];
    expect(header.querySelector(".header-left").contains(qrButton)).toBe(true);
    expect(leftControls.indexOf(qrButton)).toBeLessThan(
      leftControls.indexOf(header.querySelector(".status")),
    );
  });

  it("disables service pills until matching chat accounts are configured", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        content: JSON.stringify({
          accounts: {
            "telegram-main": {
              service: "telegram",
              botToken: "token",
              channels: {},
            },
          },
        }),
      }),
    });

    const Header = customElements.get("sa-chat-header");
    const header = new Header();
    document.body.appendChild(header);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const telegram = header.querySelector('[data-action="telegram"]');

    expect(telegram.disabled).toBe(false);
    expect(telegram.classList.contains("connected")).toBe(true);
  });

  it("reloads service status when the native config gateway becomes ready", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false });

    const Header = customElements.get("sa-chat-header");
    const header = new Header();
    document.body.appendChild(header);
    await Promise.resolve();

    window.__picotConfigCall = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        content: JSON.stringify({
          accounts: {
            "telegram-main": {
              service: "telegram",
              botToken: "token",
              channels: {},
            },
          },
        }),
      },
    });
    window.dispatchEvent(new CustomEvent("picot-config-gateway-ready"));
    await Promise.resolve();
    await Promise.resolve();

    const telegram = header.querySelector('[data-action="telegram"]');
    expect(window.__picotConfigCall).toHaveBeenCalledWith("read_chat_config");
    expect(telegram.disabled).toBe(false);
    expect(telegram.classList.contains("connected")).toBe(true);
  });

  it("keeps the base header measurable while super agent mode is active", () => {
    const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");

    expect(css).not.toMatch(/body\.super-agent-active\s+\.header\s*\{[^}]*display:\s*none/i);
    expect(css).toMatch(
      /body\.super-agent-active\s+\.session-header\s*\{[^}]*visibility:\s*hidden/i,
    );
  });

  it("keeps the files panel out of the Super Agent right rail", () => {
    const css = fs.readFileSync(path.join(__dirname, "../style.css"), "utf8");

    expect(css).toMatch(/body\.super-agent-active\s+\.file-sidebar\s*\{[^}]*display:\s*none/i);
  });
});
