import { beforeEach, describe, expect, it, vi } from "vitest";
import { EphemeralChatRuntime } from "./ephemeral-chat-runtime.js";
import { EphemeralChatView } from "./ephemeral-chat-view.js";
import { initI18n } from "./i18n.js";

const locale = {
  messages: { copyMessage: "Copy", thinking: "Thinking", attachedImage: "image" },
  app: { welcome: "Welcome", welcomeHint: "Hint", currentWorkspace: "ws:" },
  shortcuts: { focusInput: "focus", abort: "abort" },
  tools: {
    streaming: "streaming",
    complete: "complete",
    error: "error",
    copyOutput: "copy",
    pending: "pending",
  },
  dialogs: {
    cancel: "Cancel",
    no: "No",
    yes: "Yes",
    submit: "Submit",
    save: "Save",
    selectOption: "Select",
    confirm: "Confirm",
    input: "Input",
    editor: "Editor",
  },
  ephemeral: {
    placeholder: "Ask…",
    send: "Send",
    abort: "Abort",
    newChat: "New chat",
    tokens: "tokens",
    sideChat: "Side Chat",
    quickChat: "Quick Chat",
    statusReady: "Ready",
    statusStreaming: "Generating",
    statusError: "Error",
    statusDisconnected: "Disconnected",
  },
  input: {
    switchModel: "Switch model",
    commands: "Commands",
    compact: "Compact",
    exportHtml: "Export HTML",
    sessionStats: "Session stats",
    expandAllTools: "Expand tools",
    collapseAllTools: "Collapse tools",
    compactDesc: "Compact the context",
    exportHtmlDesc: "Export this chat",
    sessionStatsDesc: "Show session statistics",
    expandAllToolsDesc: "Expand all tools",
    collapseAllToolsDesc: "Collapse all tools",
  },
  models: { searchPlaceholder: "Search models…", emptyTitle: "No models available" },
  settings: {
    thinkingCompact: "Think {level}",
    thinkingTitle: "Cycle thinking effort",
    thinkingAriaLabel: "Thinking effort: {level}",
    off: "off",
  },
  voice: { voiceInput: "Voice", stopRecording: "Stop" },
  misc: { model: "model" },
};

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => locale };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

function makeRuntime() {
  return new EphemeralChatRuntime({
    descriptor: { instanceId: "inst-1", generation: 1, kind: "side-chat" },
    transport: { sendEphemeral: vi.fn(() => "ep-1"), getCachedModels: vi.fn(async () => null) },
  });
}

describe("EphemeralChatView", () => {
  it("exposes an element and renders snapshot messages", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    const el = view.element;
    expect(el).toBeInstanceOf(window.HTMLElement);
    runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: "inst-1",
      generation: 1,
      runtimeSequenceWatermark: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello world" },
            { type: "image", data: "image-data", mimeType: "image/png" },
          ],
        },
      ],
      assistantDraft: null,
      tools: [],
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      contextUsage: null,
      error: null,
    });
    expect(el.textContent).toContain("hello world");
    expect(el.querySelector(".message-image")?.getAttribute("src")).toBe(
      "data:image/png;base64,image-data",
    );
    view.destroy();
  });

  it("sends a prompt from the composer", () => {
    const runtime = makeRuntime();
    const sendSpy = vi.spyOn(runtime, "sendPrompt");
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    const textarea = view.element.querySelector("textarea");
    textarea.value = "what is 2+2";
    view.element.querySelector('[data-role="ephemeral-send"]').click();
    expect(sendSpy).toHaveBeenCalledWith("what is 2+2", []);
    view.destroy();
  });

  it("exposes an attach button that opens the file input and forwards images on submit", () => {
    const runtime = makeRuntime();
    const sendSpy = vi.spyOn(runtime, "sendPrompt");
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    const attachBtn = view.element.querySelector('[data-role="ephemeral-attach"]');
    expect(attachBtn).not.toBeNull();
    expect(view.element.querySelector('input[type="file"]')).not.toBeNull();
    expect(view.element.querySelector(".image-previews")).not.toBeNull();
    // Simulate adding a pending image directly via the helper API, then submit.
    view._imageAttachments.getPendingImages().push({ data: "abc", mimeType: "image/png" });
    view._imageAttachments.renderPreviews();
    const textarea = view.element.querySelector("textarea");
    textarea.value = "look at this";
    view.element.querySelector('[data-role="ephemeral-send"]').click();
    expect(sendSpy).toHaveBeenCalledWith("look at this", [
      { type: "image", data: "abc", mimeType: "image/png" },
    ]);
    // Consumed on send.
    expect(view._imageAttachments.getPendingImages()).toHaveLength(0);
    view.destroy();
  });

  it("renders the Side Chat Commands palette with main-chat icons and descriptions", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    view.element.querySelector('[data-role="ephemeral-command"]').click();
    const palette = view.element.querySelector(".command-palette");
    expect(palette.classList.contains("hidden")).toBe(false);
    expect(palette.querySelector(".command-palette-header").textContent).toBe("Commands");
    expect(
      Array.from(palette.querySelectorAll(".command-icon")).map((icon) => icon.textContent),
    ).toEqual(["🗜️", "📋", "📊", "⬇️", "⬆️"]);
    expect(palette.querySelector(".command-desc").textContent).toBe("Compact the context");
    expect(palette.querySelector('[aria-disabled="true"]').textContent).toContain("Export HTML");
    view.destroy();
  });

  it("uses the main composer structure with model and thinking controls", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: "inst-1",
      generation: 1,
      runtimeSequenceWatermark: 0,
      messages: [],
      assistantDraft: null,
      tools: [],
      model: { provider: "anthropic", id: "claude-3" },
      thinkingLevel: "high",
      isStreaming: false,
      contextUsage: null,
      error: null,
    });

    const composer = view.element.querySelector(".composer-card");
    expect(composer).not.toBeNull();
    expect(composer.querySelector('[data-role="ephemeral-model"]')).not.toBeNull();
    expect(composer.querySelector('[data-role="ephemeral-thinking"]')).not.toBeNull();
    expect(composer.querySelector('[data-role="ephemeral-send"] svg')).not.toBeNull();
    const sendIcon = composer.querySelector('[data-role="ephemeral-send"] svg');
    const line = sendIcon.querySelector("line");
    expect(line).not.toBeNull();
    expect(line.getAttribute("x1")).toBe("12");
    expect(line.getAttribute("y1")).toBe("19");
    expect(line.getAttribute("x2")).toBe("12");
    expect(line.getAttribute("y2")).toBe("5");
    expect(sendIcon.querySelector("polyline").getAttribute("points")).toBe("5 12 12 5 19 12");
    expect(composer.querySelector('[data-role="ephemeral-send"]').textContent.trim()).toBe("");
    expect(composer.textContent).toContain("claude-3");
    expect(composer.textContent).toContain("Think high");
    view.destroy();
  });

  it("loads models from its own runtime and sends the selected model to that runtime", async () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "quick-chat", toolsEnabled: false });
    view.element.querySelector('[data-role="ephemeral-model"]').click();
    // The view first checks the host model cache (async), then falls back to
    // the live runtime query. Wait for the runtime request to be registered
    // before delivering its response, mirroring real async ordering.
    await vi.waitFor(() => {
      expect(runtime.transport.sendEphemeral).toHaveBeenCalledWith(
        "inst-1",
        1,
        expect.objectContaining({ type: "get_available_models" }),
      );
    });
    runtime.applySequencedEvent({
      instanceId: "inst-1",
      generation: 1,
      payload: {
        type: "response",
        id: "ep-1",
        command: "get_available_models",
        success: true,
        data: {
          models: [
            { provider: "anthropic", id: "claude-3" },
            { provider: "openai", id: "gpt-4o" },
          ],
        },
      },
    });
    await vi.waitFor(() => {
      expect(view.element.querySelector(".model-dropdown-item")).not.toBeNull();
    });

    const search = view.element.querySelector(".model-dropdown-search");
    expect(search).not.toBeNull();
    expect(view.element.querySelector(".model-dropdown-items")).not.toBeNull();
    search.value = "gpt";
    search.dispatchEvent(new Event("input"));
    const option = view.element.querySelector(".model-dropdown-item");
    expect(option.tagName).toBe("DIV");
    expect(option.textContent).toContain("gpt-4o");
    expect(view.element.querySelectorAll(".model-dropdown-item")).toHaveLength(1);
    option.click();
    expect(runtime.transport.sendEphemeral).toHaveBeenLastCalledWith("inst-1", 1, {
      type: "set_model",
      provider: "openai",
      modelId: "gpt-4o",
    });
    view.destroy();
  });

  it("does not render tool cards when tools are disabled (Quick Chat)", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "quick-chat", toolsEnabled: false });
    runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: "inst-1",
      generation: 1,
      runtimeSequenceWatermark: 0,
      messages: [],
      assistantDraft: null,
      tools: [{ toolCallId: "tc1", toolName: "bash", args: {}, output: "x", status: "complete" }],
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      contextUsage: null,
      error: null,
    });
    expect(view.element.querySelector(".tool-card")).toBeNull();
    view.destroy();
  });

  it("renders status, tokens, and cost in the compact usage row", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: "inst-1",
      generation: 1,
      runtimeSequenceWatermark: 0,
      messages: [],
      assistantDraft: null,
      tools: [],
      model: null,
      thinkingLevel: "off",
      isStreaming: true,
      contextUsage: null,
      error: null,
      cost: 0.0123,
      totalTokens: 456,
    });
    const usage = view.element.querySelector(".ephemeral-usage");
    expect(usage.textContent).toContain("Generating");
    expect(usage.textContent).toContain("456");
    expect(usage.textContent).toContain("$0.0123");
    view.destroy();
  });

  it("shows an error status when the runtime has an error", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: "inst-1",
      generation: 1,
      runtimeSequenceWatermark: 0,
      messages: [],
      assistantDraft: null,
      tools: [],
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      contextUsage: null,
      error: "boom",
      cost: 0,
      totalTokens: 0,
    });
    const usage = view.element.querySelector(".ephemeral-usage");
    expect(usage.textContent).toContain("Error");
    view.destroy();
  });

  it("renders an error from the render state", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: "inst-1",
      generation: 1,
      runtimeSequenceWatermark: 0,
      messages: [],
      assistantDraft: null,
      tools: [],
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      contextUsage: null,
      error: "something broke",
    });
    expect(view.element.textContent).toContain("something broke");
    view.destroy();
  });

  it("destroy is idempotent and stops reacting to later render state", () => {
    const runtime = makeRuntime();
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    expect(() => view.destroy()).not.toThrow();
    // A later snapshot must not throw after destroy.
    expect(() =>
      runtime.applySnapshot({
        type: "ephemeral_snapshot",
        instanceId: "inst-1",
        generation: 1,
        runtimeSequenceWatermark: 0,
        messages: [],
        assistantDraft: null,
        tools: [],
        model: null,
        thinkingLevel: "off",
        isStreaming: false,
        contextUsage: null,
        error: null,
      }),
    ).not.toThrow();
  });
});
