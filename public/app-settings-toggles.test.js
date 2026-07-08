import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, test, vi } from "vitest";
import { setupSettingsToggles } from "./app-settings-toggles.js";

describe("thinking effort cycle controls", () => {
  test("labels the composer thinking control clearly while keeping button cycling", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const thinkingBtn = document.querySelector("#thinking-btn");

    expect(thinkingBtn.tagName).toBe("BUTTON");
    expect(thinkingBtn.textContent).toBe("Think off");
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
    expect(settingsButton.textContent).toBe("Thinking: off");
  });

  test("keeps Settings thinking effort as click-to-cycle behavior", async () => {
    // setupSettingsToggles reads globalThis.localStorage during init. JSDOM's
    // default opaque origin disables storage, so install a minimal in-memory
    // implementation just for this test.
    const memoryStore = new Map();
    const storageStub = {
      getItem: (key) => (memoryStore.has(key) ? memoryStore.get(key) : null),
      setItem: (key, value) => {
        memoryStore.set(key, String(value));
      },
      removeItem: (key) => {
        memoryStore.delete(key);
      },
      clear: () => memoryStore.clear(),
    };
    const previousLocalStorage = globalThis.localStorage;
    globalThis.localStorage = storageStub;
    try {
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
    } finally {
      globalThis.localStorage = previousLocalStorage;
    }
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
});
