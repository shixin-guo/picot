import { JSDOM } from "jsdom";
import { describe, expect, test, vi } from "vitest";
import { SessionSidebar } from "./session-sidebar.js";

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
});
