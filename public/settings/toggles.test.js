import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SUPER_AGENT_ENABLED_STORAGE_KEY } from "../super-agent/settings.js";
import { setupSettingsToggles } from "./toggles.js";

describe("thinking effort cycle controls", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  test("labels the composer thinking control clearly while keeping button cycling", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const thinkingBtn = document.querySelector("#thinking-btn");

    expect(thinkingBtn.tagName).toBe("BUTTON");
    expect(thinkingBtn.textContent.trim()).toBe("Think off");
    expect(thinkingBtn.getAttribute("title")).toContain("Click to cycle");
  });

  test("describes thinking effort in Settings without changing it to a dropdown", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const settingsButton = document.querySelector("#btn-thinking-level");

    expect(document.querySelector("#setting-thinking .settings-label-main")?.textContent).toBe(
      "Thinking effort",
    );
    expect(document.querySelector("#setting-thinking .settings-label-sub")?.textContent).toBe(
      "Reasoning depth",
    );
    expect(settingsButton.tagName).toBe("BUTTON");
    expect(settingsButton.textContent.trim()).toBe("Thinking: off");
  });

  test("keeps Settings thinking effort as click-to-cycle behavior", async () => {
    const dom = new JSDOM('<button id="btn-thinking-level">Thinking: off</button>');
    const button = dom.window.document.querySelector("#btn-thinking-level");
    const rpcCommand = vi.fn().mockResolvedValue({ success: true, data: { level: "medium" } });
    const setCurrentThinkingLevel = vi.fn();
    const updateThinkingBtn = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      btnThinkingLevel: button,
      toggleShowThinking: null,
      toggleAuth: null,
      rpcCommand,
      getCurrentThinkingLevel: () => "off",
      setCurrentThinkingLevel,
      updateThinkingBtn,
    });

    button.click();
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledWith({ type: "cycle_thinking_level" });
    expect(button.textContent).toBe("Thinking: medium");
    expect(setCurrentThinkingLevel).toHaveBeenCalledWith("medium");
    expect(updateThinkingBtn).toHaveBeenCalled();
  });

  test("uses neutral styling for every thinking level chip state", () => {
    const css = readFileSync(join(process.cwd(), "public/style.css"), "utf8");
    const thinkingTagRule = css.match(/\.thinking-tag\s*\{[^}]+\}/)?.[0] || "";
    const composerThinkingTagRule =
      css.match(/\.composer-toolbar \.thinking-tag\s*\{[^}]+\}/)?.[0] || "";

    expect(thinkingTagRule).toContain("border: 1px solid var(--border)");
    expect(thinkingTagRule).toContain("color: var(--text-dim)");
    expect(thinkingTagRule).not.toContain("--thinking-accent");
    expect(composerThinkingTagRule).toContain("border-color: transparent");
  });

  test("moves Super Agent startup setting out of General", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;

    expect(document.querySelector('[data-settings-tab="chat"]')?.textContent.trim()).toBe(
      "Agent Inbox",
    );
    expect(
      document.querySelector('[data-settings-panel="general"] #setting-super-agent'),
    ).toBeNull();
  });

  test("persists Super Agent startup toggle and notifies the app", async () => {
    const dom = new JSDOM('<button id="toggle-super-agent" class="settings-toggle"></button>', {
      url: "http://localhost",
    });
    const toggle = dom.window.document.querySelector("#toggle-super-agent");
    const onSuperAgentEnabledChanged = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("localStorage", dom.window.localStorage);

    setupSettingsToggles({
      toggleAutoCompact: null,
      btnThinkingLevel: null,
      toggleShowThinking: null,
      toggleAuth: null,
      toggleSuperAgent: toggle,
      rpcCommand: vi.fn(),
      getCurrentThinkingLevel: () => "off",
      setCurrentThinkingLevel: vi.fn(),
      updateThinkingBtn: vi.fn(),
      onSuperAgentEnabledChanged,
    });

    expect(toggle.classList.contains("on")).toBe(false);

    toggle.click();
    await Promise.resolve();

    expect(localStorage.getItem(SUPER_AGENT_ENABLED_STORAGE_KEY)).toBe("true");
    expect(toggle.classList.contains("on")).toBe(true);
    expect(onSuperAgentEnabledChanged).toHaveBeenCalledWith(true);
  });
});
