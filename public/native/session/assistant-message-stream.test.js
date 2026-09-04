import { describe, expect, it } from "vitest";
import { createAssistantMessageStream } from "./assistant-message-stream.js";

describe("assistant message stream", () => {
  it("assembles delta-only message_update events without a message snapshot", () => {
    const stream = createAssistantMessageStream();

    stream.start({ role: "assistant", content: [], timestamp: 1 });
    const started = stream.update({
      type: "message_update",
      usage: { output: 1 },
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    const updated = stream.update({
      type: "message_update",
      usage: { output: 2 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    });

    expect(started).toMatchObject({ role: "assistant", content: [{ type: "text", text: "" }] });
    expect(updated).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Hello" }],
      usage: { output: 2 },
    });
  });

  it("recovers when message_update arrives before message_start", () => {
    const stream = createAssistantMessageStream();

    const message = stream.update({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking" },
    });

    expect(message).toEqual({
      role: "assistant",
      content: [{ type: "thinking", thinking: "Checking" }],
    });
  });

  it("uses message_end as the authoritative final snapshot", () => {
    const stream = createAssistantMessageStream();
    stream.update({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial" },
    });

    const finalMessage = { role: "assistant", content: [{ type: "text", text: "final" }] };
    expect(stream.finish(finalMessage)).toEqual(finalMessage);
    expect(stream.current()).toBeNull();
  });
});
