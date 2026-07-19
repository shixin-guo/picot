// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { dispatchSuperAgentTask } from "./dispatch.js";

describe("super-agent dispatch", () => {
  it("uses the fresh session from the spawned child process instead of sending new_session again", async () => {
    const transport = {
      openWorkspace: vi.fn().mockResolvedValue(47822),
    };
    const updateSuperAgentTask = vi.fn().mockResolvedValue(null);
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const dispatchedTasks = new Map();

    await dispatchSuperAgentTask({
      task: {
        id: "task-1",
        status: "running",
        title: "Fix blank child session",
        targetProject: "/Users/me/project",
      },
      transport,
      getCurrentPort: () => 47821,
      updateSuperAgentTask,
      fetchImpl,
      dispatchedTasks,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    expect(transport.openWorkspace).toHaveBeenCalledWith(
      "/Users/me/project",
      expect.objectContaining({
        forceNewSession: false,
        openWindow: false,
        waitForHealth: true,
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:47822/api/rpc",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Task ID: task-1"),
      }),
    );
    expect(dispatchedTasks.get(47822)).toMatchObject({
      taskId: "task-1",
      superAgentPort: 47821,
      title: "Fix blank child session",
    });
  });

  it("marks a dispatched task failed when the child prompt is rejected", async () => {
    const transport = {
      openWorkspace: vi.fn().mockResolvedValue(47822),
    };
    const updates = [];
    const updateSuperAgentTask = vi.fn(async (_port, _taskId, updateTask) => {
      const current = {
        id: "task-1",
        status: "running",
        title: "Fix blank child session",
        targetProject: "/Users/me/project",
        dispatch: {
          superAgentPort: 47821,
          childPort: 47822,
        },
      };
      const next = updateTask(current);
      updates.push(next);
      return next;
    });
    const dispatchedTasks = new Map();

    await dispatchSuperAgentTask({
      task: {
        id: "task-1",
        status: "running",
        title: "Fix blank child session",
        targetProject: "/Users/me/project",
      },
      transport,
      getCurrentPort: () => 47821,
      updateSuperAgentTask,
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: false, error: "No active session" }),
      }),
      dispatchedTasks,
      logger: { error: vi.fn(), warn: vi.fn() },
    });

    expect(dispatchedTasks.has(47822)).toBe(false);
    expect(updates.at(-1)).toMatchObject({
      status: "failed",
      failReason: "No active session",
    });
  });
});
