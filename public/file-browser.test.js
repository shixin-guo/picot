import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileBrowser } from "./file-browser.js";
import { initI18n, setLocale } from "./i18n.js";

function makeContainer() {
  return {
    innerHTML: "",
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
    querySelector: vi.fn(() => null),
    querySelectorAll: vi.fn(() => []),
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
  };
}

function makePathEl() {
  return { textContent: "", title: "" };
}

function makeMessageInput() {
  return {
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    focus: vi.fn(),
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  };
}

describe("FileBrowser.setWorkspaceRoot", () => {
  test("resets currentPath, path label, and container without fetching", () => {
    const container = makeContainer();
    const pathEl = makePathEl();
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(container, pathEl, messageInput);

    browser.setWorkspaceRoot("/tmp/project");

    expect(browser.currentPath).toBe(null);
    expect(pathEl.textContent).toBe("/tmp/project");
    expect(pathEl.title).toBe("/tmp/project");
    expect(container.innerHTML).toBe("");
  });

  test("normalizes non-string input to empty string", () => {
    const container = makeContainer();
    const pathEl = makePathEl();
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(container, pathEl, messageInput);

    browser.setWorkspaceRoot(123);

    expect(pathEl.textContent).toBe("");
    expect(pathEl.title).toBe("");
    expect(container.innerHTML).toBe("");
  });

  test("trims whitespace from path", () => {
    const container = makeContainer();
    const pathEl = makePathEl();
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(container, pathEl, messageInput);

    browser.setWorkspaceRoot("  /tmp/project  ");

    expect(pathEl.textContent).toBe("/tmp/project");
    expect(pathEl.title).toBe("/tmp/project");
  });
});

describe("FileBrowser.load", () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("loads an explicit path via /api/files?path=...", async () => {
    const container = makeContainer();
    const pathEl = makePathEl();
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(container, pathEl, messageInput);

    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          path: "/tmp/project",
          items: [],
        }),
    });
    globalThis.fetch = fetchMock;

    await browser.load("/tmp/project");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toBe("/api/files?path=%2Ftmp%2Fproject");
    expect(browser.currentPath).toBe("/tmp/project");
    expect(pathEl.textContent).toBe("/tmp/project");
  });

  test("loads session cwd via /api/files when no path is given", async () => {
    const container = makeContainer();
    const pathEl = makePathEl();
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(container, pathEl, messageInput);

    const fetchMock = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          path: "/home/user/project",
          items: [],
        }),
    });
    globalThis.fetch = fetchMock;

    await browser.load();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/files");
    expect(browser.currentPath).toBe("/home/user/project");
  });

  test("stale load response does not overwrite newer workspace", async () => {
    const container = makeContainer();
    const pathEl = makePathEl();
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(container, pathEl, messageInput);

    // Two deferred fetches: A (slow) then B (fast). B resolves first.
    let resolveA;
    let resolveB;
    const fetchA = new Promise((resolve) => {
      resolveA = resolve;
    });
    const fetchB = new Promise((resolve) => {
      resolveB = resolve;
    });

    const fetchMock = vi.fn().mockReturnValueOnce(fetchA).mockReturnValueOnce(fetchB);
    globalThis.fetch = fetchMock;

    // Start load(A), then immediately load(B) before A resolves.
    const loadA = browser.load("/workspace-a");
    const loadB = browser.load("/workspace-b");

    // Resolve B first — it should render workspace B.
    resolveB({
      json: () => Promise.resolve({ path: "/workspace-b", items: [] }),
    });
    await loadB;
    expect(browser.currentPath).toBe("/workspace-b");

    // Now resolve A (stale) — it must NOT overwrite B.
    resolveA({
      json: () => Promise.resolve({ path: "/workspace-a", items: [] }),
    });
    await loadA;
    expect(browser.currentPath).toBe("/workspace-b");
    expect(pathEl.textContent).toBe("/workspace-b");
  });
});

describe("FileBrowser locale change", () => {
  let originalFetch;

  const enMessages = {
    files: { loading: "Loading…", empty: "Empty directory", failedLoad: "Failed to load" },
  };
  const zhMessages = {
    files: { loading: "加载中…", empty: "空目录", failedLoad: "加载失败" },
  };

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.includes("/locales/zh.json")) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(zhMessages) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(enMessages) });
    });
    // Clear any language cookie left by a prior test so initI18n starts in English.
    document.cookie.split(";").forEach((c) => {
      const name = c.split("=")[0].trim();
      if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
    });
    await initI18n();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeRealContainer() {
    const container = document.createElement("div");
    const pathEl = document.createElement("span");
    const messageInput = document.createElement("textarea");
    return { container, pathEl, messageInput };
  }

  test("repaints loading status text when locale changes", async () => {
    const { container, pathEl, messageInput } = makeRealContainer();
    const browser = new FileBrowser(container, pathEl, messageInput);

    browser.showFileStatus("loading");
    expect(container.querySelector(".file-loading").textContent).toBe("Loading…");

    await setLocale("zh");
    expect(container.querySelector(".file-loading").textContent).toBe("加载中…");
  });

  test("repaints empty status text when locale changes", async () => {
    const { container, pathEl, messageInput } = makeRealContainer();
    const browser = new FileBrowser(container, pathEl, messageInput);

    browser.showFileStatus("empty");
    expect(container.querySelector(".file-loading").textContent).toBe("Empty directory");

    await setLocale("zh");
    expect(container.querySelector(".file-loading").textContent).toBe("空目录");
  });

  test("does not translate file names and sizes on locale change", async () => {
    const { container, pathEl, messageInput } = makeRealContainer();
    const browser = new FileBrowser(container, pathEl, messageInput);

    browser.render([
      { name: "readme.md", path: "/tmp/readme.md", isDirectory: false, size: 2048 },
      { name: "src", path: "/tmp/src", isDirectory: true, size: 0 },
    ]);

    const namesBefore = [...container.querySelectorAll(".file-name")].map((el) => el.textContent);
    expect(namesBefore).toEqual(["readme.md", "src"]);
    expect(container.querySelector(".file-size").textContent).toBe("2K");

    await setLocale("zh");

    const namesAfter = [...container.querySelectorAll(".file-name")].map((el) => el.textContent);
    expect(namesAfter).toEqual(["readme.md", "src"]);
    expect(container.querySelector(".file-size").textContent).toBe("2K");
  });
});

// ═══════════════════════════════════════════════════════
// Drag-to-chat mention (@<workspace-relative-path>)
// ═══════════════════════════════════════════════════════

describe("FileBrowser.toMentionPath", () => {
  test("root-level file", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/tmp/proj/package.json")).toBe("@package.json");
  });

  test("nested file (contract example)", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/tmp/proj/src-tauri/a.ts")).toBe("@src-tauri/a.ts");
  });

  test("deeply nested", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/tmp/proj/src/util/helpers.js")).toBe("@src/util/helpers.js");
  });

  test("external sibling becomes ../ relative path", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/tmp/proj-other/a.ts")).toBe("@../proj-other/a.ts");
  });

  test("parent traversal from nested workspace", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/shared/a.ts")).toBe("@../../shared/a.ts");
  });

  test("workspace root directory itself is null", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/tmp/proj")).toBe(null);
  });

  test("empty workspace root is null", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    expect(browser.toMentionPath("/tmp/proj/a.ts")).toBe(null);
  });

  test("non-string or empty path is null", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("")).toBe(null);
    expect(browser.toMentionPath(null)).toBe(null);
    expect(browser.toMentionPath(undefined)).toBe(null);
  });

  test("Windows separators normalize to POSIX output", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "C:\\proj";
    expect(browser.toMentionPath("C:\\proj\\src\\a.ts")).toBe("@src/a.ts");
  });

  test("different Windows drive is null", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "C:\\proj";
    expect(browser.toMentionPath("D:\\shared\\a.ts")).toBe(null);
  });

  test("trailing separator on root", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj/";
    expect(browser.toMentionPath("/tmp/proj/a.ts")).toBe("@a.ts");
  });

  test("embedded .. in source path is rejected", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("/tmp/proj/../other/a.ts")).toBe(null);
  });

  test("Unix root with Windows file path is null", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";
    expect(browser.toMentionPath("C:\\proj\\a.ts")).toBe(null);
  });
});

describe("FileBrowser.onItemMouseDown (custom drag)", () => {
  test("registers mousedown listener on container", () => {
    const container = makeContainer();
    new FileBrowser(container, makePathEl(), makeMessageInput());
    const mousedowns = container.addEventListener.mock.calls.filter((c) => c[0] === "mousedown");
    expect(mousedowns.length).toBe(1);
  });

  test("ignores directory rows", () => {
    const container = makeContainer();
    const browser = new FileBrowser(container, makePathEl(), makeMessageInput());
    browser.workspaceRoot = "/tmp/proj";

    const row = {
      dataset: { path: "/tmp/proj/src", name: "src", isDirectory: "true" },
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const listener = container.addEventListener.mock.calls.find((c) => c[0] === "mousedown")[1];

    // Should return early for directories — no document listeners attached
    const addDocListener = vi.spyOn(document, "addEventListener");
    listener({ button: 0, target: { closest: () => row }, clientX: 0, clientY: 0 });
    expect(addDocListener).not.toHaveBeenCalled();
    addDocListener.mockRestore();
  });

  test("ignores non-left-click", () => {
    const container = makeContainer();
    new FileBrowser(container, makePathEl(), makeMessageInput());

    const row = {
      dataset: { path: "/tmp/proj/a.ts", name: "a.ts", isDirectory: "false" },
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const listener = container.addEventListener.mock.calls.find((c) => c[0] === "mousedown")[1];

    const addDocListener = vi.spyOn(document, "addEventListener");
    listener({ button: 2, target: { closest: () => row }, clientX: 0, clientY: 0 });
    expect(addDocListener).not.toHaveBeenCalled();
    addDocListener.mockRestore();
  });

  test("focuses when a file drag enters the composer before inserting on drop", () => {
    const container = makeContainer();
    const messageInput = makeMessageInput();
    const composerTarget = {};
    const composerCard = {
      contains: vi.fn((element) => element === composerTarget),
      classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    };
    messageInput.closest = vi.fn(() => composerCard);

    const browser = new FileBrowser(container, makePathEl(), messageInput);
    browser.workspaceRoot = "/tmp/proj";
    const row = {
      dataset: { path: "/tmp/proj/a.ts", name: "a.ts", isDirectory: "false" },
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const originalElementFromPoint = document.elementFromPoint;
    document.elementFromPoint = vi.fn(() => composerTarget);
    const addDocumentListener = vi.spyOn(document, "addEventListener");

    try {
      const dragStartEvent = {
        button: 0,
        target: { closest: () => row },
        clientX: 0,
        clientY: 0,
        preventDefault: vi.fn(),
      };
      browser.onItemMouseDown(dragStartEvent);
      expect(dragStartEvent.preventDefault).toHaveBeenCalledOnce();
      const onMove = addDocumentListener.mock.calls.find(([type]) => type === "mousemove")[1];
      const onUp = addDocumentListener.mock.calls.find(([type]) => type === "mouseup")[1];

      onMove({ clientX: 4, clientY: 0 });
      expect(messageInput.focus).toHaveBeenCalledOnce();
      expect(document.body.classList.contains("file-dragging")).toBe(true);

      const dropEvent = { clientX: 4, clientY: 0, preventDefault: vi.fn() };
      onUp(dropEvent);

      expect(dropEvent.preventDefault).toHaveBeenCalledOnce();
      expect(messageInput.value).toBe("@a.ts");
      expect(messageInput.focus).toHaveBeenCalledTimes(2);
      expect(document.body.classList.contains("file-dragging")).toBe(false);
    } finally {
      document.elementFromPoint = originalElementFromPoint;
      addDocumentListener.mockRestore();
      document.body.classList.remove("file-dragging");
    }
  });
});

describe("FileBrowser.insertFileMention", () => {
  function setup({ workspaceRoot = "/tmp/proj" } = {}) {
    const messageInput = makeMessageInput();
    const browser = new FileBrowser(makeContainer(), makePathEl(), messageInput);
    if (workspaceRoot) browser.workspaceRoot = workspaceRoot;
    return { messageInput, browser };
  }

  test("setWorkspaceRoot updates workspaceRoot field", () => {
    const browser = new FileBrowser(makeContainer(), makePathEl(), makeMessageInput());
    browser.setWorkspaceRoot("/tmp/project");
    expect(browser.workspaceRoot).toBe("/tmp/project");
    browser.setWorkspaceRoot("");
    expect(browser.workspaceRoot).toBe("");
  });

  test("valid nested file inserts @relative-path at selection", () => {
    const { messageInput, browser } = setup();
    messageInput.value = "Inspect OLD now";
    messageInput.selectionStart = 8;
    messageInput.selectionEnd = 11;

    const inserted = browser.insertFileMention("/tmp/proj/src-tauri/a.ts");

    expect(inserted).toBe(true);
    expect(messageInput.value).toBe("Inspect @src-tauri/a.ts now");
    const caret = 8 + "@src-tauri/a.ts".length;
    expect(messageInput.selectionStart).toBe(caret);
    expect(messageInput.selectionEnd).toBe(caret);
    expect(messageInput.focus).toHaveBeenCalledTimes(1);
    expect(messageInput.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(messageInput.dispatchEvent.mock.calls[0][0].type).toBe("input");
  });

  test("root-level file inserts @basename", () => {
    const { messageInput, browser } = setup();
    messageInput.value = "";
    expect(browser.insertFileMention("/tmp/proj/package.json")).toBe(true);
    expect(messageInput.value).toBe("@package.json");
  });

  test("external sibling file inserts @../relative-path", () => {
    const { messageInput, browser } = setup();
    messageInput.value = "";
    expect(browser.insertFileMention("/tmp/proj-other/a.ts")).toBe(true);
    expect(messageInput.value).toBe("@../proj-other/a.ts");
  });

  test("file outside workspace with no root is rejected", () => {
    const { messageInput, browser } = setup({ workspaceRoot: "" });
    messageInput.value = "hello";
    expect(browser.insertFileMention("/tmp/proj/a.ts")).toBe(false);
    expect(messageInput.value).toBe("hello");
  });

  test("cross-drive Windows file is rejected", () => {
    const { messageInput, browser } = setup();
    browser.workspaceRoot = "C:\\proj";
    messageInput.value = "hello";
    expect(browser.insertFileMention("D:\\shared\\a.ts")).toBe(false);
    expect(messageInput.value).toBe("hello");
  });

  test("empty/null path is rejected", () => {
    const { messageInput, browser } = setup();
    messageInput.value = "hello";
    expect(browser.insertFileMention("")).toBe(false);
    expect(browser.insertFileMention(null)).toBe(false);
    expect(messageInput.value).toBe("hello");
  });
});
