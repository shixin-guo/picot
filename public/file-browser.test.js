import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FileBrowser } from "./file-browser.js";

function makeContainer() {
  return {
    innerHTML: "",
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
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
