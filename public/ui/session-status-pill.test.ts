// ABOUTME: Verifies the Lit session-status pill renders in light DOM so its
// ABOUTME: `#status-indicator`/`#status-text` children stay real, globally
// ABOUTME: queryable nodes for `session-status.js` to keep mutating directly.
import { beforeAll, describe, expect, it } from "vitest";
import "./session-status-pill.js";

describe("picot-session-status", () => {
  beforeAll(async () => {
    // Let Lit's microtask-scheduled first render flush before assertions.
    const probe = document.createElement("picot-session-status");
    document.body.appendChild(probe);
    await (probe as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;
    probe.remove();
  });

  it("renders the indicator and text spans as light-DOM children", async () => {
    const el = document.createElement("picot-session-status");
    document.body.appendChild(el);
    await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete;

    expect(el.shadowRoot).toBeNull();
    const indicator = el.querySelector("#status-indicator");
    const text = el.querySelector("#status-text");
    expect(indicator).not.toBeNull();
    expect(text?.textContent).toBe("Connecting...");
    expect(document.getElementById("status-text")).toBe(text);

    el.remove();
  });
});
