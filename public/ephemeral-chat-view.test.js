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
  },
  voice: { voiceInput: "Voice", stopRecording: "Stop" },
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
    transport: { sendEphemeral: vi.fn(() => "ep-1") },
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
      messages: [{ role: "user", content: "hello world" }],
      assistantDraft: null,
      tools: [],
      model: null,
      thinkingLevel: "off",
      isStreaming: false,
      contextUsage: null,
      error: null,
    });
    expect(el.textContent).toContain("hello world");
    view.destroy();
  });

  it("sends a prompt from the composer", () => {
    const runtime = makeRuntime();
    const sendSpy = vi.spyOn(runtime, "sendPrompt");
    const view = new EphemeralChatView({ runtime, kind: "side-chat", toolsEnabled: true });
    const textarea = view.element.querySelector("textarea");
    textarea.value = "what is 2+2";
    view.element.querySelector('[data-role="ephemeral-send"]').click();
    expect(sendSpy).toHaveBeenCalledWith("what is 2+2");
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
