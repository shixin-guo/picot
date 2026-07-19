import { JSDOM } from "jsdom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionSidebar } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
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
