// Per-session persistence for Claude Code (ACP) subagent runs, so a finished
// card re-renders inline after a reload or a session switch. Mirrors the
// localStorage + try/catch degradation pattern of session-ui-state.js: the
// store is a convenience, never load-bearing. When localStorage is unavailable
// (private windows, quota, thumbnailing contexts that throw on access) writes
// silently no-op and reads return []; the live run still works because the
// controller keeps its own in-memory map for the session's lifetime.

const KEY_PREFIX = "picot:subagent-runs:";
const MAX_RUNS_PER_SESSION = 20;

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function keyFor(sessionId) {
  return `${KEY_PREFIX}${sessionId}`;
}

/** All persisted runs for a session, oldest first; [] on any problem. */
export function readRuns(sessionId) {
  if (!sessionId) return [];
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(keyFor(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Insert or replace one run record (keyed by `run.id`), capped per session. */
export function writeRun(sessionId, run) {
  if (!sessionId || !run?.id) return;
  const record = {
    id: run.id,
    agentId: run.agentId ?? "claude-code",
    agentLabel: run.agentLabel ?? "Claude Code",
    taskText: run.taskText ?? "",
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
    status: run.status ?? "running",
    resultText: run.resultText ?? "",
    resultSent: Boolean(run.resultSent),
    blocks: run.state?.blocks ?? run.blocks ?? [],
  };
  const byId = new Map(readRuns(sessionId).map((entry) => [entry.id, entry]));
  byId.set(record.id, record);
  let list = [...byId.values()];
  if (list.length > MAX_RUNS_PER_SESSION) list = list.slice(list.length - MAX_RUNS_PER_SESSION);
  persist(sessionId, list);
}

export function deleteRun(sessionId, runId) {
  if (!sessionId || !runId) return;
  persist(
    sessionId,
    readRuns(sessionId).filter((entry) => entry.id !== runId),
  );
}

function persist(sessionId, list) {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(keyFor(sessionId), JSON.stringify(list));
  } catch {
    // Quota or a read-only store — nothing more we can do; the run stays live
    // in the controller's map for this window.
  }
}
