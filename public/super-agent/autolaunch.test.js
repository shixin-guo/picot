import { describe, expect, it } from "vitest";

import { selectSuperAgentSessionToLaunch } from "./autolaunch.js";

describe("super-agent autolaunch", () => {
  it("selects the latest Agent Inbox session when enabled", () => {
    const selected = selectSuperAgentSessionToLaunch({
      enabled: true,
      currentSessionId: "normal",
      sessions: [
        { id: "normal", projectPath: "/Users/me/project", timestamp: 30 },
        { id: "agent-old", projectPath: "/Users/me/.pi/agent/super-agent", timestamp: 10 },
        { id: "agent-new", projectPath: "/Users/me/.pi/agent/super-agent", timestamp: 20 },
      ],
    });

    expect(selected?.id).toBe("agent-new");
  });

  it("does not relaunch after navigation already landed on Agent Inbox", () => {
    const selected = selectSuperAgentSessionToLaunch({
      enabled: true,
      currentSessionId: "agent-new",
      sessions: [
        { id: "normal", projectPath: "/Users/me/project", timestamp: 30 },
        { id: "agent-new", projectPath: "/Users/me/.pi/agent/super-agent", timestamp: 20 },
      ],
    });

    expect(selected).toBeNull();
  });

  it("does not launch when disabled or already launched", () => {
    const sessions = [{ id: "agent", projectPath: "/Users/me/.pi/agent/super-agent" }];

    expect(selectSuperAgentSessionToLaunch({ enabled: false, sessions })).toBeNull();
    expect(
      selectSuperAgentSessionToLaunch({ enabled: true, alreadyLaunched: true, sessions }),
    ).toBeNull();
  });
});
