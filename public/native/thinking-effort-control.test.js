import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupThinkingEffortControl } from "./thinking-effort-control.js";

describe("setupThinkingEffortControl", () => {
  let runtime;
  let getTarget;
  let onError;
  let container;

  beforeEach(() => {
    runtime = { request: vi.fn().mockResolvedValue({}) };
    getTarget = vi.fn().mockReturnValue({ sessionId: "test-session", instanceId: "test-instance" });
    onError = vi.fn();

    // Clear any existing elements
    document.body.innerHTML = "";

    // Setup DOM
    container = document.createElement("div");
    container.innerHTML = `
      <div class="thinking-effort" id="thinking-effort" role="radiogroup">
        <div class="thinking-effort-ends">
          <span>Faster</span>
          <span class="thinking-effort-name" id="thinking-effort-name">off</span>
          <span>Smarter</span>
        </div>
        <div class="thinking-effort-track">
          <span class="thinking-effort-thumb" id="thinking-effort-marker"></span>
          <button class="thinking-effort-dot" data-level="off" role="radio" aria-checked="true"></button>
          <button class="thinking-effort-dot" data-level="minimal" role="radio" aria-checked="false"></button>
          <button class="thinking-effort-dot" data-level="low" role="radio" aria-checked="false"></button>
          <button class="thinking-effort-dot" data-level="medium" role="radio" aria-checked="false"></button>
          <button class="thinking-effort-dot" data-level="high" role="radio" aria-checked="false"></button>
        </div>
      </div>
    `;
    document.body.appendChild(container);
  });

  it("sets up click handlers on radio buttons", async () => {
    const control = setupThinkingEffortControl({ runtime, getTarget, onError });
    expect(control).toBeTruthy();

    const buttons = document.querySelectorAll(".thinking-effort-dot");
    const lowButton = Array.from(buttons).find((btn) => btn.dataset.level === "low");

    lowButton.click();
    await vi.waitFor(() => {
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "set_thinking_level", level: "low" },
        { sessionId: "test-session", instanceId: "test-instance" },
        { idempotencyKey: expect.any(String) },
      );
    });
  });

  it("updates UI when updateUI is called", () => {
    const control = setupThinkingEffortControl({ runtime, getTarget, onError });

    control.updateUI("medium");

    const buttons = document.querySelectorAll(".thinking-effort-dot");
    const mediumButton = Array.from(buttons).find((btn) => btn.dataset.level === "medium");
    const levelName = document.getElementById("thinking-effort-name");

    expect(mediumButton.getAttribute("aria-checked")).toBe("true");
    expect(levelName.textContent).toBe("medium");
  });

  it("handles keyboard navigation", async () => {
    setupThinkingEffortControl({ runtime, getTarget, onError });

    const radioGroup = document.getElementById("thinking-effort");
    const event = new KeyboardEvent("keydown", { key: "ArrowRight" });
    radioGroup.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "set_thinking_level", level: "minimal" },
        { sessionId: "test-session", instanceId: "test-instance" },
        { idempotencyKey: expect.any(String) },
      );
    });
  });

  it("calls onError when runtime request fails", async () => {
    const error = new Error("Request failed");
    runtime.request.mockRejectedValue(error);

    setupThinkingEffortControl({ runtime, getTarget, onError });

    const buttons = document.querySelectorAll(".thinking-effort-dot");
    const highButton = Array.from(buttons).find((btn) => btn.dataset.level === "high");

    highButton.click();

    await vi.waitFor(() => {
      expect(onError).toHaveBeenCalledWith(error);
    });
  });
});
