import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../../i18n.js";
import { setSuperAgentEnabled } from "../../super-agent/settings.js";
import { formatSessionTime, SessionSidebar, workspaceFolderName } from "./session-sidebar.js";

// Test file lives at public/native/session/session-sidebar.test.js.
// i18n locale JSONs live at public/locales/en.json. Vitest's
// process.cwd() inside the jsdom test environment resolves to the
// test file's directory, not the repo root, so we derive the locale
// path from import.meta.url (always the real file URL under vitest ESM).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EN_LOCALE_PATH = join(__dirname, "..", "..", "locales", "en.json");
const enMessages = JSON.parse(readFileSync(EN_LOCALE_PATH, "utf8"));

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
  const config = {
    call: vi.fn().mockResolvedValue({ ok: true, data: { title: "Generated title" } }),
  };
  const control = { deleteSessions: vi.fn().mockResolvedValue({ deleted: [], errors: [] }) };
  const onSelect = vi.fn();
  const sidebar = new SessionSidebar(container, {
    data,
    runtime,
    control,
    config,
    getTarget: () => ({ workspaceId: "ws-1", sessionId: "s-active" }),
    onSelect,
    ...overrides,
  });
  return { sidebar, container, data, runtime, config, control, onSelect };
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

beforeEach(async () => {
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/")) {
      return { ok: true, status: 200, json: async () => enMessages };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  await initI18n();
});

describe("workspaceFolderName", () => {
  it("returns a POSIX basename", () => {
    expect(workspaceFolderName("/Users/me/Documents/test")).toBe("test");
  });

  it("returns only the folder name for Windows extended UNC paths", () => {
    expect(workspaceFolderName(String.raw`\\?\UNC\psf\Home\Documents\test`)).toBe("test");
    expect(workspaceFolderName(String.raw`\\?\UNC\psf\Home\Documents\New project 2`)).toBe(
      "New project 2",
    );
  });

  it("prefers a clean projectName over a Windows path", () => {
    expect(workspaceFolderName(String.raw`C:\Users\me\proj`, "proj")).toBe("proj");
  });
});

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
  beforeEach(async () => {
    localStorage.clear();
    // Load the English locale so context-menu labels resolve before
    // the first render. P6 i18n-ized the hardcoded "Rename" /
    // "Archive all sessions" entries; without this they read back
    // as their key strings.
    const enJson = readFileSync(EN_LOCALE_PATH, "utf8");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        if (String(input).includes("/locales/en.json")) {
          return new Response(enJson);
        }
        return new Response("{}", { status: 404 });
      }),
    );
    await initI18n();
    document.querySelectorAll(".session-context-menu").forEach((menu) => {
      menu.remove();
    });
    globalThis.fetch = vi.fn(async (input) => {
      if (String(input).includes("/locales/")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await initI18n();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("updates a generated session name while the agent is still running", async () => {
    const { sidebar, container } = makeSidebar([
      { id: "s-active", timestamp: new Date().toISOString(), firstMessage: "Help me name this" },
    ]);
    await sidebar.load();

    sidebar.setSessionName("s-active", "Generated in Parallel");

    expect(container.querySelector(".session-title").textContent).toBe("Generated in Parallel");
  });

  it("generates and persists a title for the active session", async () => {
    const { sidebar, container, config, runtime } = makeSidebar([
      { id: "s-active", timestamp: new Date().toISOString(), name: "Old title" },
    ]);
    await sidebar.load();
    const item = container.querySelector('.session-item[data-session-id="s-active"]');
    item.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    const generate = Array.from(document.querySelectorAll(".context-menu-item")).find((row) =>
      row.textContent.toLowerCase().includes("generate title"),
    );
    if (!generate) {
      const all = Array.from(document.querySelectorAll(".context-menu-item")).map(
        (row) => row.textContent,
      );
      throw new Error(`Generate title row missing. Rows: ${JSON.stringify(all)}`);
    }
    generate.click();

    await vi.waitFor(() =>
      expect(config.call).toHaveBeenCalledWith(
        "generate_session_title",
        {},
        { timeoutMs: 100_000, target: expect.objectContaining({ sessionId: "s-active" }) },
      ),
    );
    await vi.waitFor(() =>
      expect(runtime.request).toHaveBeenCalledWith(
        { type: "set_session_name", name: "Generated title" },
        expect.objectContaining({ sessionId: "s-active" }),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      ),
    );
    expect(item.querySelector(".session-title").textContent).toBe("Generated title");
  });

  it("renames a historical session through Pi SessionManager config", async () => {
    const { sidebar, container, config, runtime } = makeSidebar([
      {
        id: "s-history",
        timestamp: new Date().toISOString(),
        name: "Old title",
        filePath: "/sessions/history.jsonl",
      },
    ]);
    config.call.mockResolvedValue({
      ok: true,
      data: { filePath: "/sessions/history.jsonl", name: "New title" },
    });
    await sidebar.load();
    const item = container.querySelector('.session-item[data-session-id="s-history"]');
    item.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
    const rename = Array.from(document.querySelectorAll(".context-menu-item")).find((row) =>
      row.textContent.includes("Rename"),
    );
    if (!rename) {
      // Surface what was rendered so the test fails with a useful message
      // rather than the cryptic "Cannot read properties of undefined".
      const all = Array.from(document.querySelectorAll(".context-menu-item")).map(
        (row) => row.textContent,
      );
      throw new Error(`Rename row missing from context menu. Rows: ${JSON.stringify(all)}`);
    }
    rename.click();
    const input = item.querySelector(".session-rename-input");
    input.value = "New title";
    input.dispatchEvent(new FocusEvent("blur"));

    await vi.waitFor(() =>
      expect(config.call).toHaveBeenCalledWith("rename_historical_session", {
        filePath: "/sessions/history.jsonl",
        name: "New title",
      }),
    );
    expect(runtime.request).not.toHaveBeenCalled();
    expect(item.querySelector(".session-title").textContent).toBe("New title");
  });

  it("loads a targetless launcher catalog with an explicit cache scope", async () => {
    const loadSessions = vi.fn().mockResolvedValue({
      sessions: [
        {
          id: "s-launcher",
          timestamp: new Date().toISOString(),
          name: "Launcher session",
          projectPath: "/ws-launcher",
          projectName: "ws-launcher",
          isCurrentWorkspace: false,
        },
      ],
    });
    const { sidebar, container, data } = makeSidebar([], {
      getTarget: () => null,
      cacheScope: "launcher",
      loadSessions,
      enableFullTextSearch: false,
    });

    await sidebar.load();

    expect(loadSessions).toHaveBeenCalledOnce();
    expect(data.listAllSessions).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Launcher session");
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
    expect(container.querySelector(".ui-loading")).not.toBeNull();
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

  it("keeps cached sessions and Agent Inbox when an early host response is empty", async () => {
    setSuperAgentEnabled(true);
    const sessions = [
      {
        id: "s-active",
        timestamp: "2026-08-09T01:00:00.000Z",
        name: "Current session",
        projectPath: "/ws-1",
        projectName: "ws-1",
        isCurrentWorkspace: true,
      },
      {
        id: "agent-inbox",
        timestamp: "2026-08-09T02:00:00.000Z",
        projectPath: "/Users/me/.pi/agent/super-agent",
        projectName: "super-agent",
        isCurrentWorkspace: false,
      },
    ];
    localStorage.setItem("picot-session-list-cache:ws-1", JSON.stringify(sessions));
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container, data } = makeSidebar([], { onAgentInboxSessionChange });
    data.listAllSessions.mockResolvedValueOnce({ sessions: [] });

    await sidebar.load();

    expect(container.querySelector('[data-session-id="s-active"]')).not.toBeNull();
    expect(sidebar.sessions).toHaveLength(2);
    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "agent-inbox", kind: "super-agent" }),
    );
    expect(JSON.parse(localStorage.getItem("picot-session-list-cache:ws-1"))).toHaveLength(2);
  });

  it("clears a cached in-progress status when the live session list has no runtime status", async () => {
    const pending = deferred();
    localStorage.setItem(
      "picot-session-list-cache:ws-1",
      JSON.stringify([
        {
          id: "s-interrupted",
          timestamp: new Date().toISOString(),
          name: "Interrupted",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
          status: "working",
        },
      ]),
    );
    const { sidebar, container, data } = makeSidebar([]);
    data.listAllSessions.mockReturnValueOnce(pending.promise);

    const load = sidebar.load();
    expect(
      container
        .querySelector('.session-item[data-session-id="s-interrupted"]')
        .classList.contains("streaming"),
    ).toBe(true);

    pending.resolve({
      sessions: [
        {
          id: "s-interrupted",
          timestamp: new Date().toISOString(),
          name: "Interrupted",
          projectPath: "/ws-1",
          projectName: "ws-1",
          isCurrentWorkspace: true,
        },
      ],
    });
    await load;

    expect(
      container
        .querySelector('.session-item[data-session-id="s-interrupted"]')
        .classList.contains("streaming"),
    ).toBe(false);
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

  it("upserts a newly bound session so it appears before the host list refresh catches up", async () => {
    const { sidebar, container } = makeSidebar([]);

    sidebar.upsertSession({
      id: "s-new",
      firstMessage: "Start with this request",
      timestamp: "2026-07-22T00:00:00.000Z",
      modifiedAtMs: 1,
      isCurrentWorkspace: true,
    });

    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Start with this request");
    expect(container.querySelector(".session-item").dataset.sessionId).toBe("s-new");

    sidebar.upsertSession({
      id: "s-new",
      firstMessage: "Follow-up should not replace the first title",
      modifiedAtMs: 2,
    });

    expect(container.querySelectorAll(".session-item")).toHaveLength(1);
    expect(container.querySelector(".session-title").textContent).toBe("Start with this request");
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

  it("keeps show more and show less controls for non-current project groups", async () => {
    const sessions = Array.from({ length: 12 }, (_, index) => ({
      id: `other-${index}`,
      timestamp: new Date(Date.now() - index * 1000).toISOString(),
      name: `Other ${index}`,
      projectPath: "/other",
      projectName: "other",
      isCurrentWorkspace: false,
    }));
    const { sidebar, container } = makeSidebar(sessions);

    await sidebar.load();

    let group = container.querySelector(".project-group");
    expect(group.querySelectorAll(".session-item")).toHaveLength(8);
    const showMore = group.querySelector(
      ".project-sessions-toggle:not(.project-sessions-toggle-less)",
    );
    expect(showMore).toBeTruthy();
    expect(group.querySelector(".project-sessions-toggle-less")).toBeNull();

    showMore.click();

    group = container.querySelector(".project-group");
    expect(group.querySelectorAll(".session-item")).toHaveLength(12);
    expect(
      group.querySelector(".project-sessions-toggle:not(.project-sessions-toggle-less)"),
    ).toBeNull();
    expect(group.querySelector(".project-sessions-toggle-less")).toBeTruthy();

    group.querySelector(".project-sessions-toggle-less").click();

    expect(
      container.querySelector(".project-group").querySelectorAll(".session-item"),
    ).toHaveLength(8);
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
    // In the 4-section model (RECENT/PINNED/PROJECTS/ARCHIVED) favourites
    // are not a separate section — they live under PROJECTS. Archived
    // sessions get their own ARCHIVED section.
    expect(container.querySelector(".archived-group")).toBeTruthy();
    expect(
      container.querySelector('.projects-group .session-item[data-session-id="s-fav"]'),
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

    // The first row is the i18n-ized "Archive sessions" action.
    // Older snapshots hardcoded "Archive all sessions"; the key now
    // resolves to that label only when the en.json locale is loaded.
    expect(menuItem?.textContent).toContain("Archive sessions");
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

  it("reports the latest Agent Inbox session for top-level navigation and hides its history", async () => {
    setSuperAgentEnabled(true);
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container } = makeSidebar(
      [
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
      ],
      { onAgentInboxSessionChange },
    );

    await sidebar.load();

    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: "sa-new",
        kind: "super-agent",
        name: "Agent Inbox",
        projectPath: "/Users/me/.pi/agent/super-agent",
      }),
    );
    expect(container.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa-new"]')).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa-old"]')).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="project"]')).not.toBeNull();
  });

  it("hides Agent Inbox sessions when the setting is disabled", async () => {
    setSuperAgentEnabled(false);
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container } = makeSidebar(
      [
        { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
        {
          id: "sa",
          timestamp: "2026-06-03T00:00:00.000Z",
          name: "Inbox",
          projectPath: "/Users/me/.pi/agent/super-agent",
          projectName: "super-agent",
          isCurrentWorkspace: false,
        },
      ],
      { onAgentInboxSessionChange },
    );

    await sidebar.load();

    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(null);
    expect(container.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(container.querySelector('.session-item[data-session-id="sa"]')).toBeNull();
    expect(container.textContent).not.toContain("Agent Inbox");
    expect(container.querySelector('.session-item[data-session-id="project"]')).not.toBeNull();
  });

  it("publishes Agent Inbox navigation after the setting is enabled without a new host fetch", async () => {
    setSuperAgentEnabled(false);
    const onAgentInboxSessionChange = vi.fn();
    const { sidebar, container } = makeSidebar(
      [
        { id: "project", timestamp: "2026-06-02T00:00:00.000Z", name: "Project chat" },
        {
          id: "sa",
          timestamp: "2026-06-03T00:00:00.000Z",
          name: "Inbox",
          projectPath: "/Users/me/.pi/agent/super-agent",
          projectName: "super-agent",
          isCurrentWorkspace: false,
        },
      ],
      { onAgentInboxSessionChange },
    );

    await sidebar.load();
    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(null);
    const projectItem = container.querySelector('.session-item[data-session-id="project"]');

    setSuperAgentEnabled(true);
    sidebar.syncAgentInboxNav();
    expect(onAgentInboxSessionChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "sa", kind: "super-agent", name: "Agent Inbox" }),
    );
    expect(container.querySelector('.session-item[data-session-id="project"]')).toBe(projectItem);
  });

  it("shows a delete-all button on the archived header that deletes archived sessions after confirming", async () => {
    const { sidebar, container, control } = makeSidebar([
      { id: "s-arc-1", timestamp: new Date().toISOString(), name: "Arc 1" },
      { id: "s-arc-2", timestamp: new Date().toISOString(), name: "Arc 2" },
    ]);
    sidebar.toggleArchived("s-arc-1");
    sidebar.toggleArchived("s-arc-2");
    await sidebar.load();

    const deleteAllBtn = container.querySelector(".archived-header .archived-delete-all-btn");
    expect(deleteAllBtn).toBeTruthy();
    expect(container.querySelector(".sidebar-section-footer .archived-delete-all-btn")).toBeNull();
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

describe("SessionSidebar.pinned", () => {
  beforeEach(() => {
    localStorage.clear();
    setSuperAgentEnabled(false);
  });

  it("renders no PINNED section when nothing is pinned", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    expect(container.querySelector(".pinned-group")).toBeNull();
  });

  it("shows only the folder name for Windows UNC pinned workspaces", async () => {
    const winPath = String.raw`\\?\UNC\psf\Home\Documents\test`;
    const { sidebar, container } = makeSidebar([
      {
        id: "s-win",
        filePath: "/sessions/s-win.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
        projectPath: winPath,
        projectName: winPath,
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace(winPath, winPath);
    await sidebar.load();
    const nameEl = container.querySelector(".pinned-workspace-group .workspace-name");
    expect(nameEl?.textContent).toBe("test");
    expect(nameEl?.title).toBe(winPath);
  });

  it("renders a PINNED section listing pinned workspace sessions", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
      {
        id: "s-2",
        filePath: "/sessions/s-2.jsonl",
        timestamp: new Date().toISOString(),
        name: "World",
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ws-1", "/ws-1");
    await sidebar.load();
    const group = container.querySelector(".pinned-group");
    expect(group).not.toBeNull();
    expect(group.querySelector(".pinned-workspace-group")).not.toBeNull();
    expect(group.querySelectorAll(".pinned-workspace-group .session-item")).toHaveLength(2);
    expect(group.textContent).toContain("PINNED");
  });

  it("excludes workspace-pinned sessions from the regular project list", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ws-1", "/ws-1");
    await sidebar.load();
    // The pinned session appears under PINNED (inside a workspace-group).
    expect(container.querySelectorAll(".pinned-group .session-item")).toHaveLength(1);
    // And does NOT appear under PROJECTS.
    expect(container.querySelectorAll(".projects-group .session-item")).toHaveLength(0);
  });

  it("renders the Unavailable sub-section for orphan pin records", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
    ]);
    await sidebar.load();
    // Pin a workspace and a session that don't exist in the loaded list.
    sidebar.pinnedStore.pinWorkspace("/ghost-ws", "/ghost-ws");
    sidebar.pinnedStore.pinSession("ghost-session");
    await sidebar.load();
    // Each orphan renders as a workspace-group with a .pinned-unavailable
    // message + an Unpin button (buildSidebarWorkspaceGroup contract).
    const unavailableRows = container.querySelectorAll(".pinned-unavailable");
    expect(unavailableRows.length).toBeGreaterThanOrEqual(2);
  });

  it("clears an orphan pin via the Unavailable Unpin button", async () => {
    const { sidebar, container } = makeSidebar([]);
    await sidebar.load();
    sidebar.pinnedStore.pinWorkspace("/ghost-ws", "/ghost-ws");
    await sidebar.load();
    // The orphan workspace-group renders an Unpin button alongside the
    // .pinned-unavailable message.
    const unpinBtn = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes(t("sidebar.unpinWorkspace")),
    );
    expect(unpinBtn).toBeTruthy();
    unpinBtn.click();
    expect(sidebar.pinnedStore.isWorkspacePinned("/ghost-ws")).toBe(false);
  });

  it("renders the PINNED section between RECENT and PROJECTS", async () => {
    const { sidebar, container } = makeSidebar([
      {
        id: "s-1",
        filePath: "/sessions/s-1.jsonl",
        timestamp: new Date().toISOString(),
        name: "Hello",
      },
      {
        id: "s-other",
        filePath: "/sessions/s-other.jsonl",
        timestamp: new Date().toISOString(),
        name: "Other",
        projectPath: "/other-ws",
        projectName: "other-ws",
        isCurrentWorkspace: false,
      },
    ]);
    await sidebar.load();
    // Touch the active session so it lands in the RECENT bucket.
    sidebar.setActive("s-1");
    // Pin only /ws-1; /other-ws stays in PROJECTS so the test can assert
    // the PINNED section sits between RECENT and PROJECTS.
    sidebar.pinnedStore.pinWorkspace("/ws-1", "/ws-1");
    await sidebar.load();
    // Sections now carry a `sidebar-section` prefix class, so check for
    // membership instead of exact className[0].
    const order = Array.from(container.children).map(
      (node) =>
        node.className.split(" ").find((c) => c.endsWith("-group")) || node.className.split(" ")[0],
    );
    const recentIdx = order.indexOf("recent-group");
    const pinnedIdx = order.indexOf("pinned-group");
    const projectIdx = order.indexOf("projects-group");
    expect(recentIdx).toBeGreaterThanOrEqual(0);
    expect(pinnedIdx).toBeGreaterThan(recentIdx);
    expect(projectIdx).toBeGreaterThan(pinnedIdx);
  });
});
