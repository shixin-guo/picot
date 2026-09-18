import { describe, expect, it } from "vitest";
import { createTurnTraceRecorder, describeToolArgs, traceTargetKey } from "./turn-trace.js";

const TARGET = { workspaceId: "ws", sessionId: "s1", instanceId: "i1" };

function recorderAt(clock) {
  return createTurnTraceRecorder({ now: () => clock.value });
}

function feed(recorder, clock, event, at, target = TARGET) {
  clock.value = at;
  recorder.handleRuntimeFrame({ type: "runtime_event", target, event });
}

describe("traceTargetKey", () => {
  it("prefers the instance id and falls back to the session id", () => {
    expect(traceTargetKey({ instanceId: "i", sessionId: "s" })).toBe("i");
    expect(traceTargetKey({ sessionId: "s" })).toBe("s");
    expect(traceTargetKey({})).toBe(null);
  });
});

describe("describeToolArgs", () => {
  it("prefers a path, then a command", () => {
    expect(describeToolArgs({ path: "/a/b.js" })).toBe("/a/b.js");
    expect(describeToolArgs({ command: "bun test" })).toBe("bun test");
    expect(describeToolArgs({ unrelated: 1 })).toBe("");
    expect(describeToolArgs(null)).toBe("");
  });
});

describe("turn trace recorder", () => {
  it("records model and tool spans with wall-clock durations", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);

    feed(recorder, clock, { type: "agent_start" }, 1000);
    feed(
      recorder,
      clock,
      { type: "message_start", message: { role: "user", content: "fix the build" } },
      1000,
    );
    feed(recorder, clock, { type: "message_start", message: { role: "assistant" } }, 1100);
    feed(
      recorder,
      clock,
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      1500,
    );
    feed(recorder, clock, { type: "tool_execution_end", toolCallId: "t1", result: "ok" }, 2500);
    feed(
      recorder,
      clock,
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "end_turn",
          content: [{ type: "text", text: "done" }],
          usage: { input: 10, output: 5, cost: { total: 0.25 } },
        },
      },
      3000,
    );
    feed(recorder, clock, { type: "agent_settled" }, 3200);

    const turn = recorder.getLastTurn(TARGET);
    expect(turn.status).toBe("completed");
    expect(turn.prompt).toBe("fix the build");
    expect(turn.durationMs).toBe(2200);
    expect(turn.usage).toMatchObject({ input: 10, output: 5, cost: 0.25 });
    expect(turn.steps.map((step) => [step.kind, step.label, step.durationMs])).toEqual([
      ["model", "assistant", 1900],
      ["tool", "bash", 1000],
    ]);
    expect(turn.steps[1].signature).toContain("bash|{command:ls}");
  });

  it("marks failing tool calls and keeps the error text", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start" }, 0);
    feed(
      recorder,
      clock,
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "x" } },
      10,
    );
    feed(
      recorder,
      clock,
      { type: "tool_execution_end", toolCallId: "t1", isError: true, result: "command not found" },
      20,
    );
    feed(recorder, clock, { type: "agent_settled" }, 30);

    const turn = recorder.getLastTurn(TARGET);
    expect(turn.status).toBe("completed");
    expect(turn.steps[0]).toMatchObject({ status: "error", error: "command not found" });
  });

  it("fails the turn when the runtime reports a provider error", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start" }, 0);
    feed(recorder, clock, { type: "agent_end", errorMessage: "rate limited" }, 500);

    expect(recorder.getLastTurn(TARGET)).toMatchObject({
      status: "failed",
      error: "rate limited",
      durationMs: 500,
    });
  });

  it("marks an aborted turn from the assistant stop reason", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start" }, 0);
    feed(recorder, clock, { type: "message_start", message: { role: "assistant" } }, 10);
    feed(
      recorder,
      clock,
      { type: "message_end", message: { role: "assistant", stopReason: "aborted" } },
      20,
    );
    feed(recorder, clock, { type: "agent_settled" }, 30);

    expect(recorder.getLastTurn(TARGET).status).toBe("aborted");
  });

  it("closes spans that never reported an end and flags them unfinished", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start" }, 0);
    feed(
      recorder,
      clock,
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: {} },
      100,
    );
    feed(recorder, clock, { type: "agent_settled" }, 5000);

    const step = recorder.getLastTurn(TARGET).steps[0];
    expect(step.status).toBe("unfinished");
    expect(step.durationMs).toBe(4900);
  });

  it("never marks an unsettled turn as completed when a new turn starts", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start" }, 0);
    feed(recorder, clock, { type: "agent_start" }, 100);

    const turns = recorder.getTurns(TARGET);
    expect(turns).toHaveLength(2);
    expect(turns[0].status).toBe("unknown");
    expect(turns[1].status).toBe("running");
  });

  it("keeps one timeline per target and drops old turns past the cap", () => {
    const clock = { value: 0 };
    const recorder = createTurnTraceRecorder({ now: () => clock.value, maxTurns: 2 });
    for (const at of [0, 10, 20]) {
      feed(recorder, clock, { type: "agent_start" }, at);
      feed(recorder, clock, { type: "agent_settled" }, at + 5);
    }
    feed(recorder, clock, { type: "agent_start" }, 100, { sessionId: "other" });

    expect(recorder.getTurns(TARGET).map((turn) => turn.index)).toEqual([2, 3]);
    expect(recorder.getTurns({ sessionId: "other" })).toHaveLength(1);
  });

  it("ignores frames without a runtime target or event", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    recorder.handleRuntimeFrame({
      type: "runtime_event",
      target: {},
      event: { type: "agent_start" },
    });
    recorder.handleRuntimeFrame({ type: "other", target: TARGET, event: { type: "agent_start" } });
    expect(recorder.getTurns(TARGET)).toHaveLength(0);
  });

  it("prefers a runtime-supplied timestamp over the local clock", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start", timestamp: 1_000 }, 999_999);
    feed(recorder, clock, { type: "agent_settled", timestamp: 3_000 }, 999_999);
    expect(recorder.getLastTurn(TARGET).durationMs).toBe(2000);
  });

  it("clears a single target or everything", () => {
    const clock = { value: 0 };
    const recorder = recorderAt(clock);
    feed(recorder, clock, { type: "agent_start" }, 0);
    recorder.clear(TARGET);
    expect(recorder.getTurns(TARGET)).toHaveLength(0);
    feed(recorder, clock, { type: "agent_start" }, 0);
    recorder.clear();
    expect(recorder.getTurns(TARGET)).toHaveLength(0);
  });
});
