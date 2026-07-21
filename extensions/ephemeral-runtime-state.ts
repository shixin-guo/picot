// ABOUTME: Serialized reducer for one ephemeral chat's render state: messages,
// ABOUTME: streaming assistant/tool content, model state, and authoritative snapshots.

export interface EphemeralToolState {
  toolCallId: string;
  toolName: string;
  args: unknown;
  output: string;
  status: "pending" | "streaming" | "complete" | "error";
}

export interface EphemeralSnapshot {
  type: "ephemeral_snapshot";
  instanceId: string;
  generation: number;
  runtimeSequenceWatermark: number;
  messages: unknown[];
  assistantDraft: { text: string; thinking: string } | null;
  tools: EphemeralToolState[];
  model: unknown;
  thinkingLevel: string;
  isStreaming: boolean;
  contextUsage: unknown;
  error: string | null;
  cost: number;
  totalTokens: number;
}

type Event = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function assistantText(message: unknown): string {
  if (typeof message === "object" && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .filter(
          (b): b is { type: string; text?: string } =>
            typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
        )
        .map((b) => asString(b.text))
        .join("\n");
    }
  }
  return "";
}

function clone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

export class EphemeralRuntimeState {
  private readonly instanceId: string;
  private readonly generation: number;
  private sequence = 0;
  private messages: unknown[] = [];
  private assistantText = "";
  private assistantThinking = "";
  private assistantActive = false;
  private tools = new Map<string, EphemeralToolState>();
  private error: string | null = null;
  private cost = 0;
  private totalTokens = 0;
  constructor(opts: { instanceId: string; generation: number }) {
    this.instanceId = opts.instanceId;
    this.generation = opts.generation;
  }

  /** Fold one render-relevant Pi event into state, advancing the sequence. */
  applyEvent(event: Event): { runtimeSequence: number; event: Event } {
    this.sequence += 1;
    this.reduce(event);
    return { runtimeSequence: this.sequence, event };
  }

  /** Update non-event context (model, thinking level, usage) from the host. */
  setContextState(
    state: Partial<{
      model: unknown;
      thinkingLevel: string;
      contextUsage: unknown;
      error: string | null;
    }>,
  ): void {
    if (state.model !== undefined) this.model = state.model;
    if (state.thinkingLevel !== undefined) this.thinkingLevel = state.thinkingLevel;
    if (state.contextUsage !== undefined) this.contextUsage = state.contextUsage;
    if (state.error !== undefined) this.error = state.error;
  }

  /** Authoritative render snapshot at the current sequence watermark. */
  snapshot(): EphemeralSnapshot {
    const draft =
      this.assistantActive && (this.assistantText !== "" || this.assistantThinking !== "")
        ? { text: this.assistantText, thinking: this.assistantThinking }
        : null;
    return {
      type: "ephemeral_snapshot",
      instanceId: this.instanceId,
      generation: this.generation,
      runtimeSequenceWatermark: this.sequence,
      messages: clone(this.messages),
      assistantDraft: draft ? clone(draft) : null,
      tools: Array.from(this.tools.values()).map((t) => ({ ...t })),
      model: clone(this.model),
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      contextUsage: clone(this.contextUsage),
      error: this.error,
      cost: this.cost,
      totalTokens: this.totalTokens,
    };
  }

  private reduce(event: Event): void {
    const type = asString(event.type);
    switch (type) {
      case "message_start": {
        const message = event.message;
        const role = (message as { role?: string } | undefined)?.role;
        if (role === "user") {
          this.messages.push(clone(message));
        } else if (role === "assistant") {
          this.assistantActive = true;
          this.assistantText = assistantText(message);
          this.assistantThinking = "";
        }
        break;
      }
      case "message_update": {
        const ame = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
        if (ame?.type === "text_delta" && this.assistantActive) {
          this.assistantText += asString(ame.delta);
        } else if (ame?.type === "thinking" && this.assistantActive) {
          this.assistantThinking += asString(ame.delta);
        }
        break;
      }
      case "message_end": {
        const message = event.message as
          | {
              role?: string;
              stopReason?: string;
              errorMessage?: string;
              usage?: {
                cost?: { total?: number };
                input?: number;
                output?: number;
              };
            }
          | undefined;
        if (message?.role === "assistant") {
          this.messages.push(clone(event.message));
          this.assistantActive = false;
          this.assistantText = "";
          this.assistantThinking = "";
          if (message.stopReason === "error") {
            this.error = asString(message.errorMessage) || "Assistant request failed";
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
        const toolCallId = asString(event.toolCallId);
        if (toolCallId) {
          this.tools.set(toolCallId, {
            toolCallId,
            toolName: asString(event.toolName),
            args: event.args,
            output: "",
            status: "pending",
          });
        }
        break;
      }
      case "tool_execution_update": {
        const toolCallId = asString(event.toolCallId);
        const tool = this.tools.get(toolCallId);
        if (tool) {
          tool.status = "streaming";
          tool.output += asString(event.partialResult);
        }
        break;
      }
      case "tool_execution_end": {
        const toolCallId = asString(event.toolCallId);
        const tool = this.tools.get(toolCallId);
        if (tool) {
          tool.status = event.isError ? "error" : "complete";
          tool.output = asString(event.result);
        }
        break;
      }
      case "model_select": {
        this.model = clone(event.model);
        break;
      }
      case "agent_start": {
        this.isStreaming = true;
        break;
      }
      case "agent_end": {
        this.isStreaming = false;
        break;
      }
      default:
        break;
    }
  }
}
