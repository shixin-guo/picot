// Pure reducer turning ACP `session/update` notifications (forwarded by the
// host as `acp_session_update` runtime events, see acp_manager.rs) into a
// flat block list the subagent card renders. Kept separate from
// message-renderer.js/tool-card.js: those are shaped around Pi/Anthropic's
// own message-content schema, not ACP's `ContentBlock`/`ToolCall` schema.

export function createAcpState() {
  return { blocks: [], permissionRequests: [], error: null };
}

export function reduceAcpEvent(state, event) {
  switch (event?.type) {
    case "acp_session_update":
      return applySessionUpdate(state, event.params?.update ?? {});
    case "acp_permission_request":
      return {
        ...state,
        permissionRequests: [
          ...state.permissionRequests,
          { requestId: event.requestId, params: event.params ?? {} },
        ],
      };
    case "acp_error":
      return { ...state, error: event.message ?? "ACP agent error" };
    default:
      return state;
  }
}

/**
 * Appends the local user's prompt as a block so the ACP panel echoes what was
 * sent — `session/update` notifications only ever carry the agent's side of the
 * turn, so without this the panel shows nothing until the agent replies.
 */
export function appendUserPrompt(state, text) {
  const trimmed = typeof text === "string" ? text : "";
  if (!trimmed) return state;
  return { ...state, blocks: [...state.blocks, { kind: "user", text: trimmed }] };
}

/**
 * The agent's final answer text — the last run of `message` blocks concatenated.
 * Used as the payload for the card's "Send result to Pi" action and as the
 * persisted `resultText`.
 */
export function finalAgentText(state) {
  const messages = (state?.blocks ?? []).filter((block) => block.kind === "message");
  if (messages.length === 0) return "";
  // Walk back over the trailing contiguous message blocks so a reply split
  // across several `messageId`s is rejoined, but earlier commentary isn't.
  const tail = [];
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const block = state.blocks[i];
    if (block.kind === "message") tail.unshift(block.text);
    else if (block.kind === "tool_call" || block.kind === "user") break;
  }
  return (tail.length > 0 ? tail : messages.map((block) => block.text)).join("").trim();
}

export function resolvePermissionRequest(state, requestId) {
  return {
    ...state,
    permissionRequests: state.permissionRequests.filter(
      (request) => request.requestId !== requestId,
    ),
  };
}

function applySessionUpdate(state, update) {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return appendTextBlock(state, "message", update.content, update.messageId);
    case "agent_thought_chunk":
      return appendTextBlock(state, "thought", update.content, update.messageId);
    case "tool_call":
    case "tool_call_update":
      return upsertToolCall(state, update);
    case "plan":
      return {
        ...state,
        blocks: [...state.blocks, { kind: "plan", entries: update.entries ?? [] }],
      };
    default:
      return state;
  }
}

function appendTextBlock(state, kind, content, blockId) {
  const text = content?.type === "text" ? content.text : "";
  if (!text) return state;
  const blocks = state.blocks.slice();
  const last = blocks[blocks.length - 1];
  if (last && last.kind === kind && last.blockId === blockId) {
    blocks[blocks.length - 1] = { ...last, text: last.text + text };
    return { ...state, blocks };
  }
  blocks.push({ kind, blockId, text });
  return { ...state, blocks };
}

function upsertToolCall(state, update) {
  const id = update.toolCallId;
  if (!id) return state;
  const blocks = state.blocks.slice();
  const index = blocks.findIndex((block) => block.kind === "tool_call" && block.toolCallId === id);
  const existing =
    index >= 0 ? blocks[index] : { kind: "tool_call", toolCallId: id, status: "pending" };
  const next = {
    ...existing,
    title: update.title ?? existing.title,
    status: update.status ?? existing.status,
    content: update.content ?? existing.content,
    // Carried so the card can render a Picot-style tool card: `toolKind` picks
    // the label, `rawInput` feeds the args preview / Edit diff, `locations` the
    // file reference.
    toolKind: update.kind ?? existing.toolKind,
    rawInput: update.rawInput ?? existing.rawInput,
    locations: update.locations ?? existing.locations,
  };
  if (index >= 0) blocks[index] = next;
  else blocks.push(next);
  return { ...state, blocks };
}
