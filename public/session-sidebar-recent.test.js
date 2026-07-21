import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { writeRecentSessions } from "./recent-sessions.js";
import { SessionSidebar } from "./sidebar/index.js";

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
            recent: "RECENT",
            showMore: "Show more",
            showLess: "Show less",
            openProject: "Open Project",
            loadingSessions: "Loading sessions...",
            pinned: "PINNED",
            projects: "PROJECTS",
            archived: "Archived",
            untitled: "Untitled",
            emptySession: "Empty session",
            archive: "Archive",
            unarchive: "Unarchive",
            archiveSession: "Archive session",
            unarchiveSession: "Unarchive session",
            pinSession: "Pin session",
            unpinSession: "Unpin session",
            workspaceActions: "Workspace actions",
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
    expect(recent.querySelector(".recent-header").textContent).toContain("RECENT");
    expect(
      Array.from(recent.querySelectorAll(".session-item"), (item) => item.dataset.filePath),
    ).toEqual(["/sessions/beta.jsonl", "/sessions/alpha.jsonl"]);

    recent.querySelector(".session-item").click();
    expect(onSelect).toHaveBeenCalledWith(projects[1].sessions[0], projects[1]);
  });

  test("starts expanded and remains collapsed when a new session enters RECENT", () => {
    setupDom();
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.render();

    let header = document.querySelector(".recent-header");
    let sessions = document.querySelector(".recent-group .project-sessions");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(sessions.classList.contains("collapsed")).toBe(false);

    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(sessions.classList.contains("collapsed")).toBe(true);

    sidebar.setActive("/sessions/beta.jsonl");
    header = document.querySelector(".recent-header");
    sessions = document.querySelector(".recent-group .project-sessions");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(sessions.classList.contains("collapsed")).toBe(true);
    expect(sessions.querySelector('[data-file-path="/sessions/beta.jsonl"]')).not.toBeNull();

    const replacementContainer = document.createElement("div");
    document.body.appendChild(replacementContainer);
    const replacement = new SessionSidebar(replacementContainer, vi.fn(), vi.fn());
    replacement.projects = createProjects();
    replacement.render();
    expect(replacementContainer.querySelector(".recent-header").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(
      replacementContainer
        .querySelector(".recent-group .project-sessions")
        .classList.contains("collapsed"),
    ).toBe(false);
  });

  test("toggles RECENT with Enter and Space", () => {
    setupDom();
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.render();

    const header = document.querySelector(".recent-header");
    expect(header.getAttribute("role")).toBe("button");
    expect(header.tabIndex).toBe(0);

    header.dispatchEvent(
      new document.defaultView.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(header.getAttribute("aria-expanded")).toBe("false");

    header.dispatchEvent(
      new document.defaultView.KeyboardEvent("keydown", { key: " ", bubbles: true }),
    );
    expect(header.getAttribute("aria-expanded")).toBe("true");
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
    const recentItem = document.querySelector(".recent-group .session-item");
    sidebar.setSearchQuery("beta");
    expect(recentItem.classList.contains("hidden")).toBe(true);
    expect(document.querySelector(".recent-group").style.display).toBe("none");
    sidebar.setSearchQuery("alpha");
    expect(recentItem.classList.contains("hidden")).toBe(false);
    expect(document.querySelector(".recent-group").style.display).toBe("");
  });

  test("preserves the active search filter after a selection rerenders RECENT", () => {
    setupDom();
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.render();
    sidebar.setSearchQuery("alpha");

    sidebar.setActive("/sessions/beta.jsonl");

    const betaItem = document.querySelector(
      '.recent-group .session-item[data-file-path="/sessions/beta.jsonl"]',
    );
    expect(betaItem.classList.contains("hidden")).toBe(true);
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

  test("setActive records a new selection, promotes it, and rerenders RECENT in MRU order", () => {
    setupDom();
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.render();

    sidebar.setActive("/sessions/beta.jsonl");
    expect(sidebar.recent).toEqual(["/sessions/beta.jsonl", "/sessions/alpha.jsonl"]);
    expect(
      Array.from(
        document.querySelectorAll(".recent-group .session-item"),
        (item) => item.dataset.filePath,
      ),
    ).toEqual(["/sessions/beta.jsonl", "/sessions/alpha.jsonl"]);

    sidebar.setActive("/sessions/alpha.jsonl");
    expect(sidebar.recent).toEqual(["/sessions/alpha.jsonl", "/sessions/beta.jsonl"]);
  });

  test("setActive promotes a session and synchronizes duplicate status classes", () => {
    setupDom();
    writeRecentSessions(["/sessions/alpha.jsonl"]);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = createProjects();
    sidebar.unread.add("/sessions/alpha.jsonl");
    sidebar.setStreaming("/sessions/alpha.jsonl", true);
    sidebar.render();

    sidebar.setActive("/sessions/alpha.jsonl");
    const duplicates = document.querySelectorAll(
      '.session-item[data-file-path="/sessions/alpha.jsonl"]',
    );
    expect(duplicates).toHaveLength(2);
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
