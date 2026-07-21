// ABOUTME: Client-side state machine for one ephemeral chat: filters sequenced
// ABOUTME: frames by instance+generation, replays after snapshot, drives the view.

const GENERIC_FAILURE = "Temporary chat is unavailable";

function clone(value) {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function assistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    return message.content
      .filter((b) => b?.type === "text")
      .map((b) => b.text || "")
      .join("\n");
  }
  return "";
}

function firstUserText(message) {
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) {
    const text = message.content.find((b) => b?.type === "text");
    if (text) return text.text || "";
  }
  return "";
}

function normalizeUserMessage(message) {
  const normalized = clone(message);
  if (!Array.isArray(normalized?.content)) return normalized;

  const blocks = normalized.content;
  normalized.content = blocks
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n");
  const images = blocks
    .filter((block) => block?.type === "image" && typeof block.data === "string")
    .map((block) => ({ data: block.data, mimeType: block.mimeType }));
  if (images.length > 0) normalized.images = images;
  return normalized;
}

/**
 * Owns one ephemeral chat's connection-facing state. It accepts only frames
 * matching its instance id + generation, replays ordered events after a
 * snapshot, and emits render/title/unread/failure events for the view.
 */
export class EphemeralChatRuntime extends EventTarget {
  constructor({ descriptor, transport }) {
    super();
    this.instanceId = descriptor?.instanceId ?? "";
    this.generation = descriptor?.generation ?? 0;
    this.kind = descriptor?.kind ?? "side-chat";
    this.transport = transport;
    this.title = descriptor?.title ?? null;
    this.unread = Boolean(descriptor?.unread);
    this.active = false;
    this.destroyed = false;
    this.mounted = false;
    this.lastAppliedSequence = 0;
    this._queue = [];
    this._pendingCommandIds = new Set();
    this._pendingRequests = new Map();

    this.messages = [];
    this.assistantDraft = null;
    this.tools = new Map();
    this.model = null;
    this.thinkingLevel = "off";
    this.isStreaming = false;
    this.contextUsage = null;
    this.error = null;
    this.cost = 0;
    this.totalTokens = 0;
    this._titleSet = Boolean(this.title);
  }

  // ── Outbound commands (owner-scoped via the authenticated transport) ────────

  sendPrompt(message, images) {
    const payload = { type: "prompt", message };
    if (images?.length) payload.images = images;
    return this._send(payload);
  }

  abort() {
    return this._send({ type: "abort" });
  }

  setModel(provider, modelId) {
    this.model = { provider, id: modelId };
    this._emitRender();
    return this._send({ type: "set_model", provider, modelId });
  }

  async getAvailableModels() {
    const response = await this._request({ type: "get_available_models" });
    return Array.isArray(response?.models) ? response.models : [];
  }

  setThinkingLevel(level) {
    this.thinkingLevel = level;
    this._emitRender();
    return this._send({ type: "set_thinking_level", level });
  }

  respondToExtensionUi(id, response) {
    return this._send({ type: "extension_ui_response", id, ...response });
  }

  runCommand(type) {
    return this._request({ type });
  }

  _send(payload) {
    if (this.destroyed) return null;
    try {
      const requestId = this.transport?.sendEphemeral?.(this.instanceId, this.generation, payload);
      if (!requestId) {
        this._emitFailure(new Error("ephemeral transport unavailable"));
        return null;
      }
      this._pendingCommandIds.add(requestId);
      if (this._pendingCommandIds.size > 64) {
        this._pendingCommandIds.delete(this._pendingCommandIds.values().next().value);
      }
      return requestId;
    } catch (err) {
      this._emitFailure(err);
      return null;
    }
  }

  _request(payload) {
    return new Promise((resolve, reject) => {
      const requestId = this._send(payload);
      if (!requestId) {
        reject(new Error("ephemeral transport unavailable"));
        return;
      }
      this._pendingRequests.set(requestId, { resolve, reject });
    });
  }

  // ── Inbound state ───────────────────────────────────────────────────────────

  /** Replace the complete render state from an authoritative snapshot. */
  applySnapshot(snapshot) {
    if (this.destroyed) return;
    if (
      !snapshot ||
      snapshot.instanceId !== this.instanceId ||
      snapshot.generation !== this.generation
    ) {
      return;
    }
    this.messages = Array.isArray(snapshot.messages)
      ? snapshot.messages.map((message) =>
          message?.role === "user" ? normalizeUserMessage(message) : clone(message),
        )
      : [];
    this.assistantDraft = snapshot.assistantDraft ? clone(snapshot.assistantDraft) : null;
    this.tools = new Map((snapshot.tools || []).map((tool) => [tool.toolCallId, { ...tool }]));
    this.model = snapshot.model ?? null;
    this.thinkingLevel = snapshot.thinkingLevel ?? "off";
    this.isStreaming = Boolean(snapshot.isStreaming);
    this.contextUsage = snapshot.contextUsage ?? null;
    this.error = snapshot.error ?? null;
    this.cost = Number(snapshot.cost) || 0;
    this.totalTokens = Number(snapshot.totalTokens) || 0;
    this.lastAppliedSequence = snapshot.runtimeSequenceWatermark ?? 0;
    this.mounted = true;
    this._drainQueue();
    this._maybeSetTitle();
    this._emitRender();
  }

  /** Apply one sequenced broker frame (ephemeral_event envelope). */
  applySequencedEvent(frame) {
    if (this.destroyed) return;
    if (!frame || frame.instanceId !== this.instanceId || frame.generation !== this.generation) {
      return;
    }
    // A snapshot response (ephemeral_snapshot_request reply) is wrapped by the
    // broker as an ephemeral_event; route it to applySnapshot, not the reducer.
    if (frame.payload?.type === "ephemeral_snapshot") {
      this.applySnapshot(frame.payload);
      return;
    }
    if (frame.payload?.type === "response") {
      this._handleCommandResponse(frame.payload);
      return;
    }
    const seq = frame.runtimeSequence ?? frame.payload?.runtimeSequence;
    if (typeof seq !== "number") return;

    if (!this.mounted) {
      this._queue.push(frame);
      return;
    }
    if (seq <= this.lastAppliedSequence) return; // duplicate / older
    if (seq > this.lastAppliedSequence + 1) {
      this._requestResnapshot();
      return;
    }
    this._reduce(frame.payload);
    this.lastAppliedSequence = seq;
    this._afterEvent();
  }

  acknowledgeVisible() {
    this.active = true;
    if (this.unread) {
      this.unread = false;
      this._emit("unreadchange", { unread: false });
    }
  }

  /** Ask the embedded runtime for a fresh authoritative snapshot (rebind path). */
  requestSnapshot() {
    return this._send({ type: "ephemeral_snapshot_request" });
  }

  handleCommandFailure(requestId) {
    if (this.destroyed || !requestId || !this._pendingCommandIds.delete(requestId)) return;
    const pending = this._pendingRequests.get(requestId);
    this._pendingRequests.delete(requestId);
    pending?.reject(new Error("ephemeral command failed"));
    this._emitFailure(new Error("ephemeral command failed"));
  }

  _handleCommandResponse(response) {
    const requestId = response?.id;
    if (!requestId) return;
    this._pendingCommandIds.delete(requestId);
    const pending = this._pendingRequests.get(requestId);
    if (!pending) return;
    this._pendingRequests.delete(requestId);
    if (response.success) {
      pending.resolve(response.data);
    } else {
      pending.reject(new Error("ephemeral command failed"));
      this._emitFailure(new Error("ephemeral command failed"));
    }
  }

  getCloseRisk() {
    return {
      instanceId: this.instanceId,
      generation: this.generation,
      kind: this.kind,
      hasMessages: this.messages.length > 0 || Boolean(this.assistantDraft),
      streaming: this.isStreaming,
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._queue = [];
    this._pendingCommandIds.clear();
    for (const pending of this._pendingRequests.values()) {
      pending.reject(new Error("ephemeral runtime destroyed"));
    }
    this._pendingRequests.clear();
    this.messages = [];
    this.assistantDraft = null;
    this.tools.clear();
    this.transport = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _drainQueue() {
    if (this._queue.length === 0) return;
    const ordered = this._queue.splice(0).sort((a, b) => a.runtimeSequence - b.runtimeSequence);
    for (const frame of ordered) {
      const seq = frame.runtimeSequence ?? frame.payload?.runtimeSequence;
      if (seq <= this.lastAppliedSequence) continue;
      if (seq > this.lastAppliedSequence + 1) {
        this._requestResnapshot();
        return;
      }
      this._reduce(frame.payload);
      this.lastAppliedSequence = seq;
    }
    this._afterEvent();
  }

  _afterEvent() {
    this._maybeSetTitle();
    // Unread when an event arrives while the view is inactive.
    if (!this.active && !this.unread && (this.isStreaming || this.messages.length > 0)) {
      this.unread = true;
      this._emit("unreadchange", { unread: true });
    }
    this._emitRender();
  }

  _maybeSetTitle() {
    if (this._titleSet || this.messages.length === 0) return;
    const firstUser = this.messages.find((message) => message?.role === "user");
    const text = firstUserText(firstUser);
    if (!text) return;
    this._titleSet = true;
    this._emit("titleprompt", { text });
  }

  _reduce(payload) {
    if (payload?.type === "extension_ui_request") {
      this._emit("extensionuirequest", { request: payload });
      return;
    }
    if (payload?.type !== "event") return;
    const event = payload.event || {};
    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (message?.role === "user") {
          this.messages.push(normalizeUserMessage(message));
        } else if (message?.role === "assistant") {
          this.assistantDraft = { text: assistantText(message), thinking: "" };
        }
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent;
        if (!this.assistantDraft) this.assistantDraft = { text: "", thinking: "" };
        if (ame?.type === "text_delta") this.assistantDraft.text += ame.delta || "";
        else if (ame?.type === "thinking") this.assistantDraft.thinking += ame.delta || "";
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message?.role === "assistant") {
          this.messages.push(clone(message));
          this.assistantDraft = null;
          if (message.stopReason === "error") {
            this.error = message.errorMessage || GENERIC_FAILURE;
            this._emit("failure", { error: this.error });
          }
          const usage = message.usage;
          if (usage) {
            const costTotal = Number(usage.cost?.total || 0);
            if (Number.isFinite(costTotal)) this.cost += costTotal;
            const tokens = Number(usage.input || 0) + Number(usage.output || 0);
            if (Number.isFinite(tokens)) this.totalTokens += tokens;
          }
        }
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId;
        if (id) {
          this.tools.set(id, {
            toolCallId: id,
            toolName: event.toolName || "",
            args: event.args,
            output: "",
            status: "pending",
          });
        }
        break;
      }
      case "tool_execution_update": {
        const tool = this.tools.get(event.toolCallId);
        if (tool) {
          tool.status = "streaming";
          tool.output += event.partialResult || "";
        }
        break;
      }
      case "tool_execution_end": {
        const tool = this.tools.get(event.toolCallId);
        if (tool) {
          tool.status = event.isError ? "error" : "complete";
          tool.output = event.result || "";
        }
        break;
      }
      case "model_select":
        this.model = clone(event.model);
        break;
      case "agent_start":
        this.isStreaming = true;
        break;
      case "agent_end":
        this.isStreaming = false;
        break;
      case "extension_ui_request":
        this._emit("extensionuirequest", { request: event });
        break;
      default:
        break;
    }
  }

  _requestResnapshot() {
    this.mounted = false;
    this._queue = [];
    this._send({ type: "ephemeral_snapshot_request" });
    this._emit("resnapshot");
  }

  _emitRender() {
    this._emit("renderstate", {
      messages: clone(this.messages),
      assistantDraft: this.assistantDraft ? clone(this.assistantDraft) : null,
      tools: Array.from(this.tools.values()).map((t) => ({ ...t })),
      model: clone(this.model),
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      contextUsage: clone(this.contextUsage),
      error: this.error,
      cost: this.cost,
      totalTokens: this.totalTokens,
    });
  }

  _emit(type, detail) {
    if (this.destroyed) return;
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _emitFailure(_err) {
    this.error = GENERIC_FAILURE;
    this._emit("failure", { error: this.error });
    this._emitRender();
  }
}
