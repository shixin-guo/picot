// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowser } from "./file-browser.js";

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("FileBrowser", () => {
  let container;
  let pathEl;
  let messageInput;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    pathEl = document.createElement("div");
    messageInput = document.createElement("textarea");
    document.body.append(container, pathEl, messageInput);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores a slower, superseded response so it can't overwrite a newer directory listing", async () => {
    const browser = new FileBrowser(container, pathEl, messageInput);

    const slow = deferred();
    const fast = deferred();
    vi.spyOn(globalThis, "fetch").mockImplementation((url) => {
      if (url.includes("slow-dir")) return slow.promise;
      return fast.promise;
    });

    // Kick off the first (slow) load, then immediately navigate elsewhere
    // before it resolves — simulating a user double-clicking through
    // directories faster than the network can respond.
    const firstLoad = browser.load("/slow-dir");
    const secondLoad = browser.load("/fast-dir");

    // The newer request resolves first.
    fast.resolve({
      ok: true,
      json: async () => ({
        path: "/fast-dir",
        items: [{ name: "fast.txt", path: "/fast-dir/fast.txt", isDirectory: false }],
      }),
    });
    await secondLoad;

    expect(browser.currentPath).toBe("/fast-dir");

    // The stale request finally resolves — it must not stomp the view.
    slow.resolve({
      ok: true,
      json: async () => ({
        path: "/slow-dir",
        items: [{ name: "slow.txt", path: "/slow-dir/slow.txt", isDirectory: false }],
      }),
    });
    await firstLoad;

    expect(browser.currentPath).toBe("/fast-dir");
    expect(container.textContent).toContain("fast.txt");
    expect(container.textContent).not.toContain("slow.txt");
  });
});
