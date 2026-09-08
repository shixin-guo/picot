import { beforeEach, describe, expect, it, vi } from "vitest";

const cardInstances = [];
vi.mock("./subagent-card.js", () => ({
  createSubagentCard: vi.fn((opts) => {
    const element = document.createElement("div");
    const card = { element, update: vi.fn((run) => (card.run = run)), opts, run: opts.run };
    cardInstances.push(card);
    return card;
  }),
}));

import { createSubagentRunManager } from "./subagent-runs.js";
import { readRuns } from "./subagent-store.js";

const TASK_TARGET = { workspaceId: "w1", sessionId: "s1::acp::abc", instanceId: "acp-task-abc" };

function makeDeps(overrides = {}) {
  return {
    runtime: { request: vi.fn(async () => ({})) },
    control: {
      startAcpTask: vi.fn(async () => TASK_TARGET),
      stopAcpTask: vi.fn(async () => {}),
    },
    getTarget: () => ({ workspaceId: "w1", sessionId: "s1" }),
    adapter: { subscribeTarget: vi.fn() },
    mount: vi.fn(),
    sendToPi: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe("subagent-runs", () => {
  beforeEach(() => {
    cardInstances.length = 0;
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("start() spawns a task runtime, prompts it, mounts a card, and stops it", async () => {
    const deps = makeDeps();
    const manager = createSubagentRunManager(deps);

    const run = await manager.start("  do the thing  ");

    expect(deps.control.startAcpTask).toHaveBeenCalledWith("w1", "s1", "claude-code");
    expect(deps.adapter.subscribeTarget).toHaveBeenCalledWith(TASK_TARGET);
    expect(deps.mount).toHaveBeenCalledTimes(1);
    expect(deps.runtime.request).toHaveBeenCalledWith(
      { type: "acp_prompt", message: "do the thing", images: [] },
      TASK_TARGET,
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(run.status).toBe("done");
    expect(deps.control.stopAcpTask).toHaveBeenCalledWith(TASK_TARGET);
    expect(readRuns("s1").map((r) => r.id)).toContain(run.id);
  });

  it("start() passes the chosen agent id and label through", async () => {
    const deps = makeDeps();
    const manager = createSubagentRunManager(deps);
    const run = await manager.start("do it", { id: "codex", label: "Codex" });
    expect(deps.control.startAcpTask).toHaveBeenCalledWith("w1", "s1", "codex");
    expect(run.agentId).toBe("codex");
    expect(run.agentLabel).toBe("Codex");
    expect(readRuns("s1")[0].agentId).toBe("codex");
  });

  it("start() ignores an empty task", async () => {
    const deps = makeDeps();
    const manager = createSubagentRunManager(deps);
    expect(await manager.start("   ")).toBeNull();
    expect(deps.control.startAcpTask).not.toHaveBeenCalled();
  });

  it("marks the run errored and records the reason when the prompt rejects", async () => {
    const deps = makeDeps({
      runtime: { request: vi.fn(async () => Promise.reject(new Error("agent not logged in"))) },
    });
    const manager = createSubagentRunManager(deps);

    const run = await manager.start("go");
    expect(run.status).toBe("error");
    expect(run.state.error).toContain("agent not logged in");
    expect(deps.control.stopAcpTask).toHaveBeenCalled();
  });

  it("applyEvent folds events for a known instance and ignores others", async () => {
    const deps = makeDeps();
    const manager = createSubagentRunManager(deps);
    await manager.start("go");
    const card = cardInstances[0];
    card.update.mockClear();

    const consumed = manager.applyEvent({
      target: TASK_TARGET,
      event: {
        type: "acp_session_update",
        params: {
          update: { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "hi" } },
        },
      },
    });
    expect(consumed).toBe(true);
    expect(card.update).toHaveBeenCalled();
    expect(card.run.state.blocks.at(-1)).toMatchObject({ kind: "message", text: "hi" });

    expect(manager.applyEvent({ target: { instanceId: "someone-else" }, event: { type: "acp_error" } })).toBe(
      false,
    );
  });

  it("restore() re-mounts the live card for an in-flight run", async () => {
    const deps = makeDeps();
    const manager = createSubagentRunManager(deps);
    await manager.start("go");
    const liveElement = cardInstances[0].element;
    deps.mount.mockClear();

    await manager.restore("s1");
    expect(deps.mount).toHaveBeenCalledWith(liveElement);
  });

  it("restore() rebuilds a read-only card from a persisted run in a fresh manager", async () => {
    await createSubagentRunManager(makeDeps()).start("go");

    const deps = makeDeps();
    cardInstances.length = 0;
    await createSubagentRunManager(deps).restore("s1");

    expect(deps.mount).toHaveBeenCalledTimes(1);
    expect(cardInstances[0].opts.run.taskText).toBe("go");
    expect(cardInstances[0].opts.run.status).toBe("done");
  });
});
