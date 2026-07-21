import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { normalizeSideChatTitle, SideChatManager } from "./side-chat-manager.js";

beforeEach(async () => {
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
              sideChat: "Side Chat",
              newSideChat: "New Side Chat",
              startingSideChat: "Starting…",
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
  let n = 0;
  return {
    createEphemeral: vi.fn(async () => {
      n += 1;
      return {
        instanceId: `sc-${n}`,
        generation: n,
        kind: "side-chat",
        state: "ready",
        title: null,
        unread: false,
      };
    }),
    closeEphemeral: vi.fn(async () => undefined),
    updateEphemeralUi: vi.fn(async () => undefined),
  };
}

function fakePanel() {
  return {
    registerTransientTab: vi.fn(),
    updateTransientTab: vi.fn(),
    activateContent: vi.fn(),
    unregisterTransientTab: vi.fn(),
    showPanel: vi.fn(),
    hidePanel: vi.fn(),
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

function makeManager(overrides = {}) {
  const transport = overrides.transport ?? fakeTransport();
  const filePreviewPanel = overrides.filePreviewPanel ?? fakePanel();
  const manager = new SideChatManager({
    transport,
    filePreviewPanel,
    confirmDiscard: overrides.confirmDiscard ?? vi.fn(async () => "discard"),
    createView: overrides.createView ?? (() => fakeView()),
    getStartupProfile: overrides.getStartupProfile,
  });
  return { manager, transport, filePreviewPanel };
}

describe("SideChatManager create + quota", () => {
  it("create() registers a transient tab and activates it", async () => {
    const { manager, filePreviewPanel } = makeManager();
    await manager.create();
    // Loading tab + real tab = 2 registrations; loading tab is unregistered.
    expect(filePreviewPanel.registerTransientTab).toHaveBeenCalledTimes(2);
    expect(filePreviewPanel.activateContent).toHaveBeenCalledWith({
      kind: "transient",
      id: "sc-1",
    });
    expect(filePreviewPanel.showPanel).toHaveBeenCalled();
    expect(filePreviewPanel.unregisterTransientTab).toHaveBeenCalled();
  });

  it("passes the active session model and thinking level to a new Side Chat", async () => {
    const getStartupProfile = vi.fn(async () => ({
      provider: "openai",
      modelId: "gpt-4.1",
      thinkingLevel: "high",
    }));
    const { manager, transport } = makeManager({ getStartupProfile });
    await manager.create();
    expect(transport.createEphemeral).toHaveBeenCalledWith("side-chat", {
      startupProfile: {
        provider: "openai",
        modelId: "gpt-4.1",
        thinkingLevel: "high",
      },
    });
  });

  it("applies the startup profile to the runtime after its first snapshot", async () => {
    const getStartupProfile = vi.fn(async () => ({
      provider: "openai",
      modelId: "gpt-4.1",
      thinkingLevel: "high",
    }));
    const { manager } = makeManager({ getStartupProfile });
    const descriptor = await manager.create();
    const chat = manager.chats.get(descriptor.instanceId);
    expect(chat).toBeDefined();
    const setModel = vi.spyOn(chat.runtime, "setModel");
    const setThinking = vi.spyOn(chat.runtime, "setThinkingLevel");
    // Simulate the first snapshot arriving — this fires renderstate.
    chat.runtime.applySnapshot({
      type: "ephemeral_snapshot",
      instanceId: descriptor.instanceId,
      generation: descriptor.generation,
      messages: [],
    });
    expect(setModel).toHaveBeenCalledWith("openai", "gpt-4.1");
    expect(setThinking).toHaveBeenCalledWith("high");
  });

  it("enforces the five-instance quota", async () => {
    const { manager } = makeManager();
    for (let i = 0; i < 5; i += 1) await manager.create();
    const sixth = await manager.create();
    expect(sixth).toBeNull();
  });

  it("suppresses a repeated in-flight create", async () => {
    const { manager, transport } = makeManager();
    transport.createEphemeral.mockImplementation(async () => {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              instanceId: "sc-x",
              generation: 1,
              kind: "side-chat",
              state: "ready",
              title: null,
              unread: false,
            }),
          10,
        ),
      );
    });
    const a = manager.create();
    const b = manager.create();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra).not.toBeNull();
    expect(rb).toBeNull();
  });
});

describe("SideChatManager close", () => {
  it("closes an empty chat immediately and unregisters its tab", async () => {
    const { manager, transport, filePreviewPanel } = makeManager();
    await manager.create();
    await manager.close("sc-1");
    expect(transport.closeEphemeral).toHaveBeenCalledWith("sc-1", 1);
    expect(filePreviewPanel.unregisterTransientTab).toHaveBeenCalledWith("sc-1");
  });

  it("confirms before closing a chat with messages", async () => {
    const confirmDiscard = vi.fn(async () => "cancel");
    const { manager, transport } = makeManager({ confirmDiscard });
    await manager.create();
    // Mark the chat as having messages via its runtime's close-risk.
    const chat = manager.chats.get("sc-1");
    chat.runtime.messages.push({ role: "user", content: "hi" });
    await manager.close("sc-1");
    expect(confirmDiscard).toHaveBeenCalled();
    expect(transport.closeEphemeral).not.toHaveBeenCalled();
  });

  it("aborts a streaming chat before closing", async () => {
    const { manager, transport } = makeManager();
    await manager.create();
    const chat = manager.chats.get("sc-1");
    chat.runtime.isStreaming = true;
    const abortSpy = vi.spyOn(chat.runtime, "abort");
    await manager.close("sc-1");
    expect(abortSpy).toHaveBeenCalled();
    expect(transport.closeEphemeral).toHaveBeenCalled();
  });
});

describe("SideChatManager rebind + risk + destroy", () => {
  it("rebind reconstructs chats in creation order", async () => {
    const { manager } = makeManager();
    manager.rebind([
      {
        instanceId: "a",
        generation: 1,
        kind: "side-chat",
        state: "ready",
        title: "T1",
        unread: false,
      },
      {
        instanceId: "b",
        generation: 2,
        kind: "side-chat",
        state: "ready",
        title: null,
        unread: true,
      },
    ]);
    expect(manager.chats.size).toBe(2);
    expect(manager.order).toEqual(["a", "b"]);
  });

  it("getCloseRisk lists each chat with messages/streaming flags", async () => {
    const { manager } = makeManager();
    await manager.create();
    const risk = manager.getCloseRisk();
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({ instanceId: "sc-1", kind: "side-chat" });
  });

  it("destroy tears down every runtime and view", async () => {
    const createView = vi.fn(() => {
      const v = fakeView();
      return v;
    });
    const { manager } = makeManager({ createView });
    await manager.create();
    const chat = manager.chats.get("sc-1");
    const runtimeDestroy = vi.spyOn(chat.runtime, "destroy");
    manager.destroy();
    expect(runtimeDestroy).toHaveBeenCalled();
    expect(chat.view.destroy).toHaveBeenCalled();
    expect(manager.chats.size).toBe(0);
  });
});

describe("normalizeSideChatTitle", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeSideChatTitle("  hello\n\nworld  ")).toBe("hello world");
  });

  it("truncates long titles with an ellipsis at the grapheme boundary", () => {
    const long = "x".repeat(60);
    const normalized = normalizeSideChatTitle(long);
    expect(normalized.length).toBeLessThanOrEqual(40);
    expect(normalized.endsWith("…")).toBe(true);
  });
});
