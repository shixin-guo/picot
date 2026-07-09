import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { SessionSidebar } from "./session-sidebar.js";

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

function createSession(index) {
  return {
    filePath: `session-${index}.jsonl`,
    name: `Session ${index}`,
    timestamp: `2026-06-${String((index % 28) + 1).padStart(2, "0")}T12:00:00.000Z`,
  };
}

function getShowMoreButton() {
  return document.querySelector(".project-sessions-toggle:not(.project-sessions-toggle-less)");
}

describe("SessionSidebar project session pagination", () => {
  test("shows 5 sessions by default, expands by 10, and collapses by 10", () => {
    const dom = new JSDOM('<div id="sessions"></div>', { url: "http://localhost" });
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.CSS = dom.window.CSS;

    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn());
    sidebar.projects = [
      {
        path: "/work/alpha",
        dirName: "alpha",
        sessions: Array.from({ length: 27 }, (_, index) => createSession(index + 1)),
      },
    ];

    sidebar.render();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(5);
    let showMoreButton = getShowMoreButton();
    expect(showMoreButton).not.toBeNull();
    expect(showMoreButton.textContent).toBe("Show more");
    expect(document.querySelector(".project-sessions-toggle-less")).toBeNull();

    showMoreButton.click();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(15);
    showMoreButton = getShowMoreButton();
    let showLessButton = document.querySelector(".project-sessions-toggle-less");
    expect(showMoreButton).not.toBeNull();
    expect(showLessButton).not.toBeNull();

    showMoreButton.click();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(25);
    showMoreButton = getShowMoreButton();
    showLessButton = document.querySelector(".project-sessions-toggle-less");
    expect(showMoreButton).not.toBeNull();
    expect(showLessButton).not.toBeNull();

    showMoreButton.click();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(27);
    expect(getShowMoreButton()).toBeNull();
    showLessButton = document.querySelector(".project-sessions-toggle-less");
    expect(showLessButton).not.toBeNull();

    showLessButton.click();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(17);
    expect(getShowMoreButton()).not.toBeNull();
    expect(document.querySelector(".project-sessions-toggle-less")).not.toBeNull();

    document.querySelector(".project-sessions-toggle-less").click();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(7);
    expect(getShowMoreButton()).not.toBeNull();
    expect(document.querySelector(".project-sessions-toggle-less")).not.toBeNull();

    document.querySelector(".project-sessions-toggle-less").click();

    expect(document.querySelectorAll(".project-group .session-item")).toHaveLength(5);
    expect(getShowMoreButton()).not.toBeNull();
    expect(document.querySelector(".project-sessions-toggle-less")).toBeNull();
  });
});
