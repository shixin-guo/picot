import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setSuperAgentEnabled } from "../super-agent/settings.js";
import { formatSessionTime, SessionSidebar } from "./session-sidebar.js";

function makeSidebar(sessions, overrides = {}) {
  const container = document.createElement("div");
  // Sessions default to the current workspace/project so they land in the
  // expanded current-project group unless the test overrides projectPath.
  const enriched = sessions.map((session) => ({
    projectPath: "/ws-1",
    projectName: "ws-1",
    isCurrentWorkspace: true,
    ...session,
  }));
  const data = {
    listAllSessions: vi.fn().mockResolvedValue({ sessions: enriched }),
    searchSessions: vi.fn().mockResolvedValue({ results: [] }),
  };
  const runtime = { request: vi.fn().mockResolvedValue({}) };
  const control = { deleteSessions: vi.fn().mockResolvedValue({ deleted: [], errors: [] }) };
  const onSelect = vi.fn();
  const sidebar = new SessionSidebar(container, {
    data,
    runtime,
    control,
    getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-active" }),
    onSelect,
    ...overrides,
  });
  return { sidebar, container, data, runtime, control, onSelect };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("formatSessionTime", () => {
  it("renders relative labels instead of raw ISO strings", () => {
    const now = Date.now();
    expect(formatSessionTime(new Date(now - 30 * 1000).toISOString())).toBe("Just now");
    expect(formatSessionTime(new Date(now - 5 * 60 * 1000).toISOString())).toBe("5m ago");
    expect(formatSessionTime(new Date(now - 3 * 3600 * 1000).toISOString())).toBe("3h ago");
    expect(formatSessionTime(new Date(now - 26 * 3600 * 1000).toISOString())).toBe("Yesterday");
  });

  it("returns empty string for invalid input", () => {
    expect(formatSessionTime("")).toBe("");
    expect(formatSessionTime("not-a-date")).toBe("");
  });
});

describe("SessionSidebar.render", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders each session with a title and no visible timestamp", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-1", timestamp: new Date().toISOString(), name: "Hello", firstMessage: "hi" },
    ]);
    await sidebar.load();
    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Hello");
    expect(container.querySelector(".session-time")).toBeNull();
  });

  it("retries transient load failures before showing the manual retry error", async () => {
    vi.useFakeTimers();
    const { sidebar, container, data } = makeSidebar([]);
    data.listAllSessions
      .mockRejectedValueOnce(new Error("Host disconnected before the data request completed"))
      .mockResolvedValueOnce({
        sessions: [
          {
            id: "s-1",
            timestamp: new Date().toISOString(),
            name: "Recovered",
            projectPath: "/ws-1",
            projectName: "ws-1",
            isCurrentWorkspace: true,
          },
        ],
      });

    await sidebar.load();
    expect(container.textContent).toContain("Loading sessions");
    expect(container.textContent).not.toContain("Failed to load sessions");

    await vi.advanceTimersByTimeAsync(250);

    expect(data.listAllSessions).toHaveBeenCalledTimes(2);
    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Recovered");
  });

  it("renders a cached session list immediately while refreshing in the background", async () => {
    const pending = deferred();
    localStorage.setItem(
      "picot-session-list-cache:ws-1",
      JSON.stringify([
        {
          id: "s-cached",
          timestamp: new Date().toISOString(),
          name: "Cached",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
        },
      ]),
    );
    const { sidebar, container, data } = makeSidebar([]);
    data.listAllSessions.mockReturnValueOnce(pending.promise);

    const load = sidebar.load();

    expect(container.textContent).toContain("Cached");
    expect(container.textContent).not.toContain("Loading sessions");

    pending.resolve({
      sessions: [
        {
          id: "s-fresh",
          timestamp: new Date().toISOString(),
          name: "Fresh",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
        },
      ],
    });
    await load;

    expect(container.textContent).toContain("Fresh");
    expect(container.textContent).not.toContain("Cached");
  });

  it("falls back to the latest cached session list for a workspace without its own cache", async () => {
    const pending = deferred();
    localStorage.setItem(
      "picot-session-list-cache:latest",
      JSON.stringify([
        {
          id: "s-old-project",
          timestamp: new Date().toISOString(),
          name: "Old project",
          projectPath: "/old",
          projectName: "old",
          isCurrentWorkspace: true,
        },
        {
          id: "s-new-project",
          timestamp: new Date().toISOString(),
          name: "New project",
          projectPath: "/new",
          projectName: "new",
          isCurrentWorkspace: false,
        },
      ]),
    );
    const { sidebar, container, data } = makeSidebar([], {
      getTarget: () => ({ workspaceId: "ws-2", sessionId: "s-new-project" }),
    });
    data.listAllSessions.mockReturnValueOnce(pending.promise);

    const load = sidebar.load();

    expect(container.textContent).toContain("New project");
    expect(
      container.querySelector(".project-group.current-project .project-name").textContent,
    ).toBe("new");
    expect(container.textContent).not.toContain("Loading sessions");

    pending.resolve({ sessions: [] });
    await load;
  });

  it("does not rerender when the refreshed session list is unchanged", async () => {
    const session = {
      id: "s-1",
      timestamp: new Date().toISOString(),
      name: "One",
      projectPath: "/ws-1",
      projectName: "ws-1",
      isCurrentWorkspace: true,
    };
    localStorage.setItem("picot-session-list-cache:ws-1", JSON.stringify([session]));
    const { sidebar } = makeSidebar([]);
    sidebar.data.listAllSessions.mockResolvedValueOnce({ sessions: [session] });
    const render = vi.spyOn(sidebar, "render");

    await sidebar.load();

    expect(render).toHaveBeenCalledTimes(1);
  });

  it("marks the active session", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-active", timestamp: new Date().toISOString(), name: "Current" },
      { id: "s-2", timestamp: new Date().toISOString(), name: "Other" },
    ]);
    await sidebar.load();
    const active = container.querySelector(".session-item.active");
    expect(active?.dataset.sessionId).toBe("s-active");
  });

  it("invokes onSelect with the session object on click", async () => {
    const { sidebar, container, onSelect } = makeSidebar([
      { id: "s-2", timestamp: new Date().toISOString(), name: "Other" },
    ]);
    await sidebar.load();
    container.querySelector('.session-item[data-session-id="s-2"]').click();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-2", isCurrentWorkspace: true }),
    );
  });

  it("groups sessions by project and opens other projects in a new window", async () => {
    const { sidebar, container, onSelect } = makeSidebar([
      {
        id: "s-there",
        timestamp: new Date().toISOString(),
        name: "There",
        projectPath: "/other",
        projectName: "other",
        isCurrentWorkspace: false,
      },
      { id: "s-here", timestamp: new Date().toISOString(), name: "Here" },
    ]);
    await sidebar.load();
    const groups = container.querySelectorAll(".project-group");
    expect(groups).toHaveLength(2);
    // Project order follows the incoming recency order, even when the active
    // project appears later in the list.
    expect(groups[0].classList.contains("current-project")).toBe(false);
    expect(groups[0].querySelector(".project-name").textContent).toBe("other");
    expect(groups[1].classList.contains("current-project")).toBe(true);
    expect(groups[1].querySelector(".project-sessions").classList.contains("collapsed")).toBe(
      false,
    );
    expect(groups[0].querySelector(".project-sessions").classList.contains("collapsed")).toBe(true);
    container.querySelector('.session-item[data-session-id="s-there"]').click();
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "s-there", projectPath: "/other", isCurrentWorkspace: false }),
    );
  });

  it("shows the current project new-chat button for LAN clients", async () => {
    delete globalThis.__TAURI__;
    const onCreateSession = vi.fn().mockResolvedValue(undefined);
    const { sidebar, container } = makeSidebar(
      [{ id: "s-here", timestamp: new Date().toISOString(), name: "Here" }],
      { onCreateSession },
    );

    await sidebar.load();

    const button = container.querySelector(".current-project .project-new-chat-btn");
    expect(button).toBeTruthy();
    button.click();
    await vi.waitFor(() => expect(onCreateSession).toHaveBeenCalledWith("ws-1"));
  });

  it("groups favourites and archived into separate sections", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-fav", timestamp: new Date().toISOString(), name: "Fav" },
      { id: "s-arc", timestamp: new Date().toISOString(), name: "Arc" },
      { id: "s-reg", timestamp: new Date().toISOString(), name: "Reg" },
    ]);
    sidebar.toggleFavourite("s-fav");
    sidebar.toggleArchived("s-arc");
    await sidebar.load();
    expect(container.querySelector(".favourites-group")).toBeTruthy();
    expect(container.querySelector(".archived-group")).toBeTruthy();
    expect(
      container.querySelector('.favourites-group .session-item[data-session-id="s-fav"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('.archived-group .session-item[data-session-id="s-arc"]'),
    ).toBeTruthy();
  });

  it("archives every session in a project from the project header context menu", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-fav", timestamp: new Date().toISOString(), name: "Fav" },
      { id: "s-keep", timestamp: new Date().toISOString(), name: "Keep" },
      {
        id: "s-other",
        timestamp: new Date().toISOString(),
        name: "Other",
        projectPath: "/other",
        projectName: "other",
        isCurrentWorkspace: false,
      },
    ]);
    sidebar.toggleFavourite("s-fav");
    await sidebar.load();

    const currentHeader = container.querySelector(".project-group.current-project .project-header");
    currentHeader.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    const menuItem = document.querySelector(".session-context-menu .context-menu-item");

    expect(menuItem?.textContent).toContain("Archive all sessions");
    menuItem.click();

    expect(sidebar.isArchived("s-fav")).toBe(true);
    expect(sidebar.isArchived("s-keep")).toBe(true);
    expect(sidebar.isArchived("s-other")).toBe(false);
    expect(sidebar.isFavourite("s-fav")).toBe(false);
    expect(
      container.querySelectorAll(".archived-group > .project-sessions > .session-item"),
    ).toHaveLength(2);
    expect(container.querySelector(".archived-group .project-group")).toBeNull();
  });

  it("pins the latest Agent Inbox session before normal projects and hides its history", async () => {
    setSuperAgentEnabled(true);
    const { sidebar, container, onSelect } = makeSidebar([
      { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
      {
        id: "sa-old",
        timestamp: "2026-06-01T00:00:00.000Z",
        name: "Old Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
        projectName: "super-agent",
        isCurrentWorkspace: false,
      },
      {
        id: "sa-new",
        timestamp: "2026-06-03T00:00:00.000Z",
        name: "New Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
        projectName: "super-agent",
        isCurrentWorkspace: false,
      },
    ]);

    await sidebar.load();

    const pinnedGroup = container.firstElementChild;
    expect(pinnedGroup?.classList.contains("super-agent-pinned-group")).toBe(true);
    expect(pinnedGroup?.querySelector(".project-header")?.textContent).toContain("Agent Inbox");
    expect(pinnedGroup?.querySelector(".project-header")?.textContent).toContain("Pinned");
    const pinnedSession = pinnedGroup?.querySelector(".session-item");
    expect(pinnedSession?.dataset.sessionId).toBe("sa-new");
    expect(pinnedSession?.textContent).toContain("Agent Inbox");
    expect(container.querySelectorAll('.session-item[data-session-id="sa-new"]')).toHaveLength(1);
    expect(container.querySelector('.session-item[data-session-id="sa-old"]')).toBeNull();

    pinnedSession?.click();

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "sa-new",
        kind: "super-agent",
        name: "Agent Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
      }),
    );
  });

  it("hides Agent Inbox sessions when the setting is disabled", async () => {
    setSuperAgentEnabled(false);
    const { sidebar, container } = makeSidebar([
      { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
      {
        id: "sa",
        timestamp: "2026-06-03T00:00:00.000Z",
        name: "Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
        projectName: "super-agent",
        isCurrentWorkspace: false,
      },
    ]);

    await sidebar.load();

    expect(container.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa"]')).toBeNull();
    expect(container.textContent).not.toContain("Agent Inbox");
    expect(container.querySelector('.session-item[data-session-id="project"]')).not.toBeNull();
  });

  it("shows a delete-all button on the archived header that deletes archived sessions after confirming", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "s-arc-1", timestamp: new Date().toISOString(), name: "Arc 1" },
      { id: "s-arc-2", timestamp: new Date().toISOString(), name: "Arc 2" },
    ]);
    sidebar.toggleArchived("s-arc-1");
    sidebar.toggleArchived("s-arc-2");
    await sidebar.load();

    const deleteAllBtn = container.querySelector(".archived-delete-all-btn");
    expect(deleteAllBtn).toBeTruthy();
    control.deleteSessions.mockResolvedValueOnce({ deleted: ["s-arc-1", "s-arc-2"], errors: [] });
    deleteAllBtn.click();

    // Confirmation dialog is shown; accept it.
    const confirmDialog = document.querySelector(".sidebar-confirm-overlay");
    expect(confirmDialog).toBeTruthy();
    document.querySelector(".sidebar-confirm-yes").click();
    await Promise.resolve();
    await Promise.resolve();

    expect(control.deleteSessions).toHaveBeenCalledWith(["s-arc-1", "s-arc-2"]);
    expect(container.querySelector(".archived-group")).toBeFalsy();
    expect(sidebar.isArchived("s-arc-1")).toBe(false);
  });

  it("cancelling the delete-all confirm dialog keeps archived sessions", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "s-arc", timestamp: new Date().toISOString(), name: "Arc" },
    ]);
    sidebar.toggleArchived("s-arc");
    await sidebar.load();

    container.querySelector(".archived-delete-all-btn").click();
    document.querySelector(".sidebar-confirm-no").click();
    await Promise.resolve();

    expect(control.deleteSessions).not.toHaveBeenCalled();
    expect(sidebar.isArchived("s-arc")).toBe(true);
  });

  it("drives streaming indicator classes", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-1", timestamp: new Date().toISOString(), name: "One" },
    ]);
    await sidebar.load();
    sidebar.setStreaming("s-1", true);
    expect(container.querySelector('.session-item[data-session-id="s-1"]').classList).toContain(
      "streaming",
    );
    sidebar.setStreaming("s-1", false);
    expect(
      container
        .querySelector('.session-item[data-session-id="s-1"]')
        .classList.contains("streaming"),
    ).toBe(false);
  });

  it("hydrates unread and in-progress statuses from session summaries", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-active",
        timestamp: new Date().toISOString(),
        name: "Active",
        status: "working",
        unread: true,
      },
      {
        id: "s-background",
        timestamp: new Date().toISOString(),
        name: "Background",
        status: "working",
        unread: true,
      },
    ]);
    await sidebar.load();
    expect(
      container.querySelector('.session-item[data-session-id="s-active"]').classList,
    ).toContain("streaming");
    expect(
      container
        .querySelector('.session-item[data-session-id="s-active"]')
        .classList.contains("unread"),
    ).toBe(false);
    expect(
      container.querySelector('.session-item[data-session-id="s-background"]').classList,
    ).toContain("streaming");
    expect(
      container.querySelector('.session-item[data-session-id="s-background"]').classList,
    ).toContain("unread");
  });
});
