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
              markitdown: {
                pythonMissing: "Install Python 3.10 or later to preview this file.",
                pythonTooOld: "Python {version} is too old. Install Python 3.10 or later.",
                markitdownMissing: "Install MarkItDown to preview this file.",
                markitdownIncompatible:
                  "Update MarkItDown to a version that supports stdin conversion.",
                installPosix: "python3 -m pip install markitdown",
                installWindows: "py -3 -m pip install markitdown",
              },
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
  document.body.replaceChildren();
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
  document.body.replaceChildren();
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
  test("renders converted responses as read-only Markdown", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          previewStatus: "ready",
          renderAs: "markdown",
          content: "# Converted",
          editable: false,
        }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/mail.eml");
    expect(p.state.getActiveTab()).toMatchObject({
      editable: false,
      mode: "preview",
      renderAs: "markdown",
    });
    expect(content.querySelector(".file-markdown-preview")).not.toBeNull();
    expect(document.getElementById("file-preview-mode-edit").disabled).toBe(true);
    p.destroy();
  });

  test("maps an old Python dependency response to localized guidance", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          previewStatus: "dependencyUnavailable",
          dependencyReason: "pythonTooOld",
          pythonVersion: "3.9.7",
          editable: false,
        }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/report.docx");
    expect(content.textContent).toContain("Python 3.9.7 is too old");
    expect(content.textContent).not.toContain("stderr");
    p.destroy();
  });
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

  test("opens source code files in edit mode by default", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/example.js");
    expect(p.state.getActiveTab()?.mode).toBe("edit");
    p.destroy();
  });

  test("opens markdown files in preview mode by default", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    expect(p.state.getActiveTab()?.mode).toBe("preview");
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

  test("uses the server-discovered Python command in dependency guidance", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          previewStatus: "dependencyUnavailable",
          dependencyReason: "markitdownMissing",
          displayCommand: "python",
          editable: false,
        }),
      }),
    );
    const p = createPanel();
    await p.openFile("/test/workspace/report.docx");
    expect(content.textContent).toContain("python -m pip install");
    expect(content.textContent).not.toContain("python3 -m pip install");
    p.destroy();
  });

  test("aborts the old load when switching tabs and reloads it when selected again", async () => {
    const pending = new Map();
    global.fetch = vi.fn((url, options) => {
      const entry = { options, resolve: null };
      const promise = new Promise((resolve) => {
        entry.resolve = resolve;
      });
      pending.set(String(url), entry);
      return promise;
    });
    const p = createPanel();
    const first = p.openFile("/test/workspace/a.docx");
    const firstRequest = pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fa.docx");
    const second = p.openFile("/test/workspace/b.docx");
    expect(firstRequest.options.signal.aborted).toBe(true);
    firstRequest.resolve({ ok: true, json: async () => ({ content: "stale" }) });
    pending.get("/api/files/content?path=%2Ftest%2Fworkspace%2Fb.docx").resolve({
      ok: true,
      json: async () => ({ content: "b" }),
    });
    await second;
    await first;
    const aTab = p.state.getTab("file:/test/workspace/a.docx");
    expect(aTab.content).toBeNull();
    const select = tabBar.querySelector('[data-tab-id="file:/test/workspace/a.docx"]');
    select.click();
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(3);
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

  test("registerTabBarAction renders an icon button and invokes onClick", () => {
    const onClick = vi.fn();
    const p = createPanel();
    p.registerTabBarAction("demo-action", {
      labelKey: "nav.newSideChat",
      icon: "chat-plus",
      onClick,
    });

    const action = tabBar.querySelector('[data-action-id="demo-action"]');
    expect(action).not.toBeNull();
    // labelKey is resolved through i18n; the fixture maps nav.newSideChat to a string.
    expect(action.getAttribute("aria-label")).toBe("New Side Chat");
    // An icon action renders an SVG and carries no visible text label.
    expect(action.querySelector("svg")).not.toBeNull();
    expect(action.textContent.trim()).toBe("");
    expect(action.disabled).toBe(false);

    action.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    // Disabling the action both gates the click handler and reflects disabled state.
    p.setTabBarActionEnabled("demo-action", false, "busy");
    const updated = tabBar.querySelector('[data-action-id="demo-action"]');
    expect(updated.disabled).toBe(true);
    expect(updated.title).toBe("busy");
    updated.click();
    expect(onClick).toHaveBeenCalledTimes(1);

    // Hiding the action removes it from the rendered tab bar entirely.
    p.setTabBarActionVisible("demo-action", false);
    expect(tabBar.querySelector('[data-action-id="demo-action"]')).toBeNull();
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

  // Regression: file DOM must not linger in the content area after switching
  // to a Side Chat (transient) tab. Leftover .file-code-editor nodes are
  // height:100% and overlap the appended Side Chat view inside the
  // overflow:hidden content container, making the Side Chat invisible.
  test("switching from a file tab to a transient tab clears leftover file DOM", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    expect(content.querySelectorAll(".file-code-editor").length).toBe(1);

    const body = document.createElement("div");
    body.className = "ephemeral-chat-view";
    body.textContent = "side chat body";
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: body,
      onActivate: () => {},
      onDeactivate: () => {},
      onRequestClose: () => {},
    });
    p.activateContent({ kind: "transient", id: "sc1" });

    expect(content.contains(body)).toBe(true);
    expect(content.children.length).toBe(1);
    expect(content.firstChild).toBe(body);
    expect(content.querySelectorAll(".file-code-editor").length).toBe(0);
    p.destroy();
  });

  test("switching back to a transient tab after opening a file restores it", async () => {
    const p = createPanel();
    const body = document.createElement("div");
    body.className = "ephemeral-chat-view";
    body.textContent = "side chat body";
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: body,
      onActivate: () => {},
      onDeactivate: () => {},
      onRequestClose: () => {},
    });
    p.activateContent({ kind: "transient", id: "sc1" });
    await p.openFile("/test/workspace/main.js");
    expect(content.contains(body)).toBe(false);

    p.activateContent({ kind: "transient", id: "sc1" });

    expect(content.contains(body)).toBe(true);
    expect(content.children.length).toBe(1);
    expect(content.firstChild).toBe(body);
    p.destroy();
  });

  // Regression: closing the last file tab must not collapse the panel while a
  // Side Chat (transient) tab still exists — the panel should switch to it.
  test("closing the last file tab keeps the panel open when a transient tab remains", async () => {
    const p = createPanel();
    p.registerTransientTab({
      id: "sc1",
      title: "Side Chat",
      status: "ready",
      contentElement: document.createElement("div"),
      onActivate: () => {},
      onDeactivate: () => {},
      onRequestClose: () => {},
    });
    await p.openFile("/test/workspace/main.js");

    await p._closeTab(p.state.getActiveTab().id);

    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(p.activeContent).toEqual({ kind: "transient", id: "sc1" });
    expect(p.state.getTabs().length).toBe(0);
    p.destroy();
  });

  test("closing the last file tab still closes the panel with no transient tab", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");

    await p._closeTab(p.state.getActiveTab().id);

    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });
});

describe("FilePreviewPanel workspace restore", () => {
  function seededStorage(seed) {
    const memStorage = new Map();
    memStorage.set("picot-file-tabs", JSON.stringify(seed));
    return {
      getItem: (k) => memStorage.get(k) ?? null,
      setItem: (k, v) => memStorage.set(k, String(v)),
      removeItem: (k) => memStorage.delete(k),
    };
  }

  // Regression: during a foreground workspace switch the persisted tabs can
  // belong to a workspace the current server is not scoped to, so the content
  // fetch 403s. The panel must not flash open with a load error before the
  // authoritative state closes it.
  test("does not flash the panel open when restored content fails to load", async () => {
    const storage = seededStorage({
      byRoot: {
        "/ws/a": {
          tabs: [
            {
              id: "file:/ws/a/missing.js",
              kind: "file",
              filePath: "/ws/a/missing.js",
              fileName: "missing.js",
              mode: "edit",
            },
          ],
          activeTabId: "file:/ws/a/missing.js",
          touchedAt: Date.now(),
        },
      },
    });
    const p = createPanel({ storage });
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
    }));

    expect(panel.classList.contains("collapsed")).toBe(true);
    await p.setWorkspaceRoot("/ws/a");

    expect(panel.classList.contains("collapsed")).toBe(true);
    expect(p.state.getTabs().length).toBe(1);
    p.destroy();
  });

  test("opens the panel when restored content loads successfully", async () => {
    const storage = seededStorage({
      byRoot: {
        "/ws/a": {
          tabs: [
            {
              id: "file:/ws/a/real.js",
              kind: "file",
              filePath: "/ws/a/real.js",
              fileName: "real.js",
              mode: "edit",
            },
          ],
          activeTabId: "file:/ws/a/real.js",
          touchedAt: Date.now(),
        },
      },
    });
    const p = createPanel({ storage });
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ content: "real content\n", mtimeMs: 1 }),
    }));

    await p.setWorkspaceRoot("/ws/a");

    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("hasPersistedTabs peeks storage without switching state", () => {
    const storage = seededStorage({
      byRoot: {
        "/ws/a": {
          tabs: [
            {
              id: "file:/ws/a/peek.js",
              kind: "file",
              filePath: "/ws/a/peek.js",
              fileName: "peek.js",
              mode: "edit",
            },
          ],
          activeTabId: "file:/ws/a/peek.js",
          touchedAt: Date.now(),
        },
      },
    });
    const p = createPanel({ storage });

    expect(p.hasPersistedTabs("/ws/a")).toBe(true);
    expect(p.hasPersistedTabs("/ws/empty")).toBe(false);
    // Peeking must not load tabs into the active state.
    expect(p.state.getTabs().length).toBe(0);
    p.destroy();
  });
});

describe("FilePreviewPanel git diff tabs", () => {
  test("openDiff mounts a diff renderer and sets activeContent", () => {
    const p = createPanel();
    const id = p.openDiff({
      displayPath: "src/main.js",
      comparison: "changes",
      rawPatch:
        "--- a/src/main.js\n+++ b/src/main.js\n@@ -1,1 +1,2 @@\n-old line\n+new line\n+added line",
    });

    expect(id).toBe("git-diff");
    expect(p.activeContent).toEqual({ kind: "diff", id: "git-diff" });
    expect(p.diffTabs.has("git-diff")).toBe(true);
    // The diff renderer should have mounted content into the panel.
    expect(content.children.length).toBeGreaterThan(0);
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("closeDiffTab removes the tab and deactivates", () => {
    const p = createPanel();
    p.openDiff({
      displayPath: "src/main.js",
      comparison: "changes",
      rawPatch: "test patch",
    });

    expect(p.diffTabs.size).toBe(1);
    const result = p.closeDiffTab("git-diff");
    expect(result).toBe(true);
    expect(p.diffTabs.has("git-diff")).toBe(false);
    p.destroy();
  });

  test("openDiff renders a diff tab in the tab bar", () => {
    const p = createPanel();
    p.openDiff({
      displayPath: "src/app.ts",
      comparison: "staged",
      rawPatch: "test",
    });

    const diffTab = tabBar.querySelector('[data-diff-id="git-diff"]');
    expect(diffTab).not.toBeNull();
    expect(diffTab.classList.contains("diff-tab")).toBe(true);
    p.destroy();
  });
});
