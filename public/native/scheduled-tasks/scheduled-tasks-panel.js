// Scheduled Tasks tab (Settings → Scheduled Tasks): create/list/toggle/retry/
// delete per-workspace scheduled tasks via the host HTTP API
// (`/v2/scheduled-tasks*`, see `src-tauri/src/host_server.rs`). Runs are
// executed headlessly by the Rust-side scheduler (`src-tauri/src/scheduler.rs`)
// — a scheduled task's result is just a normal Picot session, so clicking a
// task with a `lastSessionId` navigates there via `onOpenSession`.
//
// The model dropdown reuses the same runtime RPC the composer's model picker
// uses (`get_available_models`, see `public/native/app.js` `loadAvailableModels`)
// rather than hardcoding a separate model list, so the two stay in sync.

import { onLocaleChange, t } from "../../i18n.js";

const STATUS_ICON = {
  pending: "○",
  running: "◐",
  success: "✓",
  failed: "✗",
};

const STATUS_LABEL_KEY = {
  pending: "scheduledTasks.statusPending",
  running: "scheduledTasks.statusRunning",
  success: "scheduledTasks.statusSuccess",
  failed: "scheduledTasks.statusFailed",
};

const FREQUENCY_LABEL_KEY = {
  once: "scheduledTasks.frequencyOnce",
  hourly: "scheduledTasks.frequencyHourly",
  daily: "scheduledTasks.frequencyDaily",
  weekly: "scheduledTasks.frequencyWeekly",
};

function formatTimestamp(seconds) {
  if (seconds == null) return "—";
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function promptPreview(prompt, max = 80) {
  const trimmed = (prompt || "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function whenInputToUnixSeconds(value) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return null;
  return Math.floor(parsed / 1000);
}

function formatModelName(model) {
  const raw = typeof model === "string" ? model : model?.name || model?.id || "";
  return raw.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

export function setupScheduledTasksPanel({
  getWorkspaceId,
  runtime,
  getTarget,
  onOpenSession,
  onError = (error) => console.warn("[ScheduledTasks]", error),
  fetchImpl = (...args) => fetch(...args),
} = {}) {
  const form = document.getElementById("scheduled-task-form");
  const listEl = document.getElementById("scheduled-task-list");
  if (!form || !listEl) return { load() {} };

  const promptInput = document.getElementById("scheduled-task-prompt");
  const frequencySelect = document.getElementById("scheduled-task-frequency");
  const whenInput = document.getElementById("scheduled-task-when");
  const whenLabel = document.getElementById("scheduled-task-when-label");
  const modelSelect = document.getElementById("scheduled-task-model");
  const enabledCheckbox = document.getElementById("scheduled-task-enabled");
  const submitButton = document.getElementById("scheduled-task-submit");
  const errorEl = document.getElementById("scheduled-task-form-error");
  const refreshButton = document.getElementById("scheduled-task-refresh-btn");
  const emptyEl = document.getElementById("scheduled-task-empty");

  let tasks = [];
  let modelsLoaded = false;

  function setError(message) {
    if (errorEl) errorEl.textContent = message || "";
  }

  function updateWhenLabel() {
    if (!whenLabel) return;
    whenLabel.textContent =
      frequencySelect?.value === "once"
        ? t("scheduledTasks.runAt")
        : t("scheduledTasks.startingAt");
  }
  frequencySelect?.addEventListener("change", updateWhenLabel);
  updateWhenLabel();

  onLocaleChange(() => {
    updateWhenLabel();
    render();
  });

  async function loadModels() {
    if (modelsLoaded || !modelSelect || !runtime || !getTarget) return;
    const target = getTarget();
    if (!target) return;
    try {
      const result = await runtime.request({ type: "get_available_models" }, target);
      const models = result?.response?.data?.models ?? [];
      for (const model of models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = formatModelName(model);
        modelSelect.appendChild(option);
      }
      modelsLoaded = true;
    } catch (error) {
      console.warn("[ScheduledTasks] Failed to load model catalog:", error);
    }
  }

  async function fetchJson(url, options) {
    const response = await fetchImpl(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        body?.error?.message || body?.error?.code || `Server error ${response.status}`,
      );
    }
    return body;
  }

  async function loadTasks() {
    const workspaceId = getWorkspaceId?.();
    if (!workspaceId) return;
    try {
      const body = await fetchJson(
        `/v2/scheduled-tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      tasks = body?.tasks ?? [];
      render();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function buildStatusBadge(task) {
    const badge = document.createElement("span");
    badge.className = "scheduled-task-status";
    badge.dataset.status = task.status;
    badge.textContent = STATUS_ICON[task.status] ?? "○";
    badge.title = STATUS_LABEL_KEY[task.status] ? t(STATUS_LABEL_KEY[task.status]) : task.status;
    return badge;
  }

  function buildItem(task) {
    const item = document.createElement("div");
    item.className = "scheduled-task-item";
    const canOpen = Boolean(task.lastSessionId);
    if (canOpen) item.classList.add("clickable");

    item.appendChild(buildStatusBadge(task));

    const body = document.createElement("div");
    body.className = "scheduled-task-body";

    const promptEl = document.createElement("div");
    promptEl.className = "scheduled-task-prompt";
    promptEl.textContent = promptPreview(task.prompt);
    promptEl.title = task.prompt;
    body.appendChild(promptEl);

    const meta = document.createElement("div");
    meta.className = "scheduled-task-meta";
    meta.appendChild(
      textSpan(t(FREQUENCY_LABEL_KEY[task.frequency] ?? "scheduledTasks.frequencyOnce")),
    );
    meta.appendChild(
      textSpan(
        t("scheduledTasks.modelMeta", {
          model: task.model || t("scheduledTasks.modelWorkspaceDefault"),
        }),
      ),
    );
    meta.appendChild(
      textSpan(t("scheduledTasks.nextRun", { time: formatTimestamp(task.nextRunAt) })),
    );
    meta.appendChild(
      textSpan(t("scheduledTasks.lastRun", { time: formatTimestamp(task.lastRunAt) })),
    );
    if (!task.enabled) {
      const tag = textSpan(t("scheduledTasks.disabledTag"));
      tag.classList.add("scheduled-task-disabled-tag");
      meta.appendChild(tag);
    }
    body.appendChild(meta);
    item.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "scheduled-task-actions";

    const enabledToggle = document.createElement("input");
    enabledToggle.type = "checkbox";
    enabledToggle.checked = Boolean(task.enabled);
    enabledToggle.title = t("scheduledTasks.enabledLabel");
    enabledToggle.addEventListener("click", (event) => event.stopPropagation());
    enabledToggle.addEventListener("change", () => {
      void toggleEnabled(task.id, enabledToggle.checked);
    });
    actions.appendChild(enabledToggle);

    if (task.status === "failed") {
      const retryButton = document.createElement("button");
      retryButton.type = "button";
      retryButton.className = "scheduled-task-retry-btn";
      retryButton.textContent = t("scheduledTasks.retry");
      retryButton.addEventListener("click", (event) => {
        event.stopPropagation();
        void runNow(task.id);
      });
      actions.appendChild(retryButton);
    }

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "scheduled-task-delete-btn";
    deleteButton.setAttribute("aria-label", t("scheduledTasks.deleteAriaLabel"));
    deleteButton.textContent = "×";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteTask(task.id);
    });
    actions.appendChild(deleteButton);

    item.appendChild(actions);

    if (canOpen) {
      item.addEventListener("click", () => onOpenSession?.(task.lastSessionId));
    }

    return item;
  }

  function textSpan(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }

  function render() {
    listEl.replaceChildren();
    if (tasks.length === 0) {
      if (emptyEl) {
        listEl.appendChild(emptyEl);
        emptyEl.hidden = false;
      }
      return;
    }
    for (const task of tasks) {
      listEl.appendChild(buildItem(task));
    }
  }

  async function toggleEnabled(id, enabled) {
    try {
      await fetchJson(`/v2/scheduled-tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      await loadTasks();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function deleteTask(id) {
    try {
      await fetchJson(`/v2/scheduled-tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
      await loadTasks();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async function runNow(id) {
    try {
      await fetchJson(`/v2/scheduled-tasks/${encodeURIComponent(id)}/run-now`, {
        method: "POST",
      });
      await loadTasks();
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");
    const prompt = promptInput?.value?.trim();
    if (!prompt) {
      setError(t("scheduledTasks.promptRequired"));
      return;
    }
    const anchorAt = whenInputToUnixSeconds(whenInput?.value);
    if (anchorAt == null) {
      setError(t("scheduledTasks.pickValidDateTime"));
      return;
    }
    const workspaceId = getWorkspaceId?.();
    if (!workspaceId) {
      setError(t("scheduledTasks.noWorkspaceOpen"));
      return;
    }
    if (submitButton) submitButton.disabled = true;
    try {
      await fetchJson("/v2/scheduled-tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt,
          model: modelSelect?.value || null,
          frequency: frequencySelect?.value || "once",
          anchorAt,
          enabled: enabledCheckbox ? enabledCheckbox.checked : true,
        }),
      });
      form.reset();
      updateWhenLabel();
      await loadTasks();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  });

  refreshButton?.addEventListener("click", () => void loadTasks());

  return {
    async load() {
      setError("");
      await Promise.all([loadModels(), loadTasks()]);
    },
  };
}
