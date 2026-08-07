// ABOUTME: Exercises the native-host QuickChatDialog lifecycle: open, loading
// ABOUTME: shell, title chrome, minimize/restore chip, replace, and close.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, onLocaleChange, t } from "../../i18n.js";
import { QuickChatDialog } from "./quick-chat-dialog.js";

beforeEach(async () => {
  if (typeof globalThis.PointerEvent === "undefined") {
    class PointerEvent extends MouseEvent {
      constructor(type, params = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 0;
      }
    }
    globalThis.PointerEvent = PointerEvent;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/locales/en.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ephemeral: {
              quickChat: "Quick Chat",
              newChat: "New chat",
              minimize: "Minimize",
              close: "Close",
              resize: "Resize Quick Chat",
              generating: "Generating",
              startingQuickChat: "Starting Quick Chat…",
              unread: "Unread",
              confirmDiscard: "This temporary chat is not saved. Discard it?",
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
  onLocaleChange;
  void t;
});

function descriptor(overrides = {}) {
  return {
    kind: "quick-chat",
    instanceId: "qc-1",
    sessionId: "qc-1",
    workspaceId: "ephemeral-ws-1",
    generation: 1,
    ...overrides,
  };
}

function fakeHost() {
  return {
    hostRequest: vi.fn(async (payload) => {
      if (payload?.operation === "ephemeral_create") {
        return { descriptor: descriptor() };
      }
      if (payload?.operation === "ephemeral_replace") {
        return { descriptor: descriptor({ instanceId: "qc-2", generation: 2 }) };
      }
      if (payload?.operation === "ephemeral_close") {
        return { ok: true };
      }
      return null;
    }),
    // EphemeralChatRuntime routes requestSnapshot / commands through the
    // shared runtime gateway; the test fakes a minimal responder.
    request: vi.fn(async (frame) => {
      if (frame?.type === "ephemeral_snapshot_request") {
        return {
          response: {
            type: "ephemeral_snapshot",
            instanceId: "qc-1",
            generation: 1,
            messages: [],
            assistantDraft: null,
            tools: [],
            model: null,
            thinkingLevel: "off",
            thinkingLevels: ["off"],
            isStreaming: false,
            contextUsage: null,
            error: null,
            cost: 0,
            totalTokens: 0,
            runtimeSequenceWatermark: 0,
          },
        };
      }
      return { response: {} };
    }),
    subscribe: vi.fn(() => () => {}),
    getWorkspaceId: vi.fn(() => "workspace-a"),
  };
}

function fakeView() {
  return {
    element: document.createElement("div"),
    destroy: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
    focusLastMeaningfulControl: vi.fn(),
    setInteractionLocked: vi.fn(),
  };
}

function makeDialog(overrides = {}) {
  const runtime = overrides.runtime ?? fakeHost();
  const dialogRoot = overrides.dialogRoot ?? document.createElement("div");
  const chipRoot = overrides.chipRoot ?? document.createElement("div");
  const boundsElement = overrides.boundsElement ?? document.createElement("div");
  const dialog = new QuickChatDialog({
    runtime,
    hostRequest: runtime.hostRequest,
    getWorkspaceId: runtime.getWorkspaceId,
    dialogRoot,
    chipRoot,
    boundsElement,
    confirmDiscard: overrides.confirmDiscard ?? vi.fn(async () => "discard"),
    createView: overrides.createView ?? (() => fakeView()),
  });
  return { dialog, runtime, dialogRoot, chipRoot, boundsElement };
}

describe("QuickChatDialog lifecycle (native host)", () => {
  it("open() creates a quick chat and reveals the dialog", async () => {
    const { dialog, runtime, dialogRoot, chipRoot } = makeDialog();
    await dialog.open();
    expect(runtime.hostRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "ephemeral_create",
        kind: "quick-chat",
        workspaceId: "workspace-a",
      }),
    );
    expect(dialogRoot.classList.contains("hidden")).toBe(false);
    expect(chipRoot.classList.contains("hidden")).toBe(true);
    dialog.destroy();
  });

  it("reveals a loading shell while the Quick Chat process starts", async () => {
    let resolveCreate;
    const runtime = fakeHost();
    runtime.hostRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { dialog, dialogRoot } = makeDialog({ runtime });

    const opening = dialog.open();

    expect(dialogRoot.classList.contains("hidden")).toBe(false);
    expect(dialogRoot.querySelector(".quick-chat-loading")?.textContent).toBe(
      "Starting Quick Chat…",
    );
    expect(dialogRoot.getAttribute("aria-busy")).toBe("true");

    resolveCreate({ descriptor: descriptor() });
    await opening;
    expect(dialogRoot.querySelector(".quick-chat-loading")).toBeNull();
    expect(dialogRoot.getAttribute("aria-busy")).toBe("false");
    dialog.destroy();
  });

  it("renders title controls as labelled icon buttons", () => {
    const { dialog, dialogRoot } = makeDialog();
    const expected = [
      ["quick-chat-new", "New chat"],
      ["quick-chat-minimize", "Minimize"],
      ["quick-chat-close", "Close"],
    ];
    for (const [role, label] of expected) {
      const button = dialogRoot.querySelector(`[data-role="${role}"]`);
      expect(button.getAttribute("aria-label")).toBe(label);
      expect(button.getAttribute("title")).toBe(label);
      expect(button.querySelector("svg")).not.toBeNull();
      expect(button.textContent.trim()).toBe("");
    }
    const actions = dialogRoot.querySelector(".quick-chat-title-actions");
    expect(actions).not.toBeNull();
    expect(
      Array.from(actions.querySelectorAll("button")).map((button) => button.dataset.role),
    ).toEqual(expected.map(([role]) => role));
    dialog.destroy();
  });

  it("minimize() hides the dialog and shows the chip; restore() reverses", async () => {
    const { dialog, dialogRoot, chipRoot } = makeDialog();
    await dialog.open();
    dialog.minimize();
    expect(dialogRoot.classList.contains("hidden")).toBe(true);
    expect(chipRoot.classList.contains("hidden")).toBe(false);
    dialog.restore();
    expect(dialogRoot.classList.contains("hidden")).toBe(false);
    expect(chipRoot.classList.contains("hidden")).toBe(true);
    dialog.destroy();
  });

  it("replace() swaps to a fresh instance via ephemeral_replace", async () => {
    const { dialog, runtime, dialogRoot } = makeDialog();
    await dialog.open();
    expect(dialog.descriptor?.instanceId).toBe("qc-1");
    const next = await dialog.replace();
    expect(runtime.hostRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "ephemeral_replace" }),
    );
    expect(next?.instanceId).toBe("qc-2");
    expect(dialog.descriptor?.instanceId).toBe("qc-2");
    expect(dialogRoot.classList.contains("hidden")).toBe(false);
    dialog.destroy();
  });

  it("close() asks for confirmation when the chat has messages", async () => {
    const confirmDiscard = vi.fn(async () => "discard");
    const runtime = fakeHost();
    // Simulate a runtime that has messages so getCloseRisk reports risk.
    const { dialog } = makeDialog({ runtime, confirmDiscard });
    await dialog.open();
    // Attach a fake ephemeral runtime with messages after mount.
    dialog.ephemeralRuntime = {
      getCloseRisk: () => ({ hasMessages: true, streaming: false }),
      isStreaming: false,
      abort: vi.fn(),
      destroy: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const closed = await dialog.close();
    expect(confirmDiscard).toHaveBeenCalled();
    expect(runtime.hostRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "ephemeral_close" }),
    );
    expect(closed).toBe(true);
    dialog.destroy();
  });

  it("close() of an empty chat skips confirmation", async () => {
    const confirmDiscard = vi.fn(async () => "discard");
    const { dialog, runtime } = makeDialog({ confirmDiscard });
    await dialog.open();
    dialog.ephemeralRuntime = {
      getCloseRisk: () => ({ hasMessages: false, streaming: false }),
      isStreaming: false,
      abort: vi.fn(),
      destroy: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const closed = await dialog.close();
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(closed).toBe(true);
    expect(dialog.descriptor).toBeNull();
    expect(runtime.hostRequest).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "ephemeral_close" }),
    );
    dialog.destroy();
  });
});
