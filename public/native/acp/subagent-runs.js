// Controller for external ACP subagent runs (Claude Code, Codex, Cursor). A run
// is a scoped, one-shot delegation: the host spawns a throwaway ACP task runtime
// (`acp_task_start`), this module drives it with a single `acp_prompt`, folds
// the streamed `acp_session_update` events into a card in the Pi message list,
// and retires the runtime (`acp_task_stop`) once the prompt settles. The
// session's Pi backend is never touched.

import { createAcpState, finalAgentText, reduceAcpEvent, resolvePermissionRequest } from "./acp-store.js";
import { readRuns, writeRun } from "./subagent-store.js";

// The card pulls in the Markdown renderer, ToolCardRenderer and icon set —
// none of which the Pi session needs until a subagent actually runs. Load it on
// first use so app.js startup stays lean.
let cardModulePromise = null;
function loadCardModule() {
  if (!cardModulePromise) cardModulePromise = import("./subagent-card.js");
  return cardModulePromise;
}

const RUN_EVENT_TYPES = new Set(["acp_session_update", "acp_permission_request", "acp_error"]);

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function buildResultPrompt(run) {
  const label = run.agentLabel || "the";
  return `Result from the ${label} subagent for the task:\n\n> ${run.taskText}\n\n---\n\n${run.resultText}`;
}

const DEFAULT_AGENT = { id: "claude-code", label: "Claude Code" };

/**
 * @param {object} deps
 * @param {{ request: Function }} deps.runtime  runtime gateway (for acp_prompt / acp_permission_response)
 * @param {{ startAcpTask: Function, stopAcpTask: Function }} deps.control  host control gateway
 * @param {() => {workspaceId:string, sessionId:string}} deps.getTarget  the live Pi session target
 * @param {{ subscribeTarget: Function }} deps.adapter  runtime socket adapter
 * @param {(element: HTMLElement) => void} deps.mount  insert a freshly built card into #messages
 * @param {(text: string) => void} deps.sendToPi  post a prompt to the Pi session
 * @param {(error: Error) => void} [deps.onError]
 */
export function createSubagentRunManager({
  runtime,
  control,
  getTarget,
  adapter,
  mount,
  sendToPi,
  onError = () => {},
}) {
  // Keyed by the task runtime's instanceId (what runtime events carry).
  const runsByInstance = new Map();

  function persist(run) {
    try {
      writeRun(run.sessionId, run);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function attachCard(run) {
    const { createSubagentCard } = await loadCardModule();
    // A card may already have been attached for this run (e.g. restore() racing
    // a slow module load); keep the first.
    if (run.card) {
      mount(run.card.element);
      return run.card;
    }
    const card = createSubagentCard({
      run,
      onSendResult: (settled) => {
        settled.resultSent = true;
        persist(settled);
        try {
          sendToPi(buildResultPrompt(settled));
        } catch (error) {
          onError(error instanceof Error ? error : new Error(String(error)));
        }
      },
      onRespondPermission: (requestId, optionId) => {
        runtime
          .request({ type: "acp_permission_response", requestId, optionId }, run.target, {
            idempotencyKey: randomId(),
          })
          .catch(onError);
        run.state = resolvePermissionRequest(run.state, requestId);
        card.update(run);
        persist(run);
      },
    });
    run.card = card;
    mount(card.element);
    return card;
  }

  async function start(taskText, agent = DEFAULT_AGENT) {
    const task = String(taskText ?? "").trim();
    if (!task) return null;
    const pi = getTarget();
    let taskTarget;
    try {
      taskTarget = await control.startAcpTask(pi.workspaceId, pi.sessionId, agent.id);
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return null;
    }

    const run = {
      id: randomId(),
      sessionId: pi.sessionId,
      agentId: agent.id,
      agentLabel: agent.label,
      taskText: task,
      target: taskTarget,
      state: createAcpState(),
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      resultText: "",
      resultSent: false,
      expanded: true,
    };
    runsByInstance.set(taskTarget.instanceId, run);
    adapter.subscribeTarget?.(taskTarget);
    await attachCard(run);
    persist(run);

    try {
      await runtime.request({ type: "acp_prompt", message: task, images: [] }, taskTarget, {
        idempotencyKey: randomId(),
      });
      run.status = "done";
    } catch (error) {
      run.status = "error";
      if (!run.state.error) {
        run.state = reduceAcpEvent(run.state, {
          type: "acp_error",
          message: error?.message || String(error),
        });
      }
    }
    run.finishedAt = new Date().toISOString();
    run.resultText = finalAgentText(run.state);
    run.card?.update(run);
    persist(run);
    control.stopAcpTask(run.target).catch(() => {});
    return run;
  }

  /** Fold a background runtime frame into its run's card. Returns true if consumed. */
  function applyEvent(frame) {
    const run = runsByInstance.get(frame?.target?.instanceId);
    if (!run) return false;
    if (RUN_EVENT_TYPES.has(frame.event?.type)) {
      run.state = reduceAcpEvent(run.state, frame.event);
      run.card?.update(run);
      persist(run);
    }
    return true;
  }

  // Cards rebuilt from persisted records on the last restore() — destroyed
  // before the next rebuild so their ToolCardRenderer locale subscriptions
  // don't accumulate across session switches.
  let rebuiltCards = [];

  /**
   * Re-attach this session's subagent cards after a `renderHistory()` wiped the
   * message list. Live (still-streaming) runs keep their existing card element
   * so the controller's `update()` calls stay connected; finished runs are
   * rebuilt read-only from the persisted record. Oldest first.
   */
  async function restore(sessionId) {
    for (const card of rebuiltCards) card.destroy?.();
    rebuiltCards = [];

    const liveById = new Map();
    for (const run of runsByInstance.values()) {
      if (run.sessionId === sessionId && run.card) liveById.set(run.id, run);
    }
    const records = readRuns(sessionId);
    if (records.length === 0) return;
    for (const record of records) {
      const live = liveById.get(record.id);
      if (live) {
        mount(live.card.element);
        continue;
      }
      const stale = record.status === "running";
      const run = {
        id: record.id,
        sessionId,
        agentId: record.agentId ?? DEFAULT_AGENT.id,
        agentLabel: record.agentLabel ?? DEFAULT_AGENT.label,
        taskText: record.taskText,
        target: null,
        state: {
          blocks: record.blocks ?? [],
          permissionRequests: [],
          error: stale ? "Interrupted — this run did not finish." : null,
        },
        status: stale ? "error" : record.status,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        resultText: record.resultText ?? "",
        resultSent: Boolean(record.resultSent),
        expanded: false,
      };
      rebuiltCards.push(await attachCard(run));
    }
  }

  return { start, applyEvent, restore, list: () => [...runsByInstance.values()] };
}
