import { beforeEach, describe, expect, it, vi } from "vitest";

function makeFetchMock(handlers = {}) {
  const defaults = {
    en: {
      tools: {
        streaming: "streaming",
        complete: "complete",
        error: "error",
        copyOutput: "Copy output",
      },
    },
    zh: { tools: { streaming: "执行中", complete: "完成", error: "错误", copyOutput: "复制输出" } },
  };
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json"))
      return { ok: true, status: 200, json: async () => handlers.en ?? defaults.en };
    if (u.includes("/locales/zh.json"))
      return handlers.zh === null
        ? { ok: false, status: 404, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => handlers.zh ?? defaults.zh };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

async function importFreshI18n() {
  vi.resetModules();
  return import("./i18n.js");
}

beforeEach(() => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.unstubAllGlobals();
});

describe("ToolCardRenderer status localization", () => {
  it("createToolCard sets dataset.status to raw status and displays localized text", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");

    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);
    const card = renderer.createToolCard({
      toolCallId: "tc1",
      toolName: "read",
      status: "streaming",
      args: {},
    });

    const statusEl = card.querySelector(".tool-status");
    expect(statusEl.dataset.status).toBe("streaming");
    expect(statusEl.textContent).toBe("streaming");
    expect(statusEl.className).toContain("tool-status");
    expect(statusEl.className).toContain("streaming");
  });

  it("finalizeToolCard updates dataset.status to complete", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");

    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);
    const card = renderer.createToolCard({
      toolCallId: "tc2",
      toolName: "read",
      status: "streaming",
      args: {},
    });

    renderer.finalizeToolCard("tc2", "result text", false);
    const statusEl = card.querySelector(".tool-status");
    expect(statusEl.dataset.status).toBe("complete");
    expect(statusEl.textContent).toBe("complete");
  });

  it("finalizeToolCard updates dataset.status to error", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");

    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);
    const card = renderer.createToolCard({
      toolCallId: "tc3",
      toolName: "read",
      status: "streaming",
      args: {},
    });

    renderer.finalizeToolCard("tc3", "error text", true);
    const statusEl = card.querySelector(".tool-status");
    expect(statusEl.dataset.status).toBe("error");
    expect(statusEl.textContent).toBe("error");
  });
});

describe("ToolCardRenderer locale change", () => {
  it("existing tool-status text is repainted from tools.* on locale change", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n, setLocale } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");

    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);
    renderer.createToolCard({
      toolCallId: "tc4",
      toolName: "read",
      status: "streaming",
      args: {},
    });

    let statusEl = container.querySelector(".tool-status");
    expect(statusEl.textContent).toBe("streaming");

    await setLocale("zh");
    statusEl = container.querySelector(".tool-status");
    expect(statusEl.textContent).toBe("执行中");
    expect(statusEl.dataset.status).toBe("streaming");
  });

  it("copy-output-btn title and aria-label repaint on locale change", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n, setLocale } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");

    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);
    renderer.createToolCard({
      toolCallId: "tc5",
      toolName: "read",
      status: "streaming",
      args: {},
    });

    let copyBtn = container.querySelector(".copy-output-btn");
    expect(copyBtn.title).toBe("Copy output");

    await setLocale("zh");
    copyBtn = container.querySelector(".copy-output-btn");
    expect(copyBtn.title).toBe("复制输出");
    expect(copyBtn.getAttribute("aria-label")).toBe("复制输出");
  });
});

describe("ToolCardRenderer teardown", () => {
  it("destroy() clears cards, stops locale updates, and is idempotent", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n, setLocale } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");
    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);
    renderer.createToolCard({
      toolCallId: "t1",
      toolName: "bash",
      status: "streaming",
      args: {},
    });
    expect(container.querySelector(".tool-card")).toBeTruthy();

    renderer.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    expect(renderer.toolCards.size).toBe(0);
    // A locale change after destroy must not throw or re-render.
    await setLocale("zh");
  });

  it("destroy() makes queued scroll callbacks safe", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { initI18n } = await importFreshI18n();
    await initI18n();
    const { ToolCardRenderer } = await import("./ui/tool-card.js");
    const queuedFrames = [];
    vi.stubGlobal("requestAnimationFrame", (callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    });
    const renderer = new ToolCardRenderer(document.createElement("div"));
    renderer.createToolCard({
      toolCallId: "t2",
      toolName: "bash",
      status: "streaming",
      args: {},
    });

    renderer.destroy();
    expect(() => {
      queuedFrames.forEach((callback) => {
        callback();
      });
    }).not.toThrow();
  });
});
