function createEmptyAssistantMessage() {
  return { role: "assistant", content: [] };
}

function cloneMessage(message) {
  if (message?.role !== "assistant") return createEmptyAssistantMessage();
  return {
    ...message,
    content: Array.isArray(message.content)
      ? structuredClone(message.content)
      : message.content || [],
  };
}

function ensureBlock(content, index, type) {
  const existing = content[index];
  if (existing?.type === type) return existing;

  const block =
    type === "thinking"
      ? { type: "thinking", thinking: "" }
      : type === "toolCall"
        ? { type: "toolCall", id: "", name: "", arguments: {} }
        : { type: "text", text: "" };
  content[index] = block;
  return block;
}

function applyDelta(message, event) {
  const delta = event?.assistantMessageEvent;
  if (!delta || !Number.isInteger(delta.contentIndex) || delta.contentIndex < 0) return message;

  const content = message.content;
  switch (delta.type) {
    case "text_start":
      ensureBlock(content, delta.contentIndex, "text");
      break;
    case "text_delta": {
      const block = ensureBlock(content, delta.contentIndex, "text");
      block.text += delta.delta ?? "";
      break;
    }
    case "text_end": {
      const block = ensureBlock(content, delta.contentIndex, "text");
      if (typeof delta.content === "string") block.text = delta.content;
      break;
    }
    case "thinking_start":
      ensureBlock(content, delta.contentIndex, "thinking");
      break;
    case "thinking_delta": {
      const block = ensureBlock(content, delta.contentIndex, "thinking");
      block.thinking += delta.delta ?? "";
      break;
    }
    case "thinking_end": {
      const block = ensureBlock(content, delta.contentIndex, "thinking");
      if (typeof delta.content === "string") block.thinking = delta.content;
      break;
    }
    case "toolcall_start":
      ensureBlock(content, delta.contentIndex, "toolCall");
      break;
    case "toolcall_end":
      if (delta.toolCall) content[delta.contentIndex] = structuredClone(delta.toolCall);
      break;
  }
  if (event.usage) message.usage = structuredClone(event.usage);
  return message;
}

/** Assemble Pi's delta-only message_update protocol into a live assistant message. */
export function createAssistantMessageStream() {
  let message = null;

  return {
    start(initialMessage) {
      message = cloneMessage(initialMessage);
      return structuredClone(message);
    },
    update(event) {
      message = applyDelta(message ?? createEmptyAssistantMessage(), event);
      return structuredClone(message);
    },
    finish(finalMessage) {
      const completed = cloneMessage(finalMessage ?? message);
      message = null;
      return completed;
    },
    reset() {
      message = null;
    },
    current() {
      return message ? structuredClone(message) : null;
    },
  };
}
