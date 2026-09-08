import { describe, expect, it } from "vitest";
import {
  appendUserPrompt,
  createAcpState,
  reduceAcpEvent,
  resolvePermissionRequest,
} from "./acp-store.js";

function sessionUpdate(update) {
  return { type: "acp_session_update", params: { update } };
}

describe("acp-store", () => {
  it("accumulates streamed message chunks sharing a messageId into one block", () => {
    let state = createAcpState();
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "P" },
      }),
    );
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "ONG" },
      }),
    );
    expect(state.blocks).toEqual([{ kind: "message", blockId: "msg-1", text: "PONG" }]);
  });

  it("starts a new block when the messageId changes", () => {
    let state = createAcpState();
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-1",
        content: { type: "text", text: "first" },
      }),
    );
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-2",
        content: { type: "text", text: "second" },
      }),
    );
    expect(state.blocks).toHaveLength(2);
    expect(state.blocks[1]).toEqual({ kind: "message", blockId: "msg-2", text: "second" });
  });

  it("keeps thought chunks in a separate block stream from message chunks", () => {
    let state = createAcpState();
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "agent_thought_chunk",
        messageId: "t-1",
        content: { type: "text", text: "thinking..." },
      }),
    );
    expect(state.blocks).toEqual([{ kind: "thought", blockId: "t-1", text: "thinking..." }]);
  });

  it("upserts a tool call by id across tool_call and tool_call_update", () => {
    let state = createAcpState();
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Read file",
        status: "pending",
      }),
    );
    state = reduceAcpEvent(
      state,
      sessionUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-1",
        status: "completed",
      }),
    );
    expect(state.blocks).toEqual([
      {
        kind: "tool_call",
        toolCallId: "call-1",
        title: "Read file",
        status: "completed",
        content: undefined,
      },
    ]);
  });

  it("tracks and resolves permission requests", () => {
    let state = createAcpState();
    state = reduceAcpEvent(state, {
      type: "acp_permission_request",
      requestId: "perm-1",
      params: { toolCall: { title: "Run bash" } },
    });
    expect(state.permissionRequests).toHaveLength(1);
    state = resolvePermissionRequest(state, "perm-1");
    expect(state.permissionRequests).toHaveLength(0);
  });

  it("echoes the local user's prompt as a block", () => {
    let state = createAcpState();
    state = appendUserPrompt(state, "hello agent");
    expect(state.blocks).toEqual([{ kind: "user", text: "hello agent" }]);
  });

  it("ignores an empty user prompt", () => {
    const state = createAcpState();
    expect(appendUserPrompt(state, "")).toBe(state);
  });

  it("records an acp_error message", () => {
    let state = createAcpState();
    state = reduceAcpEvent(state, { type: "acp_error", message: "boom" });
    expect(state.error).toBe("boom");
  });
});
