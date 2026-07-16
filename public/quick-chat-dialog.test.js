import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "./i18n.js";
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
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
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
              unread: "Unread",
              tokens: "tokens",
            },
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

function fakeTransport() {
  return {
    createEphemeral: vi.fn(async () => ({
      instanceId: "qc-1",
      generation: 1,
      kind: "quick-chat",
      state: "ready",
      title: null,
      unread: false,
    })),
    replaceQuickChat: vi.fn(async () => ({
      instanceId: "qc-2",
      generation: 2,
      kind: "quick-chat",
      state: "ready",
      title: null,
      unread: false,
    })),
    closeEphemeral: vi.fn(async () => undefined),
  };
}

function fakeView() {
  return {
    element: document.createElement("div"),
    destroy: vi.fn(),
    activate: vi.fn(),
    focusLastMeaningfulControl: vi.fn(),
    setInteractionLocked: vi.fn(),
  };
}

function makeDialog(overrides = {}) {
  const transport = overrides.transport ?? fakeTransport();
  const dialogRoot = overrides.dialogRoot ?? document.createElement("div");
  const chipRoot = overrides.chipRoot ?? document.createElement("div");
  const boundsElement = overrides.boundsElement ?? document.createElement("div");
  const dialog = new QuickChatDialog({
    transport,
    dialogRoot,
    chipRoot,
    boundsElement,
    confirmDiscard: overrides.confirmDiscard ?? vi.fn(async () => "discard"),
    createView: overrides.createView ?? (() => fakeView()),
  });
  return { dialog, transport, dialogRoot, chipRoot, boundsElement };
}

describe("QuickChatDialog lifecycle", () => {
  it("open() creates a quick chat and reveals the dialog", async () => {
    const { dialog, transport, dialogRoot, chipRoot } = makeDialog();
    await dialog.open();
    expect(transport.createEphemeral).toHaveBeenCalledWith("quick-chat");
    expect(dialogRoot.classList.contains("hidden")).toBe(false);
    expect(chipRoot.classList.contains("hidden")).toBe(true);
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

  it("replace() confirms when there are messages and swaps to the new descriptor", async () => {
    const confirmDiscard = vi.fn(async () => "discard");
    const { dialog, transport } = makeDialog({ confirmDiscard });
    await dialog.open();
    dialog.runtime.messages.push({ role: "user", content: "hi" });
    await dialog.replace();
    expect(confirmDiscard).toHaveBeenCalled();
    expect(transport.replaceQuickChat).toHaveBeenCalled();
    expect(dialog.descriptor.instanceId).toBe("qc-2");
    dialog.destroy();
  });

  it("close() with messages asks for confirmation and does not close on cancel", async () => {
    const confirmDiscard = vi.fn(async () => "cancel");
    const { dialog, transport, dialogRoot } = makeDialog({ confirmDiscard });
    await dialog.open();
    dialog.runtime.messages.push({ role: "user", content: "hi" });
    await dialog.close();
    expect(confirmDiscard).toHaveBeenCalled();
    expect(transport.closeEphemeral).not.toHaveBeenCalled();
    expect(dialogRoot.classList.contains("hidden")).toBe(false);
    dialog.destroy();
  });

  it("getCloseRisk reports the live quick chat or null", async () => {
    const { dialog } = makeDialog();
    expect(dialog.getCloseRisk()).toBeNull();
    await dialog.open();
    expect(dialog.getCloseRisk()).toMatchObject({ instanceId: "qc-1", kind: "quick-chat" });
    dialog.destroy();
  });
});

describe("QuickChatDialog drag", () => {
  it("dragging the title bar moves the dialog", async () => {
    const { dialog, dialogRoot } = makeDialog();
    await dialog.open();
    const title = dialogRoot.querySelector('[data-role="quick-chat-title"]');
    const move = (x, y) =>
      dialogRoot.dispatchEvent(
        new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }),
      );
    title.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true }),
    );
    move(40, 30);
    title.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(dialogRoot.style.left).not.toBe("");
    dialog.destroy();
  });

  it("pointer movement invokes the drag handler without recursion", async () => {
    const { dialog, dialogRoot } = makeDialog();
    await dialog.open();
    const title = dialogRoot.querySelector('[data-role="quick-chat-title"]');
    title.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true }),
    );
    expect(() =>
      dialog._onPointerMove(new PointerEvent("pointermove", { clientX: 40, clientY: 30 })),
    ).not.toThrow();
    dialog.destroy();
  });

  it("pressing a button in the title bar does not start a drag", async () => {
    const { dialog, dialogRoot } = makeDialog();
    await dialog.open();
    const before = dialogRoot.style.left;
    const btn = dialogRoot.querySelector('[data-role="quick-chat-close"]');
    btn.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 5, clientY: 5, bubbles: true }),
    );
    dialogRoot.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 80, clientY: 80, bubbles: true }),
    );
    btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    expect(dialogRoot.style.left).toBe(before);
    dialog.destroy();
  });

  it("resizes from a validated edge handle", async () => {
    const { dialog, dialogRoot } = makeDialog();
    await dialog.open();
    const handle = dialogRoot.querySelector('[data-resize="e"]');
    expect(handle).toBeTruthy();
    handle.dispatchEvent(
      new PointerEvent("pointerdown", { button: 0, clientX: 100, clientY: 100, bubbles: true }),
    );
    dialog._onPointerMove(new PointerEvent("pointermove", { clientX: 180, clientY: 100 }));
    dialog._handlePointerUp();
    expect(Number.parseFloat(dialogRoot.style.width)).toBeGreaterThanOrEqual(360);
    expect(dialog._gesture).toBeNull();
    dialog.destroy();
  });
});

describe("QuickChatDialog destroy", () => {
  it("destroy is idempotent and disposes the runtime/view", async () => {
    const createView = vi.fn(() => fakeView());
    const { dialog } = makeDialog({ createView });
    await dialog.open();
    const view = dialog.view;
    const runtimeDestroy = vi.spyOn(dialog.runtime, "destroy");
    expect(() => dialog.destroy()).not.toThrow();
    expect(runtimeDestroy).toHaveBeenCalled();
    expect(view.destroy).toHaveBeenCalled();
    dialog.destroy();
  });
});
