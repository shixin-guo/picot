import { describe, expect, it } from "vitest";

import { planSuperAgentShutdown } from "./stop-plan.js";

describe("planSuperAgentShutdown", () => {
  it("does not stop the foreground Super Agent port before navigating to a normal workspace", () => {
    const plan = planSuperAgentShutdown({
      currentPort: 3002,
      superAgentPorts: [3001, 3002],
      instances: [
        { port: 3002, cwd: "/Users/me/.pi/agent/super-agent" },
        { port: 3003, cwd: "/Users/me/project" },
      ],
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });

    expect(plan.portsToStopBeforeNavigation).toEqual([3001]);
    expect(plan.navigateToPort).toBe(3003);
    expect(plan.portsToStopAfterNavigation).toEqual([3002]);
  });

  it("stops all Super Agent ports immediately when the foreground is not Super Agent", () => {
    const plan = planSuperAgentShutdown({
      currentPort: 3003,
      superAgentPorts: [3001, 3002],
      instances: [
        { port: 3002, cwd: "/Users/me/.pi/agent/super-agent" },
        { port: 3003, cwd: "/Users/me/project" },
      ],
      superAgentPath: "/Users/me/.pi/agent/super-agent",
    });

    expect(plan.portsToStopBeforeNavigation).toEqual([3001, 3002]);
    expect(plan.navigateToPort).toBeNull();
    expect(plan.portsToStopAfterNavigation).toEqual([]);
  });
});
