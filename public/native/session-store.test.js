import { describe, expect, it } from "vitest";
import { createSessionStore, reduceSessionState } from "./session-store.js";

const target = {
  workspaceId: "workspace-a",
  sessionId: "session-a",
  instanceId: "instance-a",
};

describe("session store", () => {
  it("applies contiguous events immutably and detects sequence gaps", () => {
    const initial = createSessionStore(target);
    const first = reduceSessionState(initial, {
      type: "runtime_event",
      target,
      sequence: 1,
      event: { type: "agent_start" },
    });
    expect(initial.lifecycle).toBe("starting");
    expect(first.lifecycle).toBe("working");
    expect(first.sequence).toBe(1);

    const gap = reduceSessionState(first, {
      type: "runtime_event",
      target,
      sequence: 3,
      event: { type: "agent_end" },
    });
    expect(gap).toMatchObject({ sequence: 1, snapshotRequired: true });
  });

  it("hydrates authoritative state and ignores another session", () => {
    const initial = createSessionStore(target);
    const hydrated = reduceSessionState(initial, {
      type: "runtime_snapshot",
      target,
      sequence: 7,
      state: { lifecycle: "idle", queue: { steering: ["one"], followUp: [] } },
    });
    expect(hydrated).toMatchObject({ lifecycle: "idle", sequence: 7, snapshotRequired: false });
    expect(hydrated.queue.steering).toEqual(["one"]);

    const unchanged = reduceSessionState(hydrated, {
      type: "runtime_event",
      target: { ...target, sessionId: "session-b" },
      sequence: 8,
      event: { type: "agent_start" },
    });
    expect(unchanged).toBe(hydrated);
  });
});
