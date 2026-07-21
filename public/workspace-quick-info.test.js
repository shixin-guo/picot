// ABOUTME: Verifies workspace quick-info hover/focus card, Git caching, pin control, and lifecycle.
// ABOUTME: Covers inert rendering, 120ms hover intent, immediate keyboard focus, abort, viewport clamping.
/* biome-ignore-all lint/correctness/noUnusedVariables: test harness destructuring keeps fixtures readable */
/* biome-ignore-all lint/correctness/noUnusedFunctionParameters: mock signatures mirror production APIs */
/* biome-ignore-all lint/suspicious/useIterableCallbackReturn: timer callback assertions intentionally return void */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { WorkspaceQuickInfo } from "./workspace-quick-info.js";

// ── Test harness ──────────────────────────────────────────────────────

function makeWorkspace(overrides = {}) {
  return {
    workspaceId: "history:alpha",
    path: "/work/alpha",
    folderName: "alpha",
    normalizedPath: "/work/alpha",
    sessions: [
      { filePath: "/sessions/a1.jsonl", name: "A1" },
      { filePath: "/sessions/a2.jsonl", name: "A2" },
    ],
    isProvisional: false,
    source: "history",
    lastActivityAt: 1000,
    ...overrides,
  };
}

function makePinStore(initialPinned = new Set()) {
  const pinned = new Set(initialPinned);
  const subscribers = new Set();
  return {
    pinned,
    isWorkspacePinned: vi.fn((id) => pinned.has(id)),
    pinWorkspace: vi.fn((id, _path) => {
      pinned.add(id);
      return { ok: true, changed: true };
    }),
    unpinWorkspace: vi.fn((id) => {
      pinned.delete(id);
      return { ok: true, changed: true };
    }),
    subscribe: vi.fn((cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
    notify() {
      for (const cb of subscribers) cb();
    },
  };
}

function makeHarness(overrides = {}) {
  const timeouts = [];
  const st = vi.fn((cb, ms) => {
    timeouts.push({ cb, ms });
    return timeouts.length;
  });
  const ct = vi.fn((id) => {
    // Remove the timer at index id-1 (ids are 1-based array positions).
    if (id >= 1 && id <= timeouts.length) timeouts[id - 1] = null;
  });

  const abortControllers = [];
  const createAbortController = vi.fn(() => {
    const ac = {
      aborted: false,
      signal: { aborted: false },
      abort() {
        this.aborted = true;
        this.signal.aborted = true;
      },
    };
    abortControllers.push(ac);
    return ac;
  });

  const pinStore = overrides.pinStore || makePinStore();

  const workspace = overrides.workspace || makeWorkspace();

  const headerEl = document.createElement("div");
  headerEl.className = "workspace-header";
  headerEl.tabIndex = 0;
  headerEl.getBoundingClientRect = () => ({
    top: 100,
    bottom: 130,
    left: 0,
    right: 280,
    width: 280,
    height: 30,
  });

  const cardContainer = document.createElement("div");
  document.body.appendChild(cardContainer);

  const qi = new WorkspaceQuickInfo({
    container: cardContainer,
    pinStore,
    fetchImpl: overrides.fetchImpl,
    setTimeout: st,
    clearTimeout: ct,
    measureViewport: () => ({ width: 1280, height: 800 }),
    createAbortController,
  });
  qi.bindHeader(headerEl, workspace);

  const flushTimeouts = () => {
    const pending = timeouts.splice(0);
    for (const entry of pending) {
      if (entry) entry.cb();
    }
  };
  const flushHoverIntent = () => {
    const pending = timeouts.splice(0);
    for (const entry of pending) {
      if (entry && entry.ms === 120) entry.cb();
    }
  };

  return {
    qi,
    pinStore,
    workspace,
    headerEl,
    cardContainer,
    st,
    ct,
    timeouts,
    flushTimeouts,
    flushHoverIntent,
    abortControllers,
  };
}

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const target = String(url);
    if (target.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sidebar: {
            pinWorkspace: "Pin workspace",
            unpinWorkspace: "Unpin workspace",
            quickInfo: {
              totalSessions: "Total sessions",
              threads: "{count} threads",
              path: "Path",
              loadingGit: "Loading Git information…",
              repository: "Repository",
              worktree: "Worktree",
              type: "Type",
              branch: "Branch",
              detachedAt: "Detached at {sha}",
              pinCapacityError: "Pin limit reached. Unpin another workspace first.",
              cardLabel: "Workspace {folder}",
            },
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

// ── 1. Static data shown immediately ─────────────────────────────────

describe("static workspace data", () => {
  test("shows the compact prototype rows immediately on open", () => {
    const { qi, headerEl } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");
    expect(card.querySelector(".wqi-folder-name").textContent).toBe("alpha");
    expect(card.querySelector(".wqi-count").textContent).toBe("2 threads");
    expect(card.querySelector(".wqi-path").textContent).toBe("/work/alpha");
    expect(card.querySelector(".wqi-count-icon")).not.toBeNull();
    expect(card.querySelector(".wqi-path-icon")).not.toBeNull();
    expect(card.querySelector(".wqi-row-label")).toBeNull();
  });

  test("total session count includes archived sessions", () => {
    const ws = makeWorkspace({
      sessions: [
        { filePath: "/s1.jsonl", name: "S1" },
        { filePath: "/s2.jsonl", name: "S2", archived: true },
        { filePath: "/s3.jsonl", name: "S3" },
      ],
    });
    const { qi, headerEl } = makeHarness({ workspace: ws });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    expect(document.querySelector(".wqi-count").textContent).toBe("3 threads");
  });

  test("derives folder name from last path segment when folderName missing", () => {
    const ws = makeWorkspace({ folderName: undefined, path: "/work/deep/beta" });
    const { qi, headerEl } = makeHarness({ workspace: ws });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    expect(document.querySelector(".wqi-folder-name").textContent).toBe("beta");
  });

  test("keeps an open card across a Pin-triggered sidebar rerender", () => {
    const { qi, headerEl, workspace } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const replacementHeader = document.createElement("div");
    replacementHeader.getBoundingClientRect = headerEl.getBoundingClientRect;
    qi.clearHeaders({ preserveCard: true });
    qi.setWorkspaces([workspace]);
    qi.bindHeader(replacementHeader, workspace);

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");
    expect(card.querySelector(".wqi-path").textContent).toBe("/work/alpha");
    expect(qi._currentHeader).toBe(replacementHeader);
  });
});

// ── 2. Inert rendering of HTML metacharacters ────────────────────────

describe("inert text rendering", () => {
  test("folder name and path with HTML metacharacters are inert", () => {
    const ws = makeWorkspace({
      folderName: "<script>alert(1)</script>",
      path: "/work/<img src=x onerror=alert(1)>",
    });
    const { qi, headerEl } = makeHarness({ workspace: ws });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const folderEl = document.querySelector(".wqi-folder-name");
    const pathEl = document.querySelector(".wqi-path");
    expect(folderEl.innerHTML).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(pathEl.innerHTML).toBe("/work/&lt;img src=x onerror=alert(1)&gt;");
    // No script element was created.
    expect(folderEl.querySelector("script")).toBeNull();
    expect(pathEl.querySelector("img")).toBeNull();
  });

  test("repository metadata with HTML metacharacters is inert", async () => {
    const ws = makeWorkspace();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "<b>evil/repo</b>",
        kind: "repository",
        branch: "main<script>alert(1)</script>",
        detachedAt: null,
      }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl, workspace: ws });
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    await vi.waitFor(() => {
      expect(document.querySelector(".wqi-repo").textContent).toBe("<b>evil/repo</b>");
    });

    const repoEl = document.querySelector(".wqi-repo");
    expect(repoEl.querySelector("b")).toBeNull();
    expect(repoEl.innerHTML).toContain("&lt;b&gt;");
    expect(repoEl.querySelector("script")).toBeNull();
    expect(document.querySelector(".wqi-type")).toBeNull();
    expect(document.querySelector(".wqi-branch")).toBeNull();
  });

  test("error text is inert", () => {
    const pinStore = makePinStore();
    pinStore.pinWorkspace = vi.fn(() => ({
      ok: false,
      error: "capacity",
      changed: false,
    }));
    const { qi, headerEl } = makeHarness({ pinStore });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const pinBtn = document.querySelector(".wqi-pin-btn");
    pinBtn.click();

    const errorEl = document.querySelector(".wqi-error");
    expect(errorEl.textContent).toContain("Pin limit reached");
    expect(errorEl.querySelector("script")).toBeNull();
  });
});

// ── 3. Hover intent (120ms delay, cancelled on leave) ────────────────

describe("hover intent", () => {
  test("pointer open waits 120ms before showing card", () => {
    const { qi, headerEl, st, timeouts } = makeHarness();
    headerEl.dispatchEvent(new Event("pointerenter"));

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).toBe("none");
    expect(st).toHaveBeenCalledWith(expect.any(Function), 120);

    // Flush the timer → card appears.
    const pending = timeouts.splice(0);
    for (const entry of pending) {
      if (entry && entry.ms === 120) entry.cb();
    }
    expect(card.style.display).not.toBe("none");
  });

  test("pointer leave cancels hover intent before card opens", () => {
    const { qi, headerEl, timeouts } = makeHarness();
    headerEl.dispatchEvent(new Event("pointerenter"));
    expect(timeouts.length).toBe(1);

    headerEl.dispatchEvent(new Event("pointerleave"));
    // Hover-intent timer was cancelled (nulled); no live 120ms timer remains.
    expect(timeouts.every((e) => e?.ms !== 120)).toBe(true);

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).toBe("none");
  });
});

// ── 4. Immediate keyboard focus ──────────────────────────────────────

describe("keyboard focus", () => {
  test("focusin opens card immediately without timer", () => {
    const { qi, headerEl, st } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");
    // No 120ms hover-intent timer should have been scheduled for focus.
    expect(st).not.toHaveBeenCalledWith(expect.any(Function), 120);
  });
});

// ── 5. Escape closes keyboard-opened card and returns focus ──────────

describe("Escape behavior", () => {
  test("Escape on card closes it and returns focus to header", () => {
    const { qi, headerEl } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    headerEl.focus = vi.fn();

    const card = document.querySelector(".workspace-quick-info");
    card.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(card.style.display).toBe("none");
    expect(headerEl.focus).toHaveBeenCalled();
  });

  test("Escape on header closes the card", () => {
    const { qi, headerEl } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");

    headerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card.style.display).toBe("none");
  });
});

// ── 6. Pin/Unpin aria state ──────────────────────────────────────────

describe("Pin/Unpin control", () => {
  test("button exposes aria-pressed reflecting pinned state", () => {
    const unpinned = makeHarness();
    unpinned.headerEl.dispatchEvent(new FocusEvent("focusin"));
    expect(document.querySelector(".wqi-pin-btn").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".wqi-pin-btn").getAttribute("aria-label")).toBe("Pin workspace");

    unpinned.qi.close();
    const pinned = makeHarness({ pinStore: makePinStore(new Set(["history:alpha"])) });
    pinned.headerEl.dispatchEvent(new FocusEvent("focusin"));
    const pinnedButton = document.querySelectorAll(".wqi-pin-btn").item(1);
    expect(pinnedButton.getAttribute("aria-pressed")).toBe("true");
    expect(pinnedButton.getAttribute("aria-label")).toBe("Unpin workspace");
  });

  test("clicking Pin or Unpin closes the card before mutating shared Pin state", () => {
    const { headerEl, pinStore } = makeHarness();
    const card = document.querySelector(".workspace-quick-info");
    pinStore.pinWorkspace = vi.fn(() => {
      expect(card.style.display).toBe("none");
      pinStore.pinned.add("history:alpha");
      return { ok: true, changed: true };
    });
    pinStore.unpinWorkspace = vi.fn(() => {
      expect(card.style.display).toBe("none");
      pinStore.pinned.delete("history:alpha");
      return { ok: true, changed: true };
    });

    headerEl.dispatchEvent(new FocusEvent("focusin"));
    document.querySelector(".wqi-pin-btn").click();
    expect(pinStore.pinWorkspace).toHaveBeenCalledWith("history:alpha", "/work/alpha");

    headerEl.dispatchEvent(new FocusEvent("focusin"));
    document.querySelector(".wqi-pin-btn").click();
    expect(pinStore.unpinWorkspace).toHaveBeenCalledWith("history:alpha");
  });

  test("capacity error shows localized message but does not throw", () => {
    const pinStore = makePinStore();
    pinStore.pinWorkspace = vi.fn(() => ({
      ok: false,
      error: "capacity",
      changed: false,
    }));
    const { qi, headerEl } = makeHarness({ pinStore });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    const pinBtn = document.querySelector(".wqi-pin-btn");
    pinBtn.click();

    const errorEl = document.querySelector(".wqi-error");
    expect(errorEl.hidden).toBe(false);
    expect(errorEl.textContent).toContain("Pin limit reached");
  });
});

// ── 7. Git metadata loading and cache ────────────────────────────────

describe("Git metadata", () => {
  test("fetches encoded workspaceId", async () => {
    const ws = makeWorkspace({ workspaceId: "history:my/repo" });
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "o/r",
        kind: "repository",
        branch: "main",
        detachedAt: null,
      }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl, workspace: ws });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());
    const url = String(fetchImpl.mock.calls[0][0]);
    expect(url).toContain("/api/workspace-info?workspaceId=");
    expect(url).toContain(encodeURIComponent("history:my/repo"));
  });

  test("shows only the repository in the compact Git row", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "owner/repo",
        kind: "worktree",
        branch: "feature/sidebar",
        detachedAt: null,
      }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    await vi.waitFor(() => {
      expect(document.querySelector(".wqi-repo").textContent).toBe("owner/repo");
    });
    expect(document.querySelector(".wqi-repo-icon")).not.toBeNull();
    expect(document.querySelector(".wqi-type")).toBeNull();
    expect(document.querySelector(".wqi-branch")).toBeNull();
  });

  test("detached HEAD keeps the compact repository-only card", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "o/r",
        kind: "repository",
        branch: null,
        detachedAt: "abc1234",
      }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    await vi.waitFor(() => {
      expect(document.querySelector(".wqi-repo").textContent).toBe("o/r");
    });
    expect(document.querySelector(".wqi-branch")).toBeNull();
  });

  test("non-Git workspace omits Git rows", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isGit: false }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    await vi.waitFor(() => {
      expect(document.querySelector(".wqi-git-loading").hidden).toBe(true);
    });
    expect(document.querySelector(".wqi-repo-row").hidden).toBe(true);
    expect(document.querySelector(".wqi-type-row")).toBeNull();
    expect(document.querySelector(".wqi-branch-row")).toBeNull();
  });

  test("30s positive cache avoids refetch on re-open", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "o/r",
        kind: "repository",
        branch: "main",
        detachedAt: null,
      }),
    }));
    const { qi, headerEl, workspace, flushTimeouts } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    await vi.waitFor(() => expect(document.querySelector(".wqi-repo").textContent).toBe("o/r"));

    // Close, reopen — cache hit should avoid second fetch.
    headerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".wqi-repo").textContent).toBe("o/r");
  });

  test("negative result cached (non-Git)", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ isGit: false }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    await vi.waitFor(() => expect(qi._cache.size).toBe(1));

    headerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("failure result cached for 30s", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "unknown" }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    headerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("Git error degrades to non-Git without disabling pin", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));

    await vi.waitFor(() => {
      expect(document.querySelector(".wqi-git-loading").hidden).toBe(true);
    });
    expect(document.querySelector(".wqi-repo-row").hidden).toBe(true);
    // Pin button still available.
    expect(document.querySelector(".wqi-pin-btn").hidden).toBe(false);
  });
});

// ── 8. Stale / abort sequence ────────────────────────────────────────

describe("stale and abort", () => {
  test("stale response does not replace a newer target", async () => {
    let resolveFirst;
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes("alpha")) {
        return new Promise((resolve) => {
          resolveFirst = () =>
            resolve({
              ok: true,
              status: 200,
              json: async () => ({
                isGit: true,
                repository: "OLD/repo",
                kind: "repository",
                branch: "old",
                detachedAt: null,
              }),
            });
        });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          isGit: true,
          repository: "NEW/repo",
          kind: "repository",
          branch: "new",
          detachedAt: null,
        }),
      };
    });

    const ws1 = makeWorkspace({
      workspaceId: "history:alpha",
      path: "/work/alpha",
      normalizedPath: "/work/alpha",
    });
    const ws2 = makeWorkspace({
      workspaceId: "history:beta",
      path: "/work/beta",
      normalizedPath: "/work/beta",
    });

    const pinStore = makePinStore();
    const timeouts = [];
    const st = vi.fn((cb, ms) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    });
    const ct = vi.fn(() => {});
    const abortControllers = [];
    const createAbortController = vi.fn(() => {
      const ac = {
        aborted: false,
        signal: { aborted: false },
        abort() {
          this.aborted = true;
          this.signal.aborted = true;
        },
      };
      abortControllers.push(ac);
      return ac;
    });

    const cardContainer = document.createElement("div");
    document.body.appendChild(cardContainer);

    const qi = new WorkspaceQuickInfo({
      container: cardContainer,
      pinStore,
      fetchImpl,
      setTimeout: st,
      clearTimeout: ct,
      measureViewport: () => ({ width: 1280, height: 800 }),
      createAbortController,
    });

    const header1 = document.createElement("div");
    header1.tabIndex = 0;
    header1.getBoundingClientRect = () => ({
      top: 100,
      bottom: 130,
      left: 0,
      right: 280,
      width: 280,
      height: 30,
    });
    const header2 = document.createElement("div");
    header2.tabIndex = 0;
    header2.getBoundingClientRect = () => ({
      top: 200,
      bottom: 230,
      left: 0,
      right: 280,
      width: 280,
      height: 30,
    });

    qi.bindHeader(header1, ws1);
    qi.bindHeader(header2, ws2);

    // Open alpha — starts slow fetch.
    header1.dispatchEvent(new FocusEvent("focusin"));
    // Immediately open beta — superseding alpha.
    header2.dispatchEvent(new FocusEvent("focusin"));

    // Now resolve alpha's slow fetch — it must NOT appear.
    resolveFirst();
    await vi.waitFor(() => {
      expect(document.querySelector(".wqi-repo").textContent).toBe("NEW/repo");
    });
    expect(document.querySelector(".wqi-repo").textContent).not.toBe("OLD/repo");
  });

  test("closing card aborts pending request", () => {
    const { qi, headerEl, abortControllers } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    expect(abortControllers.length).toBe(1);
    expect(abortControllers[0].aborted).toBe(false);

    headerEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(abortControllers[0].aborted).toBe(true);
  });
});

// ── 9. Viewport clamping ─────────────────────────────────────────────

describe("viewport clamping", () => {
  test("card clamps to stay within viewport vertically", () => {
    const headerEl = document.createElement("div");
    headerEl.tabIndex = 0;
    Object.defineProperty(headerEl, "getBoundingClientRect", {
      value: () => ({ top: 750, bottom: 780, left: 0, right: 280, width: 280, height: 30 }),
      configurable: true,
    });
    const timeouts = [];
    const ws = makeWorkspace();
    const cardContainer = document.createElement("div");
    document.body.appendChild(cardContainer);

    const qi = new WorkspaceQuickInfo({
      container: cardContainer,
      pinStore: makePinStore(),
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ isGit: false }),
      })),
      setTimeout: (cb) => {
        timeouts.push({ cb });
        return timeouts.length;
      },
      clearTimeout: () => {},
      measureViewport: () => ({ width: 1280, height: 800 }),
      createAbortController: () => ({ aborted: false, signal: { aborted: false }, abort() {} }),
    });
    qi.bindHeader(headerEl, ws);

    const card = document.querySelector(".workspace-quick-info");
    Object.defineProperty(card, "getBoundingClientRect", {
      value: () => ({ top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200 }),
      configurable: true,
    });

    headerEl.dispatchEvent(new FocusEvent("focusin"));
    const top = parseInt(card.style.top, 10);
    // header at 750, card height 200: 750 + 200 = 950 > 800 → clamp.
    expect(top).toBeLessThanOrEqual(800 - 200 - 8);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  test("card flips to left when it would overflow the right edge", () => {
    const headerEl = document.createElement("div");
    headerEl.tabIndex = 0;
    Object.defineProperty(headerEl, "getBoundingClientRect", {
      value: () => ({ top: 100, bottom: 130, left: 1200, right: 1280, width: 80, height: 30 }),
      configurable: true,
    });
    const ws = makeWorkspace();
    const cardContainer = document.createElement("div");
    document.body.appendChild(cardContainer);

    const timeouts = [];
    const st = vi.fn((cb, ms) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    });
    const ct = vi.fn(() => {});
    const createAbortController = vi.fn(() => {
      const ac = {
        aborted: false,
        signal: { aborted: false },
        abort() {
          this.aborted = true;
          this.signal.aborted = true;
        },
      };
      return ac;
    });

    const qi = new WorkspaceQuickInfo({
      container: cardContainer,
      pinStore: makePinStore(),
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ isGit: false }),
      })),
      setTimeout: st,
      clearTimeout: ct,
      measureViewport: () => ({ width: 1280, height: 800 }),
      createAbortController,
    });
    qi.bindHeader(headerEl, ws);

    const card = document.querySelector(".workspace-quick-info");
    Object.defineProperty(card, "getBoundingClientRect", {
      value: () => ({ top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200 }),
      configurable: true,
    });

    headerEl.dispatchEvent(new FocusEvent("focusin"));
    const left = parseInt(card.style.left, 10);
    // Card width 300, header right 1280 → left 1288 overflows → flip left of header.
    expect(left + 300).toBeLessThanOrEqual(1280);
  });
});

// ── 10. Locale refresh ───────────────────────────────────────────────

describe("locale refresh", () => {
  test("open card refreshes static labels on locale change", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "o/r",
        kind: "repository",
        branch: "main",
        detachedAt: null,
      }),
    }));
    const { qi, headerEl } = makeHarness({ fetchImpl });
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");

    // Dispatch the picot:locale-change event that i18n dispatches.
    window.dispatchEvent(
      new CustomEvent("picot:locale-change", {
        detail: { locale: "zh", preference: "zh" },
      }),
    );

    // Card should remain open and still have content.
    expect(card.style.display).not.toBe("none");
    expect(document.querySelector(".wqi-folder-name").textContent).toBe("alpha");
  });
});

// ── 11. Identity replacement ─────────────────────────────────────────

describe("provisional→history identity replacement", () => {
  test("setWorkspaces transfers open card to new id without closing", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        isGit: true,
        repository: "o/r",
        kind: "repository",
        branch: "main",
        detachedAt: null,
      }),
    }));

    const provisional = makeWorkspace({
      workspaceId: "path:/work/alpha",
      path: "/work/alpha",
      normalizedPath: "/work/alpha",
      isProvisional: true,
      source: "instance",
    });
    const { qi, headerEl, flushTimeouts } = makeHarness({
      fetchImpl,
      workspace: provisional,
    });
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");

    // Provisional → history: same path, new id.
    const history = makeWorkspace({
      workspaceId: "history:alpha",
      path: "/work/alpha",
      normalizedPath: "/work/alpha",
      isProvisional: false,
      source: "history",
    });
    qi.setWorkspaces([history]);

    // Card stays open.
    expect(card.style.display).not.toBe("none");
  });
});

// ── 12. Teardown ─────────────────────────────────────────────────────

describe("teardown", () => {
  test("destroy removes card from DOM and clears caches", () => {
    const { qi, headerEl } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    expect(document.querySelector(".workspace-quick-info")).not.toBeNull();

    qi.destroy();

    expect(document.querySelector(".workspace-quick-info")).toBeNull();
    // After destroy, dispatching events on the old header does nothing.
    expect(() => headerEl.dispatchEvent(new FocusEvent("focusin"))).not.toThrow();
  });

  test("unbindHeader removes listeners from a single header", () => {
    const { qi, headerEl } = makeHarness();
    qi.unbindHeader(headerEl);
    const card = document.querySelector(".workspace-quick-info");

    // Should not open.
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    expect(card.style.display).toBe("none");
  });

  test("clearHeaders unbinds all and closes card", () => {
    const { qi, headerEl } = makeHarness();
    headerEl.dispatchEvent(new FocusEvent("focusin"));
    qi.clearHeaders();

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).toBe("none");
  });
});

// ── 13. Close delay and card hover bridge ────────────────────────────

describe("close delay and pointer bridge", () => {
  test("pointer leaving header starts close delay", () => {
    const { qi, headerEl, timeouts } = makeHarness();
    // Open via pointer.
    headerEl.dispatchEvent(new Event("pointerenter"));
    // Flush hover intent.
    timeouts.splice(0).forEach((e) => e?.cb());

    const card = document.querySelector(".workspace-quick-info");
    expect(card.style.display).not.toBe("none");

    headerEl.dispatchEvent(new Event("pointerleave"));
    const closeDelays = timeouts.filter((e) => e && e.ms === 120);
    expect(closeDelays.length).toBeGreaterThan(0);
  });

  test("entering card cancels close delay", () => {
    const { qi, headerEl, timeouts } = makeHarness();
    headerEl.dispatchEvent(new Event("pointerenter"));
    timeouts.splice(0).forEach((e) => e?.cb());

    const card = document.querySelector(".workspace-quick-info");
    headerEl.dispatchEvent(new Event("pointerleave"));

    card.dispatchEvent(new Event("pointerenter"));
    // Flushing timers should NOT close the card since we entered it.
    timeouts.splice(0).forEach((e) => e?.cb());
    expect(card.style.display).not.toBe("none");
  });
});
