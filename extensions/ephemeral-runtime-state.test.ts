// @vitest-environment node

// ABOUTME: Verifies the ephemeral runtime state reducer: sequence ordering,
// ABOUTME: message/tool streaming, snapshot watermarking, and no persistence.

import { describe, expect, it } from "vitest";
import { parseEphemeralEnv } from "./embedded-server.ts";
import { EphemeralRuntimeState } from "./ephemeral-runtime-state.ts";

function makeState() {
  return new EphemeralRuntimeState({ instanceId: "inst-1", generation: 3 });
}

function userStart(text: string) {
  return { type: "message_start", message: { role: "user", content: text } };
}

function assistantStart() {
  return { type: "message_start", message: { role: "assistant", content: "" } };
}

function textDelta(delta: string) {
  return {
    type: "message_update",
    message: { role: "assistant", content: "" },
    assistantMessageEvent: { type: "text_delta", delta },
  };
}

function thinkingDelta(delta: string) {
  return {
    type: "message_update",
    message: { role: "assistant", content: "" },
    assistantMessageEvent: { type: "thinking", delta },
  };
}

function assistantEnd(usage = null, stopReason = "stop") {
  return {
    type: "message_end",
    message: { role: "assistant", content: "final", usage, stopReason },
  };
}

function toolStart(toolCallId: string, toolName: string, args: unknown) {
  return { type: "tool_execution_start", toolCallId, toolName, args };
}

function toolUpdate(toolCallId: string, partialResult: string) {
  return { type: "tool_execution_update", toolCallId, partialResult };
}

function toolEnd(toolCallId: string, result: string, isError = false) {
  return { type: "tool_execution_end", toolCallId, result, isError };
}

describe("EphemeralRuntimeState sequence", () => {
  it("increments runtimeSequence strictly per event", () => {
    const state = makeState();
    expect(state.applyEvent(userStart("hi")).runtimeSequence).toBe(1);
    expect(state.applyEvent(assistantStart()).runtimeSequence).toBe(2);
    expect(state.applyEvent(textDelta("a")).runtimeSequence).toBe(3);
  });

  it("passes the original event through unchanged", () => {
    const state = makeState();
    const event = userStart("hi");
    const result = state.applyEvent(event);
    expect(result.event).toBe(event);
  });
});

describe("EphemeralRuntimeState messages", () => {
  it("records a finalized user message", () => {
    const state = makeState();
    state.applyEvent(userStart("hello world"));
    expect(state.snapshot().messages).toHaveLength(1);
  });

  it("accumulates assistant text and thinking into a draft, then finalizes on end", () => {
    const state = makeState();
    state.applyEvent(userStart("q"));
    state.applyEvent(assistantStart());
    state.applyEvent(textDelta("Hel"));
    state.applyEvent(textDelta("lo"));
    state.applyEvent(thinkingDelta("reasoning"));

    const streaming = state.snapshot();
    expect(streaming.assistantDraft).toEqual({ text: "Hello", thinking: "reasoning" });

    state.applyEvent(assistantEnd({ cost: { total: 0.01 }, input: 100 }, "stop"));
    const finalized = state.snapshot();
    expect(finalized.assistantDraft).toBeNull();
    expect(finalized.messages).toHaveLength(2);
  });

  it("captures an error state when the assistant message ends with stopReason error", () => {
    const state = makeState();
    state.applyEvent(assistantStart());
    state.applyEvent(assistantEnd(null, "error"));
    expect(state.snapshot().error).not.toBeNull();
  });
});

describe("EphemeralRuntimeState tools", () => {
  it("transitions a tool through pending -> streaming -> complete with a stable id", () => {
    const state = makeState();
    state.applyEvent(toolStart("tc1", "bash", { cmd: "ls" }));
    state.applyEvent(toolUpdate("tc1", "partial"));
    state.applyEvent(toolEnd("tc1", "done"));
    const snap = state.snapshot();
    expect(snap.tools).toHaveLength(1);
    expect(snap.tools[0]).toMatchObject({
      toolCallId: "tc1",
      toolName: "bash",
      status: "complete",
      output: "done",
    });
  });

  it("keeps tool state isolated by toolCallId", () => {
    const state = makeState();
    state.applyEvent(toolStart("tc1", "bash", {}));
    state.applyEvent(toolStart("tc2", "read", {}));
    state.applyEvent(toolEnd("tc1", "r1"));
    expect(state.snapshot().tools).toHaveLength(2);
  });
});

describe("EphemeralRuntimeState snapshot", () => {
  it("watermark equals the last applied sequence", () => {
    const state = makeState();
    state.applyEvent(userStart("a"));
    state.applyEvent(assistantStart());
    expect(state.snapshot().runtimeSequenceWatermark).toBe(2);
  });

  it("returns a deep copy unaffected by later mutation", () => {
    const state = makeState();
    state.applyEvent(userStart("first"));
    const before = state.snapshot();
    state.applyEvent(userStart("second"));
    expect(before.messages).toHaveLength(1);
    expect(state.snapshot().messages).toHaveLength(2);
  });

  it("never exposes persistence or session-file fields", () => {
    const state = makeState();
    state.applyEvent(userStart("x"));
    const serialized = JSON.stringify(state.snapshot());
    expect(serialized).not.toContain("sessionFile");
    expect(serialized).not.toContain("sessionId");
    expect(serialized).not.toContain("sessionPath");
  });

  it("projects context state set externally", () => {
    const state = makeState();
    state.setContextState({
      model: { id: "m1" },
      thinkingLevel: "high",
      contextUsage: { used: 10 },
    });
    const snap = state.snapshot();
    expect(snap.model).toEqual({ id: "m1" });
    expect(snap.thinkingLevel).toBe("high");
    expect(snap.contextUsage).toEqual({ used: 10 });
  });

  it("reflects streaming state from agent_start/agent_end", () => {
    const state = makeState();
    state.applyEvent({ type: "agent_start" });
    expect(state.snapshot().isStreaming).toBe(true);
    state.applyEvent({ type: "agent_end" });
    expect(state.snapshot().isStreaming).toBe(false);
  });

  it("accumulates cost and tokens from assistant message_end usage", () => {
    const state = makeState();
    state.applyEvent(assistantStart());
    state.applyEvent(assistantEnd({ cost: { total: 0.01 }, input: 100, output: 50 }));
    state.applyEvent(assistantStart());
    state.applyEvent(assistantEnd({ cost: { total: 0.02 }, input: 200, output: 80 }));
    const snap = state.snapshot();
    expect(snap.cost).toBeCloseTo(0.03);
    expect(snap.totalTokens).toBe(430);
  });

  it("snapshot includes cost and totalTokens fields", () => {
    const state = makeState();
    const snap = state.snapshot();
    expect(snap).toHaveProperty("cost", 0);
    expect(snap).toHaveProperty("totalTokens", 0);
  });
});

describe("parseEphemeralEnv", () => {
  it("returns null without a recognized ephemeral kind marker", () => {
    expect(parseEphemeralEnv({})).toBeNull();
    expect(parseEphemeralEnv({ PI_STUDIO_EPHEMERAL_KIND: "bogus" })).toBeNull();
  });

  it("parses a valid side-chat marker set", () => {
    expect(
      parseEphemeralEnv({
        PI_STUDIO_EPHEMERAL_KIND: "side-chat",
        PI_STUDIO_EPHEMERAL_INSTANCE_ID: "inst-9",
        PI_STUDIO_EPHEMERAL_GENERATION: "4",
      }),
    ).toEqual({ kind: "side-chat", instanceId: "inst-9", generation: 4 });
  });

  it("requires a non-empty instance id", () => {
    expect(parseEphemeralEnv({ PI_STUDIO_EPHEMERAL_KIND: "quick-chat" })).toBeNull();
  });
});
