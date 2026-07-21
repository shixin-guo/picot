// ABOUTME: Verifies SessionSidebar renders and manipulates Pins through the real sidebar path.
// ABOUTME: Covers region order, unavailable Pins, live zero-session workspaces, and quick-info binding.
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { writeRecentSessions } from "./recent-sessions.js";
import { SessionSidebar } from "./sidebar/index.js";

function makePinStore(initial = { workspaces: [], sessions: [] }) {
  const state = structuredClone(initial);
  const listeners = new Set();
  const notify = () => {
    listeners.forEach((listener) => {
      listener(state);
    });
  };
  return {
    getRenderableState: () => structuredClone(state),
    isWorkspacePinned: (id) => state.workspaces.some((item) => item.id === id),
    isSessionPinned: (filePath) => state.sessions.includes(filePath),
    pinWorkspace: vi.fn((id, path) => {
      state.workspaces = [{ id, path }, ...state.workspaces.filter((item) => item.id !== id)];
      notify();
      return { ok: true };
    }),
    unpinWorkspace: vi.fn((id) => {
      state.workspaces = state.workspaces.filter((item) => item.id !== id);
      notify();
      return { ok: true };
    }),
    pinSession: vi.fn((filePath) => {
      state.sessions = [filePath, ...state.sessions.filter((item) => item !== filePath)];
      notify();
      return { ok: true };
    }),
    unpinSession: vi.fn((filePath) => {
      state.sessions = state.sessions.filter((item) => item !== filePath);
      notify();
      return { ok: true };
    }),
    migrateLegacyFavourites: vi.fn(() => ({ ok: true })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reconcileWorkspace: vi.fn(() => ({ ok: true })),
  };
}

function makeQuickInfo() {
  return {
    clearHeaders: vi.fn(),
    setWorkspaces: vi.fn(),
    bindHeader: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  };
}

function createProjects() {
  return [
    {
      workspaceId: "history:alpha",
      path: "/work/alpha",
      dirName: "alpha",
      sessions: [{ filePath: "/sessions/alpha.jsonl", name: "Alpha" }],
    },
    {
      workspaceId: "path:/work/live",
      path: "/work/live",
      dirName: "",
      isProvisional: true,
      sessions: [],
    },
  ];
}

beforeEach(async () => {
  const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CSS = dom.window.CSS || { escape: String };
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes("/locales/en.json")) {
      return {
        ok: true,
        json: async () => ({
          sidebar: {
            recent: "RECENT",
            pinned: "PINNED",
            projects: "PROJECTS",
            archived: "ARCHIVED",
            unavailable: "Unavailable",
            pinSession: "Pin session",
            unpinSession: "Unpin session",
            pinWorkspace: "Pin workspace",
            unpinWorkspace: "Unpin workspace",
            archiveWorkspaceSessions: "Archive sessions",
            openInFinder: "Open in Finder",
            workspaceActions: "Workspace actions",
            showMore: "Show more",
            showLess: "Show less",
            openProject: "Open project",
            emptySession: "Empty session",
            archive: "Archive",
            unarchive: "Unarchive",
            archiveSession: "Archive session",
            unarchiveSession: "Unarchive session",
            newChat: "New chat in {path}",
            deleteAllArchived: "Delete all archived sessions",
            justNow: "Just now",
            minutesAgo: "{minutes}m ago",
            hoursAgo: "{hours}h ago",
            yesterday: "Yesterday",
          },
        }),
      };
    }
    return { ok: false, json: async () => ({}) };
  });
  await initI18n();
});

afterEach(() => vi.restoreAllMocks());

describe("SessionSidebar PINNED integration", () => {
  test("renders fixed region order, unresolved Pins, and a live zero-session workspace", () => {
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const pinStore = makePinStore({
      workspaces: [{ id: "history:alpha", path: "/work/alpha" }],
      sessions: ["/sessions/missing.jsonl"],
    });
    const quickInfo = makeQuickInfo();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      pinStore,
      quickInfo,
    });
    sidebar.projects = createProjects();
    sidebar.render();

    const regions = Array.from(
      document.querySelectorAll(".recent-group, .pinned-group, .projects-group, .archived-group"),
    );
    expect(regions.map((region) => region.className.split(" ")[0])).toEqual([
      "recent-group",
      "pinned-group",
      "projects-group",
      "archived-group",
    ]);
    expect(document.querySelector(".favourites-group")).toBeNull();
    expect(document.querySelector(".pinned-unavailable").textContent).toContain(
      "/sessions/missing.jsonl",
    );
    expect(document.querySelector(".projects-group").textContent).toContain("live");
    expect(document.querySelector(".projects-group .sidebar-section-header").textContent).toContain(
      "PROJECTS",
    );
    expect(quickInfo.bindHeader).toHaveBeenCalledTimes(3);
  });

  test("pins and unpins a session with the action left of Archive", () => {
    const pinStore = makePinStore();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      pinStore,
      quickInfo: makeQuickInfo(),
    });
    sidebar.projects = createProjects();
    sidebar.render();

    const item = document.querySelector('.session-item[data-file-path="/sessions/alpha.jsonl"]');
    const pin = item.querySelector(".session-pin-btn");
    const archive = item.querySelector(".session-archive-btn");
    expect(pin).not.toBeNull();
    expect(archive).not.toBeNull();
    expect(pin.nextElementSibling).toBe(archive);

    pin.click();
    expect(pinStore.pinSession).toHaveBeenCalledWith("/sessions/alpha.jsonl");

    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }));
    expect(document.querySelector(".sidebar-context-menu")).toBeNull();
  });

  test("opens the same workspace actions from an ellipsis button and right click", () => {
    const pinStore = makePinStore();
    const onOpenProject = vi.fn();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      pinStore,
      quickInfo: makeQuickInfo(),
      onOpenProject,
    });
    sidebar.projects = createProjects();
    sidebar.render();

    const header = document.querySelector(".projects-group .workspace-header");
    const more = header.querySelector(".workspace-more-actions-btn");
    expect(more).not.toBeNull();
    more.click();
    expect(document.querySelector(".sidebar-context-menu").textContent).toContain("Pin workspace");
    expect(document.querySelector(".sidebar-context-menu").textContent).toContain("Open in Finder");
    expect(document.querySelector(".sidebar-context-menu").textContent).toContain(
      "Archive sessions",
    );

    document.querySelector(".sidebar-context-menu .context-menu-item:nth-child(2)").click();
    expect(onOpenProject).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "history:alpha", path: "/work/alpha" }),
    );

    header.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
    document.querySelector(".sidebar-context-menu .context-menu-item:first-child").click();
    expect(pinStore.pinWorkspace).toHaveBeenCalledWith("history:alpha", "/work/alpha");
  });

  test("uses the shared disclosure builder for PINNED workspace groups", () => {
    const pinStore = makePinStore({
      workspaces: [{ id: "history:alpha", path: "/work/alpha" }],
      sessions: [],
    });
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      pinStore,
      quickInfo: makeQuickInfo(),
    });
    sidebar.projects = createProjects();
    sidebar.render();

    const header = document.querySelector(".pinned-group .sidebar-section-header");
    const body = document.querySelector(".pinned-group .sidebar-section-sessions");
    expect(header.getAttribute("role")).toBe("button");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".pinned-group .workspace-group")).not.toBeNull();
    expect(document.querySelector(".pinned-workspace-unpin")).toBeNull();

    header.dispatchEvent(new KeyboardEvent("keydown", { key: " " }));
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(body.classList.contains("collapsed")).toBe(true);
  });

  test("reconciles a provisional pinned workspace when session history supplies its ID", async () => {
    const pinStore = makePinStore({
      workspaces: [{ id: "path:/work/live", path: "/work/live" }],
      sessions: [],
    });
    global.fetch = vi.fn(async (url) => {
      if (url === "/api/sessions")
        return {
          ok: true,
          json: async () => ({
            projects: [
              {
                dirName: "live",
                path: "/work/live",
                sessions: [{ filePath: "/sessions/live.jsonl", name: "Live" }],
              },
            ],
          }),
        };
      if (url === "/api/instances") return { ok: true, json: async () => ({ instances: [] }) };
      return { ok: false, json: async () => ({}) };
    });
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      pinStore,
      quickInfo: makeQuickInfo(),
    });
    sidebar.projects = [createProjects()[1]];

    await sidebar.loadSessions({ retries: 0 });

    expect(pinStore.reconcileWorkspace).toHaveBeenCalledWith({
      fromId: "path:/work/live",
      toId: "history:live",
      path: "/work/live",
    });
  });
});
