import { describe, expect, it, vi } from "vitest";
import { ExtensionUiHost } from "./extension-ui-host.js";

const targetA = { workspaceId: "w", sessionId: "a", instanceId: "ia" };
const targetB = { workspaceId: "w", sessionId: "b", instanceId: "ib" };

describe("ExtensionUiHost", () => {
  it("queues blocking dialogs by session and responds only with the bound target", async () => {
    const runtime = { request: vi.fn().mockResolvedValue({ acceptance: "completed" }) };
    const shown = [];
    const host = new ExtensionUiHost({
      runtime,
      showDialog: async (request) => {
        shown.push(request);
        return request.method === "confirm" ? { confirmed: true } : { value: "chosen" };
      },
    });
    host.setForegroundSession("a");
    await host.handle(targetB, {
      type: "extension_ui_request",
      id: "dialog-b",
      method: "select",
      title: "Background",
      options: ["chosen"],
    });
    expect(shown).toHaveLength(0);
    expect(host.pendingCount("b")).toBe(1);

    await host.handle(targetA, {
      type: "extension_ui_request",
      id: "dialog-a",
      method: "confirm",
      title: "Foreground",
      message: "Continue?",
    });
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "extension_ui_response", id: "dialog-a", confirmed: true },
      targetA,
    );
    await host.setForegroundSession("b");
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "extension_ui_response", id: "dialog-b", value: "chosen" },
      targetB,
    );
  });

  it("routes non-blocking UI without logging response values", async () => {
    const hooks = {
      notify: vi.fn(),
      status: vi.fn(),
      widget: vi.fn(),
      title: vi.fn(),
      editorText: vi.fn(),
    };
    const host = new ExtensionUiHost({ runtime: { request: vi.fn() }, hooks });
    for (const request of [
      { method: "notify", message: "hello", notifyType: "info" },
      { method: "setStatus", statusKey: "build", statusText: "running" },
      { method: "setWidget", widgetKey: "branch", content: "main" },
      { method: "setTitle", title: "Project" },
      { method: "set_editor_text", text: "prefill" },
    ]) {
      await host.handle(targetA, { type: "extension_ui_request", id: request.method, ...request });
    }
    expect(hooks.notify).toHaveBeenCalled();
    expect(hooks.status).toHaveBeenCalled();
    expect(hooks.widget).toHaveBeenCalled();
    expect(hooks.title).toHaveBeenCalled();
    expect(hooks.editorText).toHaveBeenCalled();
  });

  it("reports TUI-only operations as unsupported", async () => {
    const runtime = { request: vi.fn().mockResolvedValue({}) };
    const host = new ExtensionUiHost({ runtime, showDialog: vi.fn() });
    await host.handle(targetA, {
      type: "extension_ui_request",
      id: "custom-1",
      method: "custom",
    });
    expect(runtime.request).toHaveBeenCalledWith(
      { type: "extension_ui_response", id: "custom-1", cancelled: true, error: "unsupported" },
      targetA,
    );
  });
});
