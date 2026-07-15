export const ACTIVE_TASK_STATUSES = new Set(["running", "needs_input", "blocked"]);

const DEFAULT_SOURCE = {
  channel: "local",
  conversationId: null,
  userId: null,
  messageId: null,
};

const DEFAULT_RESULT = {
  status: null,
  summary: null,
  completedAt: null,
  failReason: null,
};

const DEFAULT_DISPATCH = {
  targetProject: null,
  superAgentPort: null,
  childPort: null,
  startedAt: null,
  finishedAt: null,
};

export function normalizeSuperAgentTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => normalizeSuperAgentTask(task));
}

export function normalizeSuperAgentTask(task) {
  const source = { ...DEFAULT_SOURCE, ...(task?.source || {}) };
  const result = {
    ...DEFAULT_RESULT,
    ...(task?.result || {}),
    failReason: task?.result?.failReason ?? task?.failReason ?? null,
  };
  const dispatch = {
    ...DEFAULT_DISPATCH,
    ...(task?.dispatch || {}),
    targetProject: task?.dispatch?.targetProject ?? task?.targetProject ?? null,
  };

  return {
    ...task,
    id: task?.id || `task-${Date.now()}`,
    status: task?.status || "pending",
    source,
    result,
    dispatch,
    targetProject: task?.targetProject ?? dispatch.targetProject,
    events: Array.isArray(task?.events) ? task.events : [],
  };
}

export function markTaskForDispatch(task, { superAgentPort = null, childPort = null, now } = {}) {
  const timestamp = now || new Date().toISOString();
  const normalized = normalizeSuperAgentTask(task);
  return {
    ...normalized,
    status: "running",
    result: { ...DEFAULT_RESULT },
    dispatch: {
      ...normalized.dispatch,
      targetProject: normalized.targetProject || normalized.dispatch.targetProject,
      superAgentPort,
      childPort,
      startedAt: normalized.dispatch.startedAt || timestamp,
      finishedAt: null,
    },
    events: [
      ...normalized.events,
      {
        at: timestamp,
        type: "dispatched",
        status: "running",
        message: childPort
          ? `Dispatched to project agent on port ${childPort}.`
          : "Marked ready for project-agent dispatch.",
      },
    ],
  };
}

export function markTaskEdited(task, updates = {}, { now } = {}) {
  const timestamp = now || new Date().toISOString();
  const normalized = normalizeSuperAgentTask(task);
  const targetProject = updates.targetProject ?? normalized.targetProject;
  return {
    ...normalized,
    ...updates,
    targetProject,
    dispatch: {
      ...normalized.dispatch,
      targetProject,
    },
    events: [
      ...normalized.events,
      {
        at: timestamp,
        type: "edited",
        status: normalized.status,
        message: "Task draft edited in Picot Runtime panel.",
      },
    ],
  };
}

export function markTaskNeedsInput(task, { question, now } = {}) {
  const timestamp = now || new Date().toISOString();
  const normalized = normalizeSuperAgentTask(task);
  const message = String(question || "").trim() || "More information is needed.";
  return {
    ...normalized,
    status: "needs_input",
    result: {
      ...normalized.result,
      status: "needs_input",
      failReason: message,
    },
    failReason: message,
    events: [
      ...normalized.events,
      {
        at: timestamp,
        type: "needs_input",
        status: "needs_input",
        message,
      },
    ],
  };
}

export function markTaskFinished(
  task,
  { status = "done", summary = null, failReason = null, now } = {},
) {
  const timestamp = now || new Date().toISOString();
  const normalized = normalizeSuperAgentTask(task);
  const nextStatus = status || "done";
  const nextFailReason = failReason ?? normalized.result.failReason;
  return {
    ...normalized,
    status: nextStatus,
    failReason: nextFailReason,
    result: {
      status: nextStatus,
      summary,
      completedAt: timestamp,
      failReason: nextFailReason,
    },
    dispatch: {
      ...normalized.dispatch,
      finishedAt: timestamp,
    },
    events: [
      ...normalized.events,
      {
        at: timestamp,
        type: eventTypeForStatus(nextStatus),
        status: nextStatus,
        message: summary || nextFailReason || `Task marked ${nextStatus}.`,
      },
    ],
  };
}

export function buildProjectAgentPrompt(task) {
  const normalized = normalizeSuperAgentTask(task);
  const lines = [`Task ID: ${normalized.id}`, `Title: ${normalized.title || "(untitled)"}`];
  const sourceLabel = formatSourceLabel(normalized.source);
  if (sourceLabel) lines.push(`Source: ${sourceLabel}`);
  if (normalized.description) lines.push("", normalized.description);
  lines.push(
    "",
    "If you need clarification, stop and report the question clearly so the Super Agent can ask the original user before continuing.",
    "When finished, summarize the outcome, files changed, verification run, and any remaining risk.",
  );
  return lines.join("\n");
}

export function buildTaskComposerPrompt(task) {
  const normalized = normalizeSuperAgentTask(task);
  const replyTarget = formatReplyTarget(normalized.source);
  const lines = [
    "[Task context — keep this task bound]",
    `Task ID: ${normalized.id}`,
    `Status: ${normalized.status}`,
    `Title: ${normalized.title || "(untitled)"}`,
  ];
  if (normalized.description) lines.push(`Description: ${normalized.description}`);
  if (normalized.targetProject) lines.push(`Target project: ${normalized.targetProject}`);
  if (replyTarget) lines.push(`Source: ${replyTarget}`);
  lines.push(
    "",
    "Use this task ID as the authoritative target. Apply requested task edits without dropping existing fields. If clarification is requested, mark the task needs_input and use the source binding to ask the original user.",
    "",
    "User instruction:",
  );
  return lines.join("\n");
}

export function buildSuperAgentNotificationPrompt(task, { status, summary, failReason } = {}) {
  const normalized = normalizeSuperAgentTask(task);
  const nextStatus = status || normalized.status;
  const replyTarget = formatReplyTarget(normalized.source);
  const lines = [
    `Task ${nextStatus}: "${normalized.title || "(untitled)"}"`,
    `Task ID: ${normalized.id}`,
  ];
  if (replyTarget) lines.push(`Reply target: ${replyTarget}`);
  if (summary) lines.push(`Summary: ${summary}`);
  if (failReason) lines.push(`Reason: ${failReason}`);
  lines.push("Use the source binding above when replying to the original user.");
  return lines.join("\n");
}

function eventTypeForStatus(status) {
  if (status === "done") return "completed";
  if (status === "failed") return "failed";
  if (status === "needs_input") return "needs_input";
  if (status === "blocked") return "blocked";
  return "status_changed";
}

function formatReplyTarget(source) {
  if (!source?.channel || source.channel === "local") return null;
  return [source.channel, source.conversationId].filter(Boolean).join("/");
}

function formatSourceLabel(source) {
  if (!source?.channel) return null;
  const parts = [source.channel];
  if (source.conversationId) parts.push(`conversation ${source.conversationId}`);
  if (source.userId) parts.push(`user ${source.userId}`);
  if (source.messageId) parts.push(`message ${source.messageId}`);
  return parts.join(" · ");
}
