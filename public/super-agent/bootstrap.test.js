import { describe, expect, it, vi } from "vitest";

import { ensureSuperAgentSession } from "./bootstrap.js";

describe("ensureSuperAgentSession", () => {
  it("does not spawn when a Super Agent session is already running", async () => {
    const transport = { openWorkspace: vi.fn() };

    const result = await ensureSuperAgentSession({
      superAgentPath: "/Users/me/.pi/agent/super-agent",
      projects: [
        {
          path: "/Users/me/.pi/agent/super-agent",
          sessions: [{ filePath: "/sa.jsonl", port: 47822, isRunning: true }],
        },
      ],
      transport,
    });

    expect(result).toBe(false);
    expect(transport.openWorkspace).not.toHaveBeenCalled();
  });

  it("resumes existing Super Agent history instead of creating a new session", async () => {
    const transport = { openWorkspace: vi.fn().mockResolvedValue(47822) };

    const result = await ensureSuperAgentSession({
      superAgentPath: "/Users/me/.pi/agent/super-agent",
      projects: [
        {
          path: "/Users/me/.pi/agent/super-agent",
          sessions: [{ filePath: "/sa.jsonl" }],
        },
      ],
      transport,
    });

    expect(result).toBe(true);
    expect(transport.openWorkspace).toHaveBeenCalledWith("/Users/me/.pi/agent/super-agent", {
      sessionPath: "/sa.jsonl",
      forceNewSession: false,
      openWindow: false,
      waitForHealth: true,
      waitForSessions: true,
    });
  });

  it("spawns a background Super Agent workspace when no fixed session exists", async () => {
    const transport = { openWorkspace: vi.fn().mockResolvedValue(47822) };

    const result = await ensureSuperAgentSession({
      superAgentPath: "/Users/me/.pi/agent/super-agent",
      projects: [
        {
          path: "/Users/me/project",
          sessions: [{ filePath: "/project.jsonl" }],
        },
      ],
      transport,
    });

    expect(result).toBe(true);
    expect(transport.openWorkspace).toHaveBeenCalledWith("/Users/me/.pi/agent/super-agent", {
      sessionPath: null,
      forceNewSession: false,
      openWindow: false,
      waitForHealth: true,
      waitForSessions: true,
    });
  });
});
