import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { SessionSidebar } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  global.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          sidebar: {
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
            deleteArchivedConfirmOne:
              "Delete {count} archived session permanently? This cannot be undone.",
            deleteArchivedConfirmMany:
              "Delete {count} archived sessions permanently? This cannot be undone.",
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

describe("SessionSidebar onboarding empty state", () => {
  test("renders a lightweight open project action when no sessions exist", () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;

    const onOpenProject = vi.fn();
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      onOpenProject,
    });

    sidebar.projects = [];
    sidebar.render();

    const button = document.querySelector(".session-empty-open-project");
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Open Project");
    expect(button.textContent).toContain("Open Project");

    button.click();
    expect(onOpenProject).toHaveBeenCalledTimes(1);
  });

  test("keeps the newest session list when overlapping refreshes resolve out of order", async () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.CSS = dom.window.CSS;

    let resolveFirst;
    let resolveSecond;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const second = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    globalThis.fetch = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);

    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());

    const firstLoad = sidebar.loadSessions({ quiet: true });
    const secondLoad = sidebar.loadSessions({ quiet: true });

    resolveSecond({
      ok: true,
      json: async () => ({
        projects: [{ path: "/work", dirName: "--work", sessions: [{ filePath: "new.jsonl" }] }],
      }),
    });
    await secondLoad;
    expect(sidebar.projects[0].sessions[0].filePath).toBe("new.jsonl");

    resolveFirst({
      ok: true,
      json: async () => ({
        projects: [{ path: "/work", dirName: "--work", sessions: [{ filePath: "old.jsonl" }] }],
      }),
    });
    await firstLoad;

    expect(sidebar.projects[0].sessions[0].filePath).toBe("new.jsonl");
  });

  test("filters project groups by project name", () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.CSS = dom.window.CSS;

    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = [
      {
        path: "/work/alpha-dashboard",
        dirName: "alpha-dashboard",
        sessions: [{ filePath: "alpha.jsonl", name: "Fix login" }],
      },
      {
        path: "/work/beta-api",
        dirName: "beta-api",
        sessions: [{ filePath: "beta.jsonl", name: "Review auth" }],
      },
    ];

    sidebar.render();
    sidebar.setSearchQuery("alpha-dashboard");

    const groups = Array.from(document.querySelectorAll(".project-group"));
    expect(groups[0].style.display).toBe("");
    expect(groups[0].querySelector(".session-item").classList.contains("hidden")).toBe(false);
    expect(groups[1].style.display).toBe("none");
  });
});
