// ABOUTME: Records wall-clock spans for every turn (agent run) from runtime frames.
// ABOUTME: Pure data collection with an injectable clock; turn-analysis.js reads it.

/**
 * Turn trace recorder.
 *
 * Pi's runtime emits an ordered event stream per turn:
 *
 *   agent_start
 *     message_start/message_update/message_end   (assistant thinking + text)
 *     tool_execution_start/.../tool_execution_end (one span per tool call)
 *     compaction_start/compaction_end
 *   agent_settled | agent_end
 *
 * Those events carry no timings of their own, so the recorder stamps each one
 * as it arrives (`event.timestamp` wins when the runtime does supply one). The
 * result is a flat list of spans per turn: enough to answer "where did the
 * time go", "what failed", and "what did we do twice" without asking the model
 * anything.
 *
 * The recorder is deliberately dumb: no aggregation, no verdicts, no DOM. It
 * never drops a failure it saw, and it never invents a span it did not see -- a
 * span whose end event never arrived stays unfinished, which is exactly the
 * signal a "stuck" turn needs.
 */

const DEFAULT_MAX_TURNS = 20;
const MAX_STEPS_PER_TURN = 500;
const DETAIL_MAX_CHARS = 140;
const SIGNATURE_MAX_CHARS = 400;
const PROMPT_MAX_CHARS = 400;

/** Stable key for a runtime target: one trace timeline per agent instance. */
export function traceTargetKey(target) {
  return target?.instanceId || target?.sessionId || null;
}

function clampText(value, max) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Deterministic projection of tool args, used as a duplicate-call signature. */
function stableSignature(value, depth = 0) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    if (depth > 3) return "[...]";
    return `[${value.map((item) => stableSignature(item, depth + 1)).join(",")}]`;
  }
  if (typeof value === "object") {
    if (depth > 3) return "{...}";
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${key}:${stableSignature(value[key], depth + 1)}`)
      .join(",")}}`;
  }
  return String(value);
}

const DETAIL_KEYS = [
  "path",
  "file_path",
  "filePath",
  "command",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
];

/** Short human-facing label for a tool call (the file, the command, ...). */
export function describeToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return clampText(value, DETAIL_MAX_CHARS);
  }
  return "";
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .join("");
}

function trimmedString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.message === "string") {
    return value.message.trim();
  }
  return "";
}

function toolResultText(result) {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return textFromContent(result);
  if (result && typeof result === "object") {
    return trimmedString(result.error) || textFromContent(result.content) || "";
  }
  return "";
}

/** Failure extraction for agent_end/agent_settled, narrowed to trace needs. */
function runtimeEventError(event) {
  const direct = trimmedString(event.errorMessage) || trimmedString(event.error);
  if (direct) return direct;
  const messages = Array.isArray(event.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role && message.role !== "assistant") continue;
    if (message?.stopReason === "aborted") continue;
    const text = trimmedString(message?.errorMessage) || trimmedString(message?.error);
    if (text) return text;
    if (message?.stopReason === "error") return "model request failed";
  }
  return null;
}

function addUsage(totals, usage) {
  totals.input += Number(usage?.input) || 0;
  totals.output += Number(usage?.output) || 0;
  totals.cacheRead += Number(usage?.cacheRead) || 0;
  totals.cacheWrite += Number(usage?.cacheWrite) || 0;
  totals.cost += Number(usage?.cost?.total) || 0;
}

/**
 * @param {{ now?: () => number, maxTurns?: number }} [options]
 * @returns {{
 *   handleRuntimeFrame: (frame: object) => void,
 *   getTurns: (target: object) => Array<object>,
 *   getLastTurn: (target: object) => object | null,
 *   clear: (target?: object) => void,
 * }}
 */
export function createTurnTraceRecorder({
  now = () => Date.now(),
  maxTurns = DEFAULT_MAX_TURNS,
} = {}) {
  /** @type {Map<string, {turns: Array<object>, seq: number}>} */
  const timelines = new Map();

  function timelineFor(key) {
    let timeline = timelines.get(key);
    if (!timeline) {
      timeline = { turns: [], seq: 0 };
      timelines.set(key, timeline);
    }
    return timeline;
  }

  function stampOf(event) {
    const supplied = Number(event?.timestamp);
    return Number.isFinite(supplied) && supplied > 0 ? supplied : now();
  }

  function currentTurn(timeline) {
    const turn = timeline.turns[timeline.turns.length - 1];
    return turn && turn.status === "running" ? turn : null;
  }

  function openStep(turn, step) {
    if (!turn || turn.steps.length >= MAX_STEPS_PER_TURN) return null;
    turn.steps.push(step);
    return step;
  }

  function newStep(kind, label, at, extra = {}) {
    return {
      kind,
      label,
      detail: "",
      signature: null,
      toolCallId: null,
      startedAt: at,
      endedAt: null,
      durationMs: null,
      status: "running",
      error: null,
      stopReason: null,
      ...extra,
    };
  }

  function lastOpenStep(turn, kind, match = () => true) {
    for (let i = turn.steps.length - 1; i >= 0; i -= 1) {
      const step = turn.steps[i];
      if (step.kind === kind && step.endedAt == null && match(step)) return step;
    }
    return null;
  }

  function closeStep(step, at, { status = "ok", error = null } = {}) {
    if (!step || step.endedAt != null) return;
    step.endedAt = at;
    step.durationMs = Math.max(0, at - step.startedAt);
    step.status = status;
    step.error = error;
  }

  function closeTurn(turn, at, { status, error }) {
    if (turn?.status !== "running") return;
    for (const step of turn.steps) {
      // A span still open when the turn ends never reported its own end:
      // attribute it to the turn boundary and keep it flagged as unfinished.
      if (step.endedAt == null) closeStep(step, at, { status: "unfinished" });
    }
    turn.endedAt = at;
    turn.durationMs = Math.max(0, at - turn.startedAt);
    turn.status = status;
    turn.error = error;
  }

  function startTurn(timeline, target, at) {
    const previous = currentTurn(timeline);
    // A fresh agent_start without a settle means the previous turn's ending was
    // never observed (reconnect, process restart). Never call it a success.
    if (previous) closeTurn(previous, at, { status: "unknown", error: null });
    timeline.seq += 1;
    const turn = {
      id: `turn-${timeline.seq}`,
      index: timeline.seq,
      sessionId: target?.sessionId ?? null,
      workspaceId: target?.workspaceId ?? null,
      instanceId: target?.instanceId ?? null,
      prompt: "",
      startedAt: at,
      endedAt: null,
      durationMs: null,
      status: "running",
      error: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      steps: [],
    };
    timeline.turns.push(turn);
    while (timeline.turns.length > maxTurns) timeline.turns.shift();
    return turn;
  }

  function handleRuntimeFrame(frame) {
    if (frame?.type !== "runtime_event") return;
    const key = traceTargetKey(frame.target);
    if (!key) return;
    const event = frame.event;
    if (!event || typeof event.type !== "string") return;
    const timeline = timelineFor(key);
    const at = stampOf(event);
    const turn = event.type === "agent_start" ? null : currentTurn(timeline);

    switch (event.type) {
      case "agent_start":
        startTurn(timeline, frame.target, at);
        break;
      case "agent_settled":
      case "agent_end": {
        if (!turn) break;
        const error = runtimeEventError(event);
        const aborted = turn.steps.some((step) => step.stopReason === "aborted");
        closeTurn(turn, at, {
          status: error ? "failed" : aborted ? "aborted" : "completed",
          error,
        });
        break;
      }
      case "message_start": {
        if (!turn) break;
        if (event.message?.role === "user") {
          if (!turn.prompt) {
            turn.prompt = clampText(textFromContent(event.message.content), PROMPT_MAX_CHARS);
          }
          break;
        }
        if (event.message?.role !== "assistant") break;
        openStep(turn, newStep("model", "assistant", at));
        break;
      }
      case "message_end": {
        if (!turn || event.message?.role !== "assistant") break;
        addUsage(turn.usage, event.message.usage);
        const step = lastOpenStep(turn, "model");
        if (!step) break;
        const stopReason = event.message.stopReason ?? null;
        const error =
          stopReason === "error"
            ? trimmedString(event.message.errorMessage) ||
              trimmedString(event.message.error) ||
              "model request failed"
            : null;
        step.stopReason = stopReason;
        step.detail = clampText(textFromContent(event.message.content), DETAIL_MAX_CHARS);
        closeStep(step, at, {
          status: error ? "error" : stopReason === "aborted" ? "aborted" : "ok",
          error,
        });
        break;
      }
      case "tool_execution_start": {
        if (!turn) break;
        const toolName = String(event.toolName || "tool");
        openStep(
          turn,
          newStep("tool", toolName, at, {
            detail: describeToolArgs(event.args),
            signature: clampText(
              `${toolName}|${stableSignature(event.args ?? null)}`,
              SIGNATURE_MAX_CHARS,
            ),
            toolCallId: event.toolCallId ?? null,
          }),
        );
        break;
      }
      case "tool_execution_end": {
        if (!turn) break;
        const step = lastOpenStep(
          turn,
          "tool",
          (candidate) => event.toolCallId == null || candidate.toolCallId === event.toolCallId,
        );
        if (!step) break;
        closeStep(step, at, {
          status: event.isError ? "error" : "ok",
          error: event.isError ? clampText(toolResultText(event.result), DETAIL_MAX_CHARS) : null,
        });
        break;
      }
      case "compaction_start": {
        if (!turn) break;
        openStep(turn, newStep("compaction", "compaction", at));
        break;
      }
      case "compaction_end": {
        if (!turn) break;
        const step = lastOpenStep(turn, "compaction");
        if (!step) break;
        const error = trimmedString(event.errorMessage) || trimmedString(event.error);
        closeStep(step, at, { status: error ? "error" : "ok", error: error || null });
        break;
      }
      default:
        break;
    }
  }

  function getTurns(target) {
    const key = traceTargetKey(target);
    if (!key) return [];
    return timelines.get(key)?.turns ?? [];
  }

  return {
    handleRuntimeFrame,
    getTurns,
    getLastTurn(target) {
      const turns = getTurns(target);
      return turns.length ? turns[turns.length - 1] : null;
    },
    clear(target) {
      if (target === undefined) {
        timelines.clear();
        return;
      }
      const key = traceTargetKey(target);
      if (key) timelines.delete(key);
    },
  };
}
