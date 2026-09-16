import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { extractRuntimeEventError } from "../session/assistant-error.js";

const SETTINGS_KEY = "picot-settings-task-notifications";

function describeTarget(target = {}) {
  return {
    instanceId: target.instanceId ?? null,
    workspaceId: target.workspaceId ?? null,
    sessionId: target.sessionId ?? null,
  };
}

function targetKey(target = {}) {
  return target.instanceId || target.sessionId || null;
}

export function createNativeTaskNotificationSender({ invoke, logger = console } = {}) {
  return async ({ title, body, target }) => {
    if (!invoke) {
      logger.warn("[Notifications] native invoke is unavailable");
      return;
    }
    if (!target?.workspaceId || !target?.sessionId) {
      logger.warn(
        "[Notifications] native notification skipped: incomplete target",
        describeTarget(target),
      );
      return;
    }
    await invoke("show_task_completion_notification", {
      title,
      body,
      workspaceId: target.workspaceId,
      sessionId: target.sessionId,
    });
  };
}

export function createTaskCompletionNotifications({
  storage = globalThis.localStorage,
  notificationApi = { isPermissionGranted, requestPermission, sendNotification },
  resolveTask = () => null,
  title = (task, error) =>
    task?.name || task?.firstMessage || (error ? "Task failed" : "Task completed"),
  body = (_task, error) => error || "Your task has finished.",
  showNotification = (notification) => notificationApi.sendNotification(notification),
  onError = (error) => console.warn("[Notifications] Failed to show notification:", error),
  logger = console,
} = {}) {
  const runningTargets = new Set();

  const enabled = () => storage?.getItem(SETTINGS_KEY) !== "false";

  async function showCompletion(target, error = null) {
    const notificationTarget = describeTarget(target);
    if (!enabled()) {
      return;
    }
    let granted = await notificationApi.isPermissionGranted();
    if (!granted) {
      const permission = await notificationApi.requestPermission();
      granted = permission === "granted";
    }
    if (!granted) {
      logger.warn("[Notifications] completion skipped: permission denied", notificationTarget);
      return;
    }
    const task = resolveTask(target);
    await showNotification({
      title: title(task, error),
      body: body(task, error),
      target,
      task,
      error,
    });
  }

  function handleRuntimeFrame(frame) {
    if (frame?.type !== "runtime_event") return;
    const key = targetKey(frame.target);
    if (!key) {
      logger.warn("[Notifications] runtime event skipped: target has no key", {
        eventType: frame.event?.type ?? null,
        ...describeTarget(frame.target),
      });
      return;
    }
    if (frame.event?.type === "agent_start") {
      runningTargets.add(key);
      return;
    }
    if (frame.event?.type !== "agent_settled" && frame.event?.type !== "agent_end") return;
    if (!runningTargets.delete(key)) {
      logger.warn("[Notifications] completion skipped: no matching agent start", { key });
      return;
    }
    const error = extractRuntimeEventError(frame.event);
    void showCompletion(frame.target, error).catch(onError);
  }

  return { handleRuntimeFrame };
}
