import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSuperAgentEnabled } from "../super-agent/settings.js";
import { SessionSidebar } from "./index.js";

describe("SessionSidebar Super Agent pinned session", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="sessions"></div>';
    localStorage.clear();
    setSuperAgentEnabled(true);
  });

  it("renders latest Super Agent session before normal projects and selects it through the normal callback", () => {
    const onSessionSelect = vi.fn();
    const sidebar = new SessionSidebar(
      document.getElementById("sessions"),
      onSessionSelect,
      vi.fn(),
      {
        superAgentPath: "/Users/me/.pi/agent/super-agent",
      },
    );
    sidebar.projects = [
      {
        path: "/Users/me/project",
        dirName: "project",
        sessions: [
          {
            filePath: "/project.jsonl",
            name: "Project chat",
            timestamp: "2026-06-02",
          },
        ],
      },
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          { filePath: "/sa-old.jsonl", name: "Old", timestamp: "2026-06-01" },
          { filePath: "/sa-new.jsonl", name: "New", timestamp: "2026-06-03" },
        ],
      },
    ];

    sidebar.render();

    const firstSession = document.querySelector(".session-item");
    expect(firstSession?.dataset.filePath).toBe("/sa-new.jsonl");
    expect(firstSession?.textContent).toContain("Agent Inbox");

    firstSession?.click();

    expect(onSessionSelect).toHaveBeenCalledTimes(1);
    expect(onSessionSelect.mock.calls[0][0]).toMatchObject({
      filePath: "/sa-new.jsonl",
      kind: "super-agent",
      name: "Agent Inbox",
    });
    expect(onSessionSelect.mock.calls[0][1]).toMatchObject({
      path: "/Users/me/.pi/agent/super-agent",
      kind: "super-agent",
    });
  });

  it("does not duplicate the pinned Super Agent session in the regular project list", () => {
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });
    sidebar.projects = [
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          {
            filePath: "/sa.jsonl",
            name: "Super Agent",
            timestamp: "2026-06-03",
          },
        ],
      },
    ];

    sidebar.render();

    expect(document.querySelectorAll('.session-item[data-file-path="/sa.jsonl"]')).toHaveLength(1);
  });

  it("shows the empty state instead of a blank list when disabled and only Super Agent sessions exist", () => {
    setSuperAgentEnabled(false);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });
    sidebar.projects = [
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          {
            filePath: "/sa.jsonl",
            name: "Super Agent",
            timestamp: "2026-06-03",
          },
        ],
      },
    ];

    sidebar.render();

    expect(document.querySelector('.session-item[data-file-path="/sa.jsonl"]')).toBeNull();
    expect(document.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(document.querySelector(".session-empty-state")).not.toBeNull();
  });

  it("hides Super Agent from the session list when the setting is off", () => {
    setSuperAgentEnabled(false);
    const sidebar = new SessionSidebar(document.getElementById("sessions"), vi.fn(), vi.fn(), {
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });
    sidebar.projects = [
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          {
            filePath: "/sa.jsonl",
            name: "Super Agent",
            timestamp: "2026-06-03",
          },
        ],
      },
      {
        path: "/Users/me/project",
        dirName: "project",
        sessions: [
          {
            filePath: "/project.jsonl",
            name: "Project",
            timestamp: "2026-06-01",
          },
        ],
      },
    ];

    sidebar.render();

    expect(document.querySelector('.session-item[data-file-path="/sa.jsonl"]')).toBeNull();
    expect(document.querySelector(".super-agent-pinned-group")).toBeNull();
    expect(document.getElementById("sessions")?.textContent).not.toContain("Agent Inbox");
    expect(document.querySelector('.session-item[data-file-path="/project.jsonl"]')).not.toBeNull();
  });

  it("hides non-pinned Super Agent sessions instead of rendering Super Agent History", () => {
    const onSessionSelect = vi.fn();
    const sidebar = new SessionSidebar(
      document.getElementById("sessions"),
      onSessionSelect,
      vi.fn(),
      {
        superAgentPath: "/Users/me/.pi/agent/super-agent",
      },
    );
    sidebar.projects = [
      {
        path: "/Users/me/.pi/agent/super-agent",
        dirName: "super-agent",
        sessions: [
          {
            file: "sa-pinned.jsonl",
            filePath: "/sa-pinned.jsonl",
            name: "Pinned",
            timestamp: "2026-06-03",
          },
          {
            file: "sa-other.jsonl",
            filePath: "/sa-other.jsonl",
            name: "Other",
            timestamp: "2026-06-02",
          },
        ],
      },
      {
        path: "/Users/me/project",
        dirName: "project",
        sessions: [
          {
            filePath: "/project.jsonl",
            name: "Project",
            timestamp: "2026-06-01",
          },
        ],
      },
    ];

    sidebar.render();

    expect(
      document.querySelectorAll('.session-item[data-file-path="/sa-pinned.jsonl"]'),
    ).toHaveLength(1);
    expect(document.querySelector('.session-item[data-file-path="/sa-other.jsonl"]')).toBeNull();
    expect(document.querySelector(".super-agent-history-group")).toBeNull();
    expect(document.getElementById("sessions")?.textContent).not.toContain("Super Agent History");
    expect(document.querySelector('.session-item[data-file-path="/project.jsonl"]')).not.toBeNull();
    expect(onSessionSelect).not.toHaveBeenCalled();
  });
});
