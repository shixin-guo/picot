import { describe, expect, it, vi } from "vitest";
import {
  createNativeTaskNotificationSender,
  createTaskCompletionNotifications,
} from "./task-completion-notifications.js";

function runtimeFrame(type, instanceId = "instance-a", eventProps = {}) {
  return { type: "runtime_event", target: { instanceId }, event: { type, ...eventProps } };
}

function setup({ storedValue, permission = true } = {}) {
  const storage = {
    getItem: vi.fn().mockReturnValue(storedValue ?? null),
  };
  const notificationApi = {
    isPermissionGranted: vi.fn().mockResolvedValue(permission),
    requestPermission: vi.fn().mockResolvedValue("granted"),
    sendNotification: vi.fn(),
  };
  const task = { id: "session-a", name: "Fix notification routing" };
  const showNotification = vi.fn();
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const control = createTaskCompletionNotifications({
    storage,
    notificationApi,
    resolveTask: () => task,
    title: (resolvedTask, error) => resolvedTask.name || (error ? "Task failed" : "Task completed"),
    body: (_resolvedTask, error) => error || "Finished",
    showNotification,
    logger,
  });
  return { control, logger, notificationApi, showNotification, task };
}

describe("task completion notifications", () => {
  it("invokes the native notification without sidebar task metadata", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    const send = createNativeTaskNotificationSender({ invoke });

    await send({
      title: "Task completed",
      body: "Finished",
      target: { workspaceId: "workspace-a", sessionId: "session-a" },
      task: null,
    });

    expect(invoke).toHaveBeenCalledWith("show_task_completion_notification", {
      title: "Task completed",
      body: "Finished",
      workspaceId: "workspace-a",
      sessionId: "session-a",
    });
  });

  it("logs why a native notification cannot be invoked", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const invoke = vi.fn();
    const send = createNativeTaskNotificationSender({ invoke, logger });

    await send({ title: "Task completed", body: "Finished", target: { instanceId: "instance-a" } });

    expect(invoke).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("incomplete target"),
      expect.objectContaining({ instanceId: "instance-a", workspaceId: null, sessionId: null }),
    );
  });

  it("notifies once when a running task settles", async () => {
    const { control, showNotification, task } = setup();
    control.handleRuntimeFrame(runtimeFrame("agent_start"));
    control.handleRuntimeFrame(runtimeFrame("agent_settled"));
    control.handleRuntimeFrame(runtimeFrame("agent_end"));

    await vi.waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    expect(showNotification).toHaveBeenCalledWith({
      title: "Fix notification routing",
      body: "Finished",
      target: { instanceId: "instance-a" },
      task,
      error: null,
    });
  });

  it("keeps the session name as the title but reports the error in the body", async () => {
    const { control, showNotification, task } = setup();
    control.handleRuntimeFrame(runtimeFrame("agent_start"));
    control.handleRuntimeFrame(
      runtimeFrame("agent_end", "instance-a", { errorMessage: "410 status code (no body)" }),
    );

    await vi.waitFor(() => {
      expect(showNotification).toHaveBeenCalledOnce();
    });
    expect(showNotification).toHaveBeenCalledWith({
      title: "Fix notification routing",
      body: "410 status code (no body)",
      target: { instanceId: "instance-a" },
      task,
      error: "410 status code (no body)",
    });
  });

  it("does not notify when the setting is disabled", async () => {
    const { control, showNotification } = setup({ storedValue: "false" });
    control.handleRuntimeFrame(runtimeFrame("agent_start"));
    control.handleRuntimeFrame(runtimeFrame("agent_end"));

    await Promise.resolve();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it("requests permission before the first notification", async () => {
    const { control, notificationApi, showNotification } = setup({ permission: false });
    control.handleRuntimeFrame(runtimeFrame("agent_start"));
    control.handleRuntimeFrame(runtimeFrame("agent_end"));

    await vi.waitFor(() => {
      expect(notificationApi.requestPermission).toHaveBeenCalledOnce();
      expect(showNotification).toHaveBeenCalledOnce();
    });
  });

  it("ignores completion events without a preceding start", async () => {
    const { control, logger, showNotification } = setup();
    control.handleRuntimeFrame(runtimeFrame("agent_end"));

    await Promise.resolve();
    expect(showNotification).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no matching agent start"), {
      key: "instance-a",
    });
  });
});
