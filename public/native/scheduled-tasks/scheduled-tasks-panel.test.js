import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupScheduledTasksPanel } from "./scheduled-tasks-panel.js";

function renderDom() {
  document.body.innerHTML = `
    <form id="scheduled-task-form">
      <textarea id="scheduled-task-prompt"></textarea>
      <select id="scheduled-task-frequency">
        <option value="once">Once</option>
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
      </select>
      <span id="scheduled-task-when-label"></span>
      <input type="datetime-local" id="scheduled-task-when" />
      <select id="scheduled-task-model"><option value="">Use workspace default</option></select>
      <input type="checkbox" id="scheduled-task-enabled" checked />
      <button type="submit" id="scheduled-task-submit">Add</button>
      <span id="scheduled-task-form-error"></span>
    </form>
    <button id="scheduled-task-refresh-btn">Refresh</button>
    <div id="scheduled-task-list">
      <div id="scheduled-task-empty">No scheduled tasks yet.</div>
    </div>
  `;
}

function task(overrides = {}) {
  return {
    id: "task-1",
    workspaceId: "workspace-a",
    prompt: "Summarize open PRs",
    model: "claude-haiku-4-5",
    frequency: "daily",
    anchorAt: 1000,
    enabled: true,
    status: "pending",
    lastSessionId: null,
    lastRunAt: null,
    nextRunAt: 2000,
    retryCount: 0,
    createdAt: 500,
    ...overrides,
  };
}

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) });
}

describe("scheduled tasks panel", () => {
  beforeEach(() => {
    renderDom();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("loads and renders the workspace's scheduled tasks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ tasks: [task()] }));
    const panel = setupScheduledTasksPanel({
      getWorkspaceId: () => "workspace-a",
      fetchImpl,
    });

    await panel.load();

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v2/scheduled-tasks?workspaceId=workspace-a",
      undefined,
    );
    const item = document.querySelector(".scheduled-task-item");
    expect(item).toBeTruthy();
    expect(item.querySelector(".scheduled-task-prompt").textContent).toBe("Summarize open PRs");
    expect(item.querySelector(".scheduled-task-status").dataset.status).toBe("pending");
  });

  it("shows the empty state when there are no tasks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ tasks: [] }));
    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });

    await panel.load();

    expect(document.getElementById("scheduled-task-empty").hidden).toBe(false);
    expect(document.querySelectorAll(".scheduled-task-item").length).toBe(0);
  });

  it("shows a Retry button only for failed tasks", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ tasks: [task({ status: "failed" })] }));
    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });

    await panel.load();

    expect(document.querySelector(".scheduled-task-retry-btn")).toBeTruthy();
  });

  it("creates a task from the form and reloads the list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tasks: [] })) // initial load
      .mockResolvedValueOnce(jsonResponse(task())) // create response
      .mockResolvedValueOnce(jsonResponse({ tasks: [task()] })); // reload after create

    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });
    await panel.load();

    document.getElementById("scheduled-task-prompt").value = "Summarize open PRs";
    document.getElementById("scheduled-task-when").value = "2024-01-01T09:00";
    document
      .getElementById("scheduled-task-form")
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    const [, createOptions] = fetchImpl.mock.calls[1];
    expect(createOptions.method).toBe("POST");
    const createBody = JSON.parse(createOptions.body);
    expect(createBody.workspaceId).toBe("workspace-a");
    expect(createBody.prompt).toBe("Summarize open PRs");
    expect(createBody.frequency).toBe("once");
    expect(typeof createBody.anchorAt).toBe("number");
  });

  it("rejects an empty prompt without calling the API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ tasks: [] }));
    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });
    await panel.load();
    fetchImpl.mockClear();

    document.getElementById("scheduled-task-when").value = "2024-01-01T09:00";
    document
      .getElementById("scheduled-task-form")
      .dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(document.getElementById("scheduled-task-form-error").textContent).toMatch(/prompt/i);
  });

  it("toggles enabled via PATCH when the checkbox changes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tasks: [task()] }))
      .mockResolvedValueOnce(jsonResponse(task({ enabled: false })))
      .mockResolvedValueOnce(jsonResponse({ tasks: [task({ enabled: false })] }));
    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });
    await panel.load();

    const checkbox = document.querySelector(".scheduled-task-actions input[type=checkbox]");
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    const [url, options] = fetchImpl.mock.calls[1];
    expect(url).toBe("/v2/scheduled-tasks/task-1");
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body)).toEqual({ enabled: false });
  });

  it("deletes a task and reloads the list", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tasks: [task()] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ tasks: [] }));
    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });
    await panel.load();

    document.querySelector(".scheduled-task-delete-btn").click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    const [url, options] = fetchImpl.mock.calls[1];
    expect(url).toBe("/v2/scheduled-tasks/task-1");
    expect(options.method).toBe("DELETE");
  });

  it("runs a failed task now via the Retry button", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ tasks: [task({ status: "failed" })] }))
      .mockResolvedValueOnce(jsonResponse(task({ status: "success" })))
      .mockResolvedValueOnce(jsonResponse({ tasks: [task({ status: "success" })] }));
    const panel = setupScheduledTasksPanel({ getWorkspaceId: () => "workspace-a", fetchImpl });
    await panel.load();

    document.querySelector(".scheduled-task-retry-btn").click();

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    const [url, options] = fetchImpl.mock.calls[1];
    expect(url).toBe("/v2/scheduled-tasks/task-1/run-now");
    expect(options.method).toBe("POST");
  });

  it("navigates to the task's session when clicked", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ tasks: [task({ lastSessionId: "session-xyz" })] }));
    const onOpenSession = vi.fn();
    const panel = setupScheduledTasksPanel({
      getWorkspaceId: () => "workspace-a",
      fetchImpl,
      onOpenSession,
    });
    await panel.load();

    document.querySelector(".scheduled-task-item").click();

    expect(onOpenSession).toHaveBeenCalledWith("session-xyz");
  });

  it("does not treat a task without a session as clickable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ tasks: [task()] }));
    const onOpenSession = vi.fn();
    const panel = setupScheduledTasksPanel({
      getWorkspaceId: () => "workspace-a",
      fetchImpl,
      onOpenSession,
    });
    await panel.load();

    document.querySelector(".scheduled-task-item").click();

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(document.querySelector(".scheduled-task-item.clickable")).toBeFalsy();
  });
});
