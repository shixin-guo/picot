import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { writeRecentSessions } from "./recent-sessions.js";
import { SessionSidebar } from "./session-sidebar.js";

function createProjects() {
  return [
    {
      path: "/work/alpha",
      dirName: "alpha",
      sessions: [{ filePath: "/sessions/alpha.jsonl", name: "Alpha work" }],
    },
    {
      path: "/work/beta",
      dirName: "beta",
      sessions: [{ filePath: "/sessions/beta.jsonl", name: "Beta work" }],
    },
  ];
}

function setupDom() {
  const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.CSS = dom.window.CSS || {
    escape: (value) => String(value).replace(/["\\]/g, "\\$&"),
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
            recent: "Recent",
            showMore: "Show more",
            showLess: "Show less",
            openProject: "Open Project",
            loadingSessions: "Loading sessions...",
            favourites: "Favourites",
            archived: "Archived",
            untitled: "Untitled",
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
            startingSession: "Starting session…",
            retry: "Retry",
            failedToLoadSessions: "Failed to load sessions.",
            failedToLoadSessionsRuntime: "Failed to load sessions. Pi runtime may be unavailable.",
            search: "Search...",
            clearSearch: "Clear search",
            openFolder: "Open folder as workspace",
            openFolderAria: "Open folder",
            refreshSessions: "Refresh sessions",
            settings: "Settings",
            updateAvailable: "Update available",
            update: "Update",
          },
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionSidebar RECENT group", () => {
  test("renders RECENT before Favourites in cookie order and reuses selection callback", () => {
    setupDom();
    const projects = createProjects();
    const onSelect = vi.fn();
    writeRecentSessions(["/sessions/beta.jsonl", "/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), onSelect, vi.fn());
    sidebar.projects = projects;
    sidebar.favourites = ["/sessions/alpha.jsonl"];
    sidebar.render();

    const recent = document.querySelector(".recent-group");
    expect(recent).not.toBeNull();
    expect(recent.previousElementSibling).toBeNull();
    expect(
      Array.from(recent.querySelectorAll(".session-item"), (item) => item.dataset.filePath),
    ).toEqual(["/sessions/beta.jsonl", "/sessions/alpha.jsonl"]);

    recent.querySelector(".session-item").click();
    expect(onSelect).toHaveBeenCalledWith(projects[1].sessions[0], projects[1]);
  });

  test("prunes archived and unresolved recent paths and filters the group", () => {
    setupDom();
    writeRecentSessions([
      "/sessions/missing.jsonl",
      "/sessions/alpha.jsonl",
      "/sessions/beta.jsonl",
    ]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.archived = ["/sessions/beta.jsonl"];
    sidebar.render();

    expect(sidebar.recent).toEqual(["/sessions/alpha.jsonl"]);
    sidebar.setSearchQuery("beta");
    expect(document.querySelector(".recent-group").style.display).toBe("none");
    sidebar.setSearchQuery("alpha");
    expect(document.querySelector(".recent-group").style.display).toBe("");
  });

  test("does not render RECENT when all saved paths are invalid", () => {
    setupDom();
    writeRecentSessions(["/sessions/missing.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.render();

    expect(document.querySelector(".recent-group")).toBeNull();
    expect(sidebar.recent).toEqual([]);
  });

  test("setActive promotes a session and synchronizes duplicate status classes", () => {
    setupDom();
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.favourites = ["/sessions/alpha.jsonl"];
    sidebar.unread.add("/sessions/alpha.jsonl");
    sidebar.setStreaming("/sessions/alpha.jsonl", true);
    sidebar.render();

    sidebar.setActive("/sessions/alpha.jsonl");
    const duplicates = document.querySelectorAll(
      '.session-item[data-file-path="/sessions/alpha.jsonl"]',
    );
    expect(duplicates).toHaveLength(3);
    duplicates.forEach((item) => {
      expect(item.classList.contains("active")).toBe(true);
      expect(item.classList.contains("unread")).toBe(false);
      expect(item.classList.contains("streaming")).toBe(true);
    });
  });

  test("keeps six selections bounded to the five most recent paths", () => {
    setupDom();
    const paths = Array.from({ length: 6 }, (_, index) => `/sessions/${index}.jsonl`);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    paths.forEach((path) => {
      sidebar.setActive(path);
    });

    expect(sidebar.recent).toEqual(paths.slice(1).reverse());
  });
});
