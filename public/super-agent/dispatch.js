import { buildProjectAgentPrompt, markTaskFinished, markTaskForDispatch } from "./task-state.js";

export async function dispatchSuperAgentTask({
  task,
  transport,
  getCurrentPort,
  updateSuperAgentTask,
  fetchImpl = globalThis.fetch,
  dispatchedTasks = null,
  logger = console,
}) {
  if (!transport || !task) return null;
  const targetCwd = task.targetProject;
  if (!targetCwd) return null;

  const saPort = task.superAgentPort || getCurrentPort?.();
  let dispatchTask = null;
  let newPort = null;

  try {
    newPort = await transport.openWorkspace(targetCwd, {
      forceNewSession: false,
      openWindow: false,
      waitForHealth: true,
      waitForSessions: false,
    });
    dispatchTask = markTaskForDispatch(task, {
      superAgentPort: saPort,
      childPort: newPort,
    });
    await updateSuperAgentTask(saPort, dispatchTask.id, () => dispatchTask);
    dispatchedTasks?.set?.(newPort, {
      taskId: dispatchTask.id,
      superAgentPort: saPort,
      title: dispatchTask.title,
    });

    const response = await fetchImpl(`http://localhost:${newPort}/api/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: buildProjectAgentPrompt(dispatchTask) }),
    });
    const data = await readJsonResponse(response);
    if (!response?.ok || data?.success === false) {
      throw new Error(data?.error || `Prompt request failed with HTTP ${response?.status || 0}`);
    }
    return dispatchTask;
  } catch (error) {
    logger?.error?.("[SuperAgent] dispatch failed:", error);
    dispatchedTasks?.delete?.(newPort);
    if (dispatchTask && saPort) {
      await updateSuperAgentTask(saPort, dispatchTask.id, (currentTask) =>
        markTaskFinished(currentTask, {
          status: "failed",
          failReason: errorMessage(error),
        }),
      ).catch((updateError) => {
        logger?.warn?.("[SuperAgent] failed to mark dispatch failed:", updateError);
      });
    }
    return null;
  }
}

async function readJsonResponse(response) {
  try {
    return await response?.json?.();
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "Dispatch failed");
}
