import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteRun, readRuns, writeRun } from "./subagent-store.js";

const SESSION = "sess-1";

function run(id, extra = {}) {
  return {
    id,
    sessionId: SESSION,
    taskText: `task ${id}`,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:01:00.000Z",
    status: "done",
    resultText: `result ${id}`,
    state: { blocks: [{ kind: "message", text: `result ${id}` }] },
    ...extra,
  };
}

describe("subagent-store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a run through localStorage", () => {
    writeRun(SESSION, run("a"));
    const [record] = readRuns(SESSION);
    expect(record).toMatchObject({
      id: "a",
      taskText: "task a",
      status: "done",
      resultText: "result a",
      blocks: [{ kind: "message", text: "result a" }],
    });
  });

  it("replaces an existing run by id and preserves insertion order", () => {
    writeRun(SESSION, run("a"));
    writeRun(SESSION, run("b"));
    writeRun(SESSION, run("a", { status: "error", resultText: "" }));
    const ids = readRuns(SESSION).map((entry) => entry.id);
    expect(ids).toEqual(["a", "b"]);
    expect(readRuns(SESSION)[0].status).toBe("error");
  });

  it("caps stored runs at 20 per session, keeping the newest", () => {
    for (let i = 0; i < 25; i++) writeRun(SESSION, run(`r${i}`));
    const ids = readRuns(SESSION).map((entry) => entry.id);
    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe("r5");
    expect(ids.at(-1)).toBe("r24");
  });

  it("deletes a run by id", () => {
    writeRun(SESSION, run("a"));
    writeRun(SESSION, run("b"));
    deleteRun(SESSION, "a");
    expect(readRuns(SESSION).map((entry) => entry.id)).toEqual(["b"]);
  });

  it("tolerates corrupt stored JSON", () => {
    localStorage.setItem("picot:subagent-runs:sess-1", "{not json");
    expect(readRuns(SESSION)).toEqual([]);
  });

  it("silently no-ops when localStorage.setItem throws", () => {
    const spy = vi.spyOn(globalThis.localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => writeRun(SESSION, run("a"))).not.toThrow();
    spy.mockRestore();
    expect(readRuns(SESSION)).toEqual([]);
  });
});
