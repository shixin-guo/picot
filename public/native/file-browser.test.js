// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
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

describe("NativeFileBrowser", () => {
  let container;
  let pathEl;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    pathEl = document.createElement("div");
    document.body.append(container, pathEl);
  });

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
    await Promise.resolve();
    await Promise.resolve();

    expect(browser.currentPath).toBe("src");
    expect(browser.getParentPath()).toBe("");
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
});
