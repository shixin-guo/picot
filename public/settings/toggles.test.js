import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SUPER_AGENT_ENABLED_STORAGE_KEY } from "../super-agent/settings.js";
import { renderThinkingEffort, setupSettingsToggles } from "./toggles.js";

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

  test("renders thinking effort in Settings as a Faster↔Smarter segmented slider", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const dots = Array.from(
      document.querySelectorAll("#thinking-effort-steps .thinking-effort-dot"),
    );

    expect(document.querySelector("#setting-thinking .settings-label-main")?.textContent).toBe(
      "Thinking effort",
    );
    expect(document.querySelector("#setting-thinking .settings-label-sub")?.textContent).toBe(
      "Reasoning depth",
    );
    expect(dots.map((s) => s.dataset.level)).toEqual(["off", "minimal", "low", "medium", "high"]);
    const ends = Array.from(
      document.querySelectorAll(
        "#thinking-effort .thinking-effort-ends > span:not(.thinking-effort-name)",
      ),
    );
    expect(ends.map((e) => e.textContent.trim())).toEqual(["Faster", "Smarter"]);
    expect(document.querySelector("#thinking-effort-name")?.textContent.trim()).toBe("off");
    expect(document.querySelector("#thinking-effort-marker")).not.toBeNull();
  });

  test("sets the thinking level when a dot is clicked and moves the thumb", async () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html, { url: "http://localhost" });
    const { document } = dom.window;
    vi.stubGlobal("localStorage", dom.window.localStorage);
    const track = document.querySelector("#thinking-effort-steps");
    const thumb = document.querySelector("#thinking-effort-marker");
    const rpcCommand = vi.fn().mockResolvedValue({ success: true });
    const setCurrentThinkingLevel = vi.fn();
    const updateThinkingBtn = vi.fn();

    setupSettingsToggles({
      toggleAutoCompact: null,
      thinkingSteps: track,
      thinkingMarker: thumb,
      toggleShowThinking: null,
      toggleAuth: null,
      rpcCommand,
      getCurrentThinkingLevel: () => "off",
      setCurrentThinkingLevel,
      updateThinkingBtn,
    });

    const mediumDot = track.querySelector('[data-level="medium"]');
    mediumDot.click();
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledWith({ type: "set_thinking_level", level: "medium" });
    expect(setCurrentThinkingLevel).toHaveBeenCalledWith("medium");
    expect(updateThinkingBtn).toHaveBeenCalled();
    expect(mediumDot.classList.contains("active")).toBe(true);
    expect(mediumDot.getAttribute("aria-checked")).toBe("true");
    // Thumb over segment index 3 of 5 → left = calc(60% + 3px), width = calc(20% - 6px).
    expect(thumb.style.left).toBe("calc(60% + 3px)");
    expect(thumb.style.width).toBe("calc(20% - 6px)");
  });

  test("renderThinkingEffort highlights the active level and positions the thumb", () => {
    const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const track = document.querySelector("#thinking-effort-steps");
    const thumb = document.querySelector("#thinking-effort-marker");
    const name = document.querySelector("#thinking-effort-name");

    renderThinkingEffort("high", {
      thinkingSteps: track,
      thinkingMarker: thumb,
      thinkingName: name,
    });

    expect(track.querySelector('[data-level="high"]').classList.contains("active")).toBe(true);
    // segment index 4 of 5 → left = calc(80% + 3px).
    expect(thumb.style.left).toBe("calc(80% + 3px)");
    expect(name.textContent).toBe("high");
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
      thinkingSteps: null,
      thinkingMarker: null,
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
