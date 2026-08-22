// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeFileBrowser } from "./file-browser.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeGateway(handler) {
  return { listFiles: handler };
}

async function settleUntil(predicate) {
  for (let index = 0; index < 10 && !predicate(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("NativeFileBrowser", () => {
  let container;
  let pathEl;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    pathEl = document.createElement("div");
    document.body.append(container, pathEl);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists workspace-relative entries scoped through the data gateway", async () => {
    const gateway = fakeGateway(async (workspaceId, path) => {
      expect(workspaceId).toBe("workspace-a");
      expect(path).toBe("");
      return { entries: [{ name: "src", relativePath: "src", kind: "directory" }] };
    });
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a");

    await browser.load();

    expect(container.textContent).toContain("src");
    expect(browser.currentPath).toBe("");
    expect(browser.getParentPath()).toBeNull();
  });

  it("navigates into a directory and computes its parent path", async () => {
    const gateway = fakeGateway(async (_workspaceId, path) => {
      if (path === "")
        return { entries: [{ name: "src", relativePath: "src", kind: "directory" }] };
      return { entries: [{ name: "app.js", relativePath: "src/app.js", kind: "file" }] };
    });
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a");
    await browser.load();

    container.querySelector(".file-item").click();
    await settleUntil(() => browser.currentPath === "src");
    expect(browser.currentPath).toBe("src");
    expect(browser.getParentPath()).toBe("");
  });

  it("shows a mention button but does not break directory navigation", async () => {
    const onMention = vi.fn();
    const gateway = fakeGateway(async (_workspaceId, path) => {
      if (path === "")
        return {
          entries: [
            { name: "src", relativePath: "src", kind: "directory" },
            { name: "a.ts", relativePath: "a.ts", kind: "file" },
          ],
        };
      return { entries: [] };
    });
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a", {
      onMention,
    });
    await browser.load();

    const buttons = container.querySelectorAll(".file-mention-btn");
    expect(buttons.length).toBe(2);

    // Clicking a directory's mention button navigates AND mentions (stopPropagation).
    buttons[0].click();
    expect(onMention).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "src", isDirectory: true }),
    );
    // Row navigation is not triggered when the mention button is clicked.
    expect(browser.currentPath).toBe("");

    // The file mention passes isDirectory: false.
    buttons[1].click();
    expect(onMention).toHaveBeenCalledWith(expect.objectContaining({ isDirectory: false }));
  });

  it("omits the mention button when no onMention handler is provided", async () => {
    const gateway = fakeGateway(async () => ({
      entries: [{ name: "a.ts", relativePath: "a.ts", kind: "file" }],
    }));
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a");
    await browser.load();
    expect(container.querySelectorAll(".file-mention-btn").length).toBe(0);
  });

  it("ignores a slower, superseded response so it can't overwrite a newer directory listing", async () => {
    const slow = deferred();
    const fast = deferred();
    const gateway = fakeGateway((_workspaceId, path) =>
      path === "slow-dir" ? slow.promise : fast.promise,
    );
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a");

    const firstLoad = browser.load("slow-dir");
    const secondLoad = browser.load("fast-dir");

    fast.resolve({
      entries: [{ name: "fast.txt", relativePath: "fast-dir/fast.txt", kind: "file" }],
    });
    await secondLoad;
    expect(browser.currentPath).toBe("fast-dir");

    slow.resolve({
      entries: [{ name: "slow.txt", relativePath: "slow-dir/slow.txt", kind: "file" }],
    });
    await firstLoad;

    expect(browser.currentPath).toBe("fast-dir");
    expect(container.textContent).toContain("fast.txt");
    expect(container.textContent).not.toContain("slow.txt");
  });

  it("shows an error message when the request rejects", async () => {
    const gateway = fakeGateway(async () => {
      throw new Error("Requested path is outside the registered workspace");
    });
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a");

    await browser.load("../etc");

    expect(container.textContent).toContain("outside the registered workspace");
  });

  it("shows workspace changes and opens them directly in diff mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          isGitRepository: true,
          files: [{ path: "src/app.js", status: "modified", code: "M" }],
        }),
      })),
    );
    const onFileSelect = vi.fn();
    const browser = new NativeFileBrowser(
      container,
      pathEl,
      fakeGateway(async () => ({ entries: [] })),
      "workspace-a",
      { onFileSelect },
    );

    await browser.load();
    const diffButton = container.querySelector('[data-view="diff"]');
    diffButton.click();
    container.querySelector(".file-change-item").click();

    expect(container.querySelector(".file-changes-heading")).not.toBeNull();
    expect(container.textContent).toContain("src/app.js");
    expect(onFileSelect).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: "src/app.js", mode: "diff" }),
    );
  });

  it("refresh() reloads the current directory through the gateway", async () => {
    const calls = [];
    const gateway = fakeGateway(async (_workspaceId, path) => {
      calls.push(path);
      return {
        entries: [{ name: "src", relativePath: path ? `${path}/src` : "src", kind: "directory" }],
      };
    });
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a");

    await browser.load("");
    await browser.load("src");
    await browser.refresh();

    expect(calls).toEqual(["", "src", "src"]);
  });

  it("setShowHidden forwards the flag to the gateway, notifies, and reloads only on change", async () => {
    const calls = [];
    const gateway = fakeGateway(async (_workspaceId, path, showHidden) => {
      calls.push({ path, showHidden });
      return { entries: [] };
    });
    const changes = [];
    const browser = new NativeFileBrowser(container, pathEl, gateway, "workspace-a", {
      onShowHiddenChange: (value) => changes.push(value),
    });

    expect(browser.showHidden).toBe(false);
    await browser.load();
    expect(calls[0]).toEqual({ path: "", showHidden: false });

    // Same value: no reload, no notification.
    await browser.setShowHidden(false);
    expect(calls).toHaveLength(1);
    expect(changes).toHaveLength(0);

    await browser.setShowHidden(true);
    expect(browser.showHidden).toBe(true);
    expect(changes).toEqual([true]);
    expect(calls[1]).toEqual({ path: "", showHidden: true });
  });

  it("switches between file and diff views", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          isGitRepository: true,
          files: [{ path: "changed.js", status: "modified", code: "M" }],
        }),
      })),
    );
    const browser = new NativeFileBrowser(
      container,
      pathEl,
      fakeGateway(async () => ({
        entries: [{ name: "regular.js", relativePath: "regular.js", kind: "file" }],
      })),
      "workspace-a",
    );

    await browser.load();
    expect(container.textContent).toContain("regular.js");
    expect(container.textContent).not.toContain("changed.js");

    container.querySelector('[data-view="diff"]').click();
    expect(container.textContent).toContain("changed.js");
    expect(container.textContent).not.toContain("regular.js");
  });
});
