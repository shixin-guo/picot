import { JSDOM } from "jsdom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionSidebar } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(button.getAttribute("aria-label")).toBe("Open project");
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
