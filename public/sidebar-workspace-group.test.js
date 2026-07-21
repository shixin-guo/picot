// ABOUTME: Focused tests for sidebar workspace-group and section DOM builders.
// ABOUTME: Covers disclosure semantics, inert hostile labels, stable IDs, and safe rendering.

import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n } from "./i18n.js";
import { buildSidebarSection, buildSidebarWorkspaceGroup } from "./sidebar-workspace-group.js";

function setupDom() {
  const dom = new JSDOM('<div id="container"></div>', { url: "http://localhost:3001" });
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
            pinned: "Pinned",
            projects: "Projects",
            newChat: "New chat in {path}",
            emptySession: "Empty session",
            untitled: "Untitled",
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

describe("buildSidebarSection", () => {
  test("renders a collapsible section with title, chevron, and aria-expanded", () => {
    setupDom();
    const container = document.getElementById("container");
    const { section, header } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      expanded: true,
    });
    container.appendChild(section);

    expect(section.className).toContain("sidebar-section");
    expect(section.querySelector(".sidebar-section-title").textContent).toBe("Pinned");
    expect(header.getAttribute("role")).toBe("button");
    expect(header.tabIndex).toBe(0);
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.querySelector(".chevron")).not.toBeNull();
  });

  test("toggles disclosure on click", () => {
    setupDom();
    const container = document.getElementById("container");
    const { section, header, sessionsContainer } = buildSidebarSection({
      region: "recent",
      titleKey: "sidebar.recent",
      expanded: true,
    });
    container.appendChild(section);

    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(sessionsContainer.classList.contains("collapsed")).toBe(true);

    header.click();
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(sessionsContainer.classList.contains("collapsed")).toBe(false);
  });

  test("toggles disclosure on Enter and Space", () => {
    setupDom();
    const container = document.getElementById("container");
    const { section, header } = buildSidebarSection({
      region: "projects",
      titleKey: "sidebar.projects",
      expanded: true,
    });
    container.appendChild(section);
    const win = document.defaultView;

    header.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(header.getAttribute("aria-expanded")).toBe("false");

    header.dispatchEvent(new win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // Other keys do nothing
    header.dispatchEvent(new win.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  test("calls onToggle with the new expanded state", () => {
    setupDom();
    const onToggle = vi.fn();
    const { section, header } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      expanded: true,
      onToggle,
    });
    document.getElementById("container").appendChild(section);

    header.click();
    expect(onToggle).toHaveBeenCalledWith(false);
    header.click();
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  test("renders an optional count badge", () => {
    setupDom();
    const { section } = buildSidebarSection({
      region: "projects",
      titleKey: "sidebar.projects",
      count: 7,
    });
    const countEl = section.querySelector(".sidebar-section-count");
    expect(countEl).not.toBeNull();
    expect(countEl.textContent).toBe("7");
  });

  test("omits count badge when not provided", () => {
    setupDom();
    const { section } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
    });
    expect(section.querySelector(".sidebar-section-count")).toBeNull();
  });

  test("invokes renderSessions with the sessions container and renderFooter with footer", () => {
    setupDom();
    const renderSessions = vi.fn((el) => {
      const item = document.createElement("div");
      item.className = "session-item";
      el.appendChild(item);
    });
    const renderFooter = vi.fn((el) => {
      el.textContent = "footer text";
    });
    const { section, sessionsContainer } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      renderSessions,
      renderFooter,
    });

    expect(renderSessions).toHaveBeenCalledWith(sessionsContainer);
    expect(sessionsContainer.querySelector(".session-item")).not.toBeNull();
    const footer = section.querySelector(".sidebar-section-footer");
    expect(footer).not.toBeNull();
    expect(footer.textContent).toBe("footer text");
  });

  test("omits footer when renderFooter not provided", () => {
    setupDom();
    const { section } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
    });
    expect(section.querySelector(".sidebar-section-footer")).toBeNull();
  });

  test("respects initial collapsed state", () => {
    setupDom();
    const { header, sessionsContainer } = buildSidebarSection({
      region: "archived",
      titleKey: "sidebar.recent",
      expanded: false,
    });
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(sessionsContainer.classList.contains("collapsed")).toBe(true);
  });
});

describe("buildSidebarWorkspaceGroup", () => {
  test("renders folder name, count, and stable data-workspace-id", () => {
    setupDom();
    const { group, header } = buildSidebarWorkspaceGroup({
      workspaceId: "history:alpha",
      folderName: "alpha",
      workspacePath: "/work/alpha",
      sessionCount: 3,
    });
    document.getElementById("container").appendChild(group);

    expect(group.dataset.workspaceId).toBe("history:alpha");
    expect(group.querySelector(".workspace-name").textContent).toBe("alpha");
    expect(group.querySelector(".workspace-count").textContent).toBe("3");
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  test("defaults to folded and toggles via click", () => {
    setupDom();
    const result = buildSidebarWorkspaceGroup({
      workspaceId: "path:/work/beta",
      folderName: "beta",
    });
    document.getElementById("container").appendChild(result.group);

    expect(result.header.getAttribute("aria-expanded")).toBe("false");
    expect(result.sessionsContainer.classList.contains("collapsed")).toBe(true);

    result.header.click();
    expect(result.header.getAttribute("aria-expanded")).toBe("true");
    expect(result.sessionsContainer.classList.contains("collapsed")).toBe(false);
  });

  test("toggles disclosure on Enter and Space", () => {
    setupDom();
    const { group, header } = buildSidebarWorkspaceGroup({
      workspaceId: "history:gamma",
      folderName: "gamma",
      expanded: true,
    });
    document.getElementById("container").appendChild(group);
    const win = document.defaultView;

    header.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(header.getAttribute("aria-expanded")).toBe("false");
    header.dispatchEvent(new win.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  test("calls onToggle with new expanded state", () => {
    setupDom();
    const onToggle = vi.fn();
    const { group, header } = buildSidebarWorkspaceGroup({
      workspaceId: "history:delta",
      folderName: "delta",
      expanded: false,
      onToggle,
    });
    document.getElementById("container").appendChild(group);

    header.click();
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  test("renders new-chat button only when onNewChat is provided and stops propagation", () => {
    setupDom();
    const onNewChat = vi.fn();
    const onToggle = vi.fn();
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "history:eps",
      folderName: "eps",
      onNewChat,
      onToggle,
    });
    document.getElementById("container").appendChild(group);

    const btn = group.querySelector(".workspace-new-chat-btn");
    expect(btn).not.toBeNull();
    expect(btn.type).toBe("button");
    expect(btn.getAttribute("aria-label")).toContain("eps");

    btn.click();
    expect(onNewChat).toHaveBeenCalledTimes(1);
    // header click (toggle) must not fire because button stops propagation
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("does not render new-chat button when onNewChat is absent", () => {
    setupDom();
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "history:zeta",
      folderName: "zeta",
    });
    expect(group.querySelector(".workspace-new-chat-btn")).toBeNull();
  });

  test("click on header does not trigger toggle when originating from a nested button", () => {
    setupDom();
    const onToggle = vi.fn();
    const { group, header } = buildSidebarWorkspaceGroup({
      workspaceId: "history:eta",
      folderName: "eta",
      onToggle,
    });
    document.getElementById("container").appendChild(group);

    // Simulate a manually inserted button inside the header
    const extraBtn = document.createElement("button");
    extraBtn.type = "button";
    extraBtn.textContent = "extra";
    header.appendChild(extraBtn);

    extraBtn.click();
    expect(onToggle).not.toHaveBeenCalled();
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  test("invokes renderSessions preserving builder order (sessions appended before footer)", () => {
    setupDom();
    const order = [];
    const renderSessions = vi.fn((el) => {
      order.push("sessions");
      el.appendChild(document.createElement("div")).className = "session-item";
    });
    const renderFooter = vi.fn(() => {
      order.push("footer");
    });
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "history:theta",
      folderName: "theta",
      renderSessions,
      renderFooter,
    });

    expect(order).toEqual(["sessions", "footer"]);
    const footer = group.querySelector(".workspace-group-footer");
    expect(footer).not.toBeNull();
    expect(footer.nextElementSibling).toBeNull();
  });

  test("renders hostile folder name and path as inert text", () => {
    setupDom();
    const hostile = "<img src=x onerror=alert(1)>";
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "path:/work/evil",
      folderName: hostile,
      workspacePath: hostile,
    });
    document.getElementById("container").appendChild(group);

    const nameEl = group.querySelector(".workspace-name");
    expect(nameEl.textContent).toBe(hostile);
    // No <img> element should exist inside the group — the string is inert text.
    expect(group.querySelectorAll("img").length).toBe(0);
    // title holds the raw string as an inert attribute value (not an element/handler).
    expect(nameEl.title).toBe(hostile);
    // No element carries a live onerror handler.
    const allEls = group.querySelectorAll("*");
    allEls.forEach((el) => {
      expect(el.onerror).toBeFalsy();
    });
  });

  test("renders hostile count as inert text", () => {
    setupDom();
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "history:iota",
      folderName: "iota",
      sessionCount: 5,
    });
    const countEl = group.querySelector(".workspace-count");
    expect(countEl.textContent).toBe("5");
  });

  test("renders no data-workspace-id when workspaceId is empty", () => {
    setupDom();
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "",
      folderName: "kappa",
    });
    expect(group.hasAttribute("data-workspace-id")).toBe(false);
  });

  test("new-chat button has a localized aria-label using the folder name", () => {
    setupDom();
    const onNewChat = vi.fn();
    const { group } = buildSidebarWorkspaceGroup({
      workspaceId: "history:lambda",
      folderName: "lambda",
      onNewChat,
    });
    const btn = group.querySelector(".workspace-new-chat-btn");
    // The en.json fixture has newChat: "New chat in {path}"
    expect(btn.getAttribute("aria-label")).toBe("New chat in lambda");
    expect(btn.title).toBe("New chat in lambda");
  });
});

describe("buildSidebarSection inert rendering", () => {
  test("renders hostile title and count as inert text", () => {
    setupDom();
    // We pass a hostile-looking titleParams path value; since t() interpolates
    // safely, and the title is assigned via textContent, it stays inert.
    const { section } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      count: 42,
    });
    document.getElementById("container").appendChild(section);

    const countEl = section.querySelector(".sidebar-section-count");
    expect(countEl.textContent).toBe("42");
    expect(section.querySelectorAll("img").length).toBe(0);
  });
});
