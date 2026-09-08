const EMPTY_QUEUE = Object.freeze({ steering: Object.freeze([]), followUp: Object.freeze([]) });

export function createSessionStore(target) {
  return {
    target: { ...target },
    sequence: 0,
    snapshotRequired: false,
    lifecycle: "starting",
    activeLeafId: null,
    messages: [],
    streaming: null,
    tools: [],
    queue: EMPTY_QUEUE,
    retry: null,
    compaction: null,
    dialogs: [],
    model: null,
    thinkingLevel: null,
    contextUsage: null,
    cost: 0,
  };
}

function sameTarget(left, right) {
  return (
    left.workspaceId === right?.workspaceId &&
    left.sessionId === right?.sessionId &&
    left.instanceId === right?.instanceId
  );
}

function applyRuntimeEvent(state, event) {
  switch (event.type) {
    case "agent_start":
      return { ...state, lifecycle: "working" };
    case "agent_settled":
    case "agent_end":
      return { ...state, lifecycle: "idle" };
    case "queue_update":
      return {
        ...state,
        queue: {
          steering: [...(event.steering ?? [])],
          followUp: [...(event.followUp ?? [])],
        },
      };
    case "compaction_start":
      return { ...state, compaction: { status: "running" } };
    case "compaction_end":
      return { ...state, compaction: { status: "completed", result: event.result ?? null } };
    case "auto_retry_start":
      return { ...state, retry: { status: "waiting", ...event } };
    case "auto_retry_end":
      return { ...state, retry: { status: "completed", ...event } };
    case "extension_ui_request":
      return { ...state, dialogs: [...state.dialogs, event] };
    default:
      return state;
  }
}

export function reduceSessionState(state, action) {
  if (!sameTarget(state.target, action.target)) return state;
  if (action.type === "runtime_snapshot") {
    return {
      ...state,
      ...structuredClone(action.state),
      target: state.target,
      sequence: action.sequence,
      snapshotRequired: false,
    };
  }
  if (action.type !== "runtime_event") return state;
  if (action.sequence <= state.sequence) return state;
  if (action.sequence !== state.sequence + 1) {
    return state.snapshotRequired ? state : { ...state, snapshotRequired: true };
  }
  return {
    ...applyRuntimeEvent(state, action.event),
    sequence: action.sequence,
    snapshotRequired: false,
  };
}
