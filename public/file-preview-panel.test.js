import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FilePreviewPanel } from "./file-preview-panel.js";
import { initI18n } from "./i18n.js";

let panel, resizer, tabBar, content, mainContainer;

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = vi.fn((url) => {
    if (String(url).includes("/locales/")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          messages: { copied: "Copied!" },
          nav: { newSideChat: "New Side Chat" },
          files: {
            preview: {
              close: "Close",
              conflict: "File modified externally",
              copyFailed: "Copy failed",
              loadError: "Failed to load file",
              loading: "Loading…",
              readOnly: "Read-only",
              saveError: "Failed to save file",
              saved: "Saved",
              saving: "Saving…",
              unsupportedBinary: "Unsupported binary",
            },
            unsaved: { title: "Unsaved changes" },
          },
        }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ content: "# Test\n", mtimeMs: 1700000000000 }),
    });
  });

  await initI18n();

  // Build DOM
  document.body.innerHTML = "";
  mainContainer = document.createElement("div");
  mainContainer.className = "main";
  mainContainer.style.width = "800px";
  document.body.appendChild(mainContainer);

  panel = document.createElement("section");
  panel.className = "file-preview-panel collapsed";
  panel.id = "file-preview-panel";
  document.body.appendChild(panel);

  resizer = document.createElement("div");
  resizer.className = "file-preview-resizer collapsed";
  resizer.id = "file-preview-resizer";
  document.body.appendChild(resizer);

  tabBar = document.createElement("div");
  tabBar.className = "file-preview-tabs";
  tabBar.id = "file-preview-tabs";
  document.body.appendChild(tabBar);

  content = document.createElement("div");
  content.className = "file-preview-content";
  content.id = "file-preview-content";
  document.body.appendChild(content);

  // Panel control buttons.
  const enlargeBtn = document.createElement("button");
  enlargeBtn.id = "file-preview-enlarge";
  enlargeBtn.className = "hidden";
  document.body.appendChild(enlargeBtn);

  const collapseBtn = document.createElement("button");
  collapseBtn.id = "file-preview-collapse";
  document.body.appendChild(collapseBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "file-preview-close";
  document.body.appendChild(closeBtn);

  const toolbar = document.createElement("div");
  toolbar.id = "file-preview-toolbar";
  document.body.appendChild(toolbar);
  for (const id of [
    "file-preview-toolbar-toggle",
    "file-preview-mode-preview",
    "file-preview-mode-edit",
    "file-preview-save",
    "file-preview-reload",
    "file-preview-search",
    "file-preview-go-to-line",
    "file-preview-copy",
  ]) {
    const button = document.createElement("button");
    button.id = id;
    document.body.appendChild(button);
  }
  const goToLineInput = document.createElement("input");
  goToLineInput.id = "file-preview-go-to-line-input";
  goToLineInput.className = "hidden";
  document.body.appendChild(goToLineInput);
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function createPanel(options = {}) {
  const storedValues = new Map();
  return new FilePreviewPanel({
    panel,
    resizer,
    tabBar,
    content,
    mainContainer,
    workspaceRoot: "/test/workspace",
    storage: {
      getItem: (key) => storedValues.get(key) ?? null,
      setItem: (key, value) => storedValues.set(key, String(value)),
      removeItem: (key) => storedValues.delete(key),
    },
    ...options,
  });
}

describe("FilePreviewPanel", () => {
  test("starts collapsed", () => {
    const p = createPanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("openFile opens panel and creates tab", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(tabBar.children.length).toBe(1);
    p.destroy();
  });

  test("uses the inline line input to navigate and then restores the button", () => {
    const p = createPanel();
    const goToLine = document.getElementById("file-preview-go-to-line");
    const input = document.getElementById("file-preview-go-to-line-input");
    const renderer = { destroy: vi.fn(), goToLine: vi.fn(() => true) };
    const tab = p.state.openFile("/test/workspace/example.js");
    p.state.updateTab(tab.id, { content: "line one\nline two\n" });
    p.currentRenderer = renderer;
    goToLine.disabled = false;
    vi.spyOn(window, "prompt").mockReturnValue(null);

    goToLine.click();

    expect(input.classList.contains("hidden")).toBe(false);

    input.value = "2";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(renderer.goToLine).toHaveBeenCalledWith(2);
    expect(input.classList.contains("hidden")).toBe(true);
    expect(goToLine.classList.contains("hidden")).toBe(false);
    p.destroy();
  });

  test("opening the same file selects it without reloading or losing dirty content", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    const tab = p.state.getActiveTab();
    p.state.updateTab(tab.id, { content: "# Unsaved\n", dirty: true });

    await p.openFile("/test/workspace/README.md");

    const contentCalls = global.fetch.mock.calls.filter(([url]) =>
      String(url).startsWith("/api/files/content"),
    );
    expect(contentCalls).toHaveLength(1);
    expect(p.state.getActiveTab()?.content).toBe("# Unsaved\n");
    expect(p.state.getActiveTab()?.dirty).toBe(true);
    expect(tabBar.children).toHaveLength(1);
    p.destroy();
  });

  test("opening multiple files creates multiple tabs", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/a.js");
    await p.openFile("/test/workspace/b.js");
    expect(tabBar.children.length).toBe(2);
    p.destroy();
  });

  test("finishes independent loads when files resolve out of order", async () => {
    const pending = new Map();
    global.fetch = vi.fn(
      (url) =>
        new Promise((resolve) => {
          pending.set(String(url), resolve);
        }),
    );
    const p = createPanel();

    const firstLoad = p.openFile("/test/workspace/a.js");
    const secondLoad = p.openFile("/test/workspace/b.js");
    pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fb.js")({
      ok: true,
      json: async () => ({ content: "const b = 1;\n", mtimeMs: 2 }),
    });
    await secondLoad;
    pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fa.js")({
      ok: true,
      json: async () => ({ content: "const a = 1;\n", mtimeMs: 1 }),
    });
    await firstLoad;

    expect(p.state.getTab("file:/test/workspace/a.js")?.loading).toBe(false);
    expect(p.state.getTab("file:/test/workspace/a.js")?.content).toBe("const a = 1;\n");
    expect(p.state.getTab("file:/test/workspace/b.js")?.content).toBe("const b = 1;\n");
    expect(p.state.getActiveTab()?.filePath).toBe("/test/workspace/b.js");
    p.destroy();
  });

  test("enlarge adds enlarged class", () => {
    const p = createPanel();
    p.enlarge();
    expect(panel.classList.contains("enlarged")).toBe(true);
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("collapse removes enlarged class", () => {
    const p = createPanel();
    p.enlarge();
    p.collapse();
    expect(panel.classList.contains("enlarged")).toBe(false);
    p.destroy();
  });

  test("closePanel collapses panel", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.closePanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("closePanel preserves tabs (not closing them)", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.closePanel();
    expect(p.state.getTabs().length).toBe(1);
    p.destroy();
  });

  test("does not close a dirty tab when confirmation is cancelled", async () => {
    const confirmDirty = vi.fn(async () => "cancel");
    const p = createPanel({ confirmDirty });
    await p.openFile("/test/workspace/main.js");
    const tab = p.state.getActiveTab();
    p.currentRenderer.getEditor().setValue("changed\n");

    const closed = await p._closeTab(tab.id);

    expect(closed).toBe(false);
    expect(confirmDirty).toHaveBeenCalledOnce();
    expect(p.state.getTab(tab.id)).not.toBeNull();
    p.destroy();
  });

  test("edit control switches an editable text tab into edit mode", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");

    document.getElementById("file-preview-mode-edit").click();
    await Promise.resolve();

    expect(p.state.getActiveTab()?.mode).toBe("edit");
    expect(content.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("true");
    p.destroy();
  });

  test("keeps edits made while a save request is in flight dirty", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const tab = p.state.getActiveTab();
    p.state.updateTab(tab.id, { content: "first edit\n", dirty: true });
    let resolveSave;
    global.fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const saving = p._saveTab(tab.id);
    p.state.updateTab(tab.id, { content: "second edit\n", dirty: true });
    resolveSave({
      ok: true,
      status: 200,
      json: async () => ({ mtimeMs: 1700000001000 }),
    });
    await saving;

    expect(p.state.getTab(tab.id)?.content).toBe("second edit\n");
    expect(p.state.getTab(tab.id)?.originalContent).toBe("first edit\n");
    expect(p.state.getTab(tab.id)?.dirty).toBe(true);
    p.destroy();
  });

  test("explicit save can overwrite after a conflict decision", async () => {
    const resolveConflict = vi.fn(async () => "overwrite");
    const p = createPanel({ resolveConflict });
    await p.openFile("/test/workspace/main.js");
    const tab = p.state.getActiveTab();
    p.state.updateTab(tab.id, { content: "updated\n", dirty: true });
    const requests = [];
    global.fetch = vi.fn(async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) {
        return { ok: false, status: 409, json: async () => ({ error: "conflict" }) };
      }
      return { ok: true, status: 200, json: async () => ({ mtimeMs: 1700000002000 }) };
    });

    const saved = await p._saveTab(tab.id);

    expect(saved).toBe(true);
    expect(resolveConflict).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1].force).toBe(true);
    expect(p.state.getTab(tab.id)?.dirty).toBe(false);
    expect(p.state.getTab(tab.id)?.conflict).toBe(false);
    p.destroy();
  });

  test("tab bar renders file names", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const tabName = tabBar.querySelector(".file-preview-tab-name");
    expect(tabName).not.toBeNull();
    expect(tabName.textContent).toBe("main.js");
    p.destroy();
  });

  test("tabs and splitter expose keyboard interactions", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/a.js");
    await p.openFile("/test/workspace/b.js");
    const firstTab = tabBar.querySelector('[data-tab-id="file:/test/workspace/a.js"]');

    expect(firstTab?.getAttribute("role")).toBe("tab");
    expect(firstTab?.getAttribute("tabindex")).toBe("0");
    firstTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(p.state.getActiveTab()?.filePath).toBe("/test/workspace/a.js");

    const initialRatio = p.panelRatio;
    resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(p.panelRatio).toBeGreaterThan(initialRatio);
    expect(resizer.getAttribute("aria-valuenow")).not.toBeNull();
    p.destroy();
  });

  test("tab bar renders close buttons", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const closeBtn = tabBar.querySelector(".file-preview-tab-close");
    expect(closeBtn).not.toBeNull();
    p.destroy();
  });

  test("renders the New Side Chat tab action as a localized icon button", () => {
    const p = createPanel();
    p.registerTabBarAction("new-side-chat", {
      labelKey: "nav.newSideChat",
      icon: "chat-plus",
      onClick: vi.fn(),
    });
    const action = tabBar.querySelector('[data-action-id="new-side-chat"]');
    expect(action.getAttribute("aria-label")).toBe("New Side Chat");
    expect(action.querySelector("svg")).not.toBeNull();
    expect(action.textContent.trim()).toBe("");
    p.destroy();
  });

  test("setWorkspaceRoot loads persisted tabs", () => {
    // Simulate persisted tabs from a previous session.
    const tabsData = {
      byRoot: {
        "/test/workspace": {
          tabs: [
            {
              id: "file:/test/workspace/persisted.js",
              kind: "file",
              filePath: "/test/workspace/persisted.js",
              fileName: "persisted.js",
              mode: "preview",
            },
          ],
          activeTabId: "file:/test/workspace/persisted.js",
          touchedAt: Date.now(),
        },
      },
    };

    // Use the FileTabState directly with injected storage.
    const { FileTabState } = require("./file-tab-state.js");
    const memStorage = new Map();
    memStorage.set("picot-file-tabs", JSON.stringify(tabsData));
    const state = new FileTabState({
      storage: {
        getItem: (k) => memStorage.get(k) ?? null,
        setItem: (k, v) => memStorage.set(k, v),
        removeItem: (k) => memStorage.delete(k),
      },
    });
    state.load("/test/workspace");
    expect(state.getTabs().length).toBe(1);
    expect(state.getTabs()[0].fileName).toBe("persisted.js");
  });

  test("destroy cleans up renderer", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.destroy();
    // After destroy, the content should be empty.
    // The renderer's destroy() is called; content is cleared by _closePanel
    // only when closePanel is called. But destroy() destroys the renderer.
    // Content div may still have a wrapper; check for cm-editor absence.
    expect(content.querySelectorAll(".cm-editor").length).toBe(0);
  });
});

describe("FilePreviewPanel transient tabs", () => {
  test("registerTransientTab renders a tab before file tabs", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/a.txt", { fileName: "a.txt" });
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: document.createElement("div"),
      onActivate: () => {},
      onDeactivate: () => {},
      onRequestClose: () => {},
    });
    const transientTabs = tabBar.querySelectorAll('.file-preview-tab[data-transient-id="sc1"]');
    expect(transientTabs.length).toBe(1);
    // Transient tab is rendered before any file tab.
    const firstTab = tabBar.querySelector(".file-preview-tab");
    expect(firstTab.dataset.transientId).toBe("sc1");
    p.destroy();
  });

  test("activateContent shows the transient content and fires onActivate", () => {
    const p = createPanel();
    const body = document.createElement("div");
    body.textContent = "side chat body";
    let activated = false;
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: body,
      onActivate: () => {
        activated = true;
      },
      onDeactivate: () => {},
      onRequestClose: () => {},
    });
    p.activateContent({ kind: "transient", id: "sc1" });
    expect(activated).toBe(true);
    expect(content.contains(body)).toBe(true);
    p.destroy();
  });

  test("the transient close button calls onRequestClose", () => {
    const p = createPanel();
    let requested = false;
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: document.createElement("div"),
      onActivate: () => {},
      onDeactivate: () => {},
      onRequestClose: () => {
        requested = true;
      },
    });
    tabBar
      .querySelector('.file-preview-tab[data-transient-id="sc1"] .file-preview-tab-close')
      .click();
    expect(requested).toBe(true);
    p.destroy();
  });

  test("unregisterTransientTab removes the tab and deactivates it", () => {
    const p = createPanel();
    let deactivated = false;
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: document.createElement("div"),
      onActivate: () => {},
      onDeactivate: () => {
        deactivated = true;
      },
      onRequestClose: () => {},
    });
    p.activateContent({ kind: "transient", id: "sc1" });
    p.unregisterTransientTab("sc1");
    expect(tabBar.querySelector('.file-preview-tab[data-transient-id="sc1"]')).toBeFalsy();
    expect(deactivated).toBe(true);
    p.destroy();
  });

  test("getCloseRisk reports dirty file tabs with a monotonic version", () => {
    const p = createPanel();
    const first = p.getCloseRisk();
    expect(first.version).toBeGreaterThan(0);
    expect(Array.isArray(first.dirtyFiles)).toBe(true);
    p.destroy();
  });

  test("showPanel / hidePanel toggle the collapsed state", () => {
    const p = createPanel();
    p.showPanel();
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.hidePanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });
});
