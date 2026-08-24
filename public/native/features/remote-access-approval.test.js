import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../i18n.js", () => ({
  onLocaleChange: vi.fn(() => () => {}),
  t: (key) =>
    ({
      "remoteApproval.title": "Remote access request",
      "remoteApproval.unknownDevice": "Unknown browser",
      "remoteApproval.warning": "Approval grants access to projects, prompts, tools, and files.",
      "remoteApproval.deny": "Deny",
      "remoteApproval.approve": "Approve",
      "remoteApproval.error": "Could not handle request.",
    })[key] ?? key,
}));

import { setupRemoteAccessApproval } from "./remote-access-approval.js";

beforeEach(() => {
  document.body.innerHTML = "<main id='root'></main>";
});

describe("desktop remote access approval", () => {
  it("renders bounded labels with accessible modal semantics", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        requests: [{ requestId: "request-1", deviceName: "<img onerror=x>".repeat(30) }],
      }),
    }));
    const cleanup = setupRemoteAccessApproval({
      fetchImpl,
      root: document.body,
      pollIntervalMs: 60_000,
    });
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    const modal = document.querySelector('[role="alertdialog"]');
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(modal.textContent).toContain("Remote access request");
    const css = readFileSync("public/native/features/remote-access-approval.css", "utf8");
    expect(css).toContain("align-items: center;");
    expect(css).toContain("justify-content: center;");
    expect(modal.querySelector("img")).toBeNull();
    expect(
      modal.querySelector(".remote-access-approval-device").textContent.length,
    ).toBeLessThanOrEqual(128);
    cleanup();
  });

  it("contains focus, queues one modal, and restores focus after cleanup", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.append(trigger);
    trigger.focus();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        requests: [
          { requestId: "request-1", deviceName: "Phone" },
          { requestId: "request-2", deviceName: "Tablet" },
        ],
      }),
    }));
    const cleanup = setupRemoteAccessApproval({ fetchImpl, pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(document.querySelector("main").inert).toBe(true);
    expect(document.querySelector("main").getAttribute("aria-hidden")).toBe("true");
    const modal = document.querySelector('[role="alertdialog"]');
    modal.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(modal.querySelector(".ui-button--secondary"));
    cleanup();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector("main").inert).toBe(false);
  });

  it("closes a stale request when another desktop window handles it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ requests: [{ requestId: "request-1", deviceName: "Phone" }] }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ requests: [] }) });
    const cleanup = setupRemoteAccessApproval({ fetchImpl, pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    cleanup();
  });

  it("approves and converges already-handled decisions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ requests: [{ requestId: "request-1", deviceName: "Phone" }] }),
      })
      .mockResolvedValueOnce({ ok: false, status: 410, json: async () => ({}) });
    const cleanup = setupRemoteAccessApproval({ fetchImpl, pollIntervalMs: 60_000 });
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).not.toBeNull());
    document.querySelector(".ui-button--primary").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alertdialog"]')).toBeNull());
    expect(fetchImpl.mock.calls[1][0]).toContain("/approve");
    cleanup();
  });

  it("cleans polling, listeners, and modal state", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ requests: [] }) }));
    const cleanup = setupRemoteAccessApproval({ fetchImpl, pollIntervalMs: 10 });
    cleanup();
    const count = fetchImpl.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(count);
  });
});
