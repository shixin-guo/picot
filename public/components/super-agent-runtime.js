/**
 * <super-agent-runtime> Web Component
 *
 * Replaces the SuperAgentRuntime class + initRuntimeCollapse in super-agent/panel.js.
 * Renders its own HTML, polls /api/super-agent/tasks every 3s.
 *
 * Usage:
 *   <super-agent-runtime id="super-agent-runtime"></super-agent-runtime>
 *
 * Dispatches a custom event "sa-dispatch" with task detail when Approve is clicked.
 * The host page should listen: el.addEventListener('sa-dispatch', e => ...)
 */

import {
  ACTIVE_TASK_STATUSES,
  markTaskFinished,
  markTaskForDispatch,
  normalizeSuperAgentTasks,
} from "../super-agent/task-state.js";
import { setupResizablePanel } from "../ui/resizable-panel.js";

class SuperAgentRuntime extends HTMLElement {
  connectedCallback() {
    this._tasks = [];
    this._projects = [];
    this._filter = "all";
    this._expandedTaskIds = new Set();
    this._historyTaskIds = new Set();
    this._pollInterval = null;
    this._lastJson = null;
    this._hasLoadedOnce = false;
    this._projectsLoadedOnce = false;

    this._render();
    this._cleanupResizablePanel = setupResizablePanel(this, {
      storageKey: "pi-studio-runtime-panel-width",
      defaultWidth: 360,
      minWidth: 280,
      maxWidth: 560,
    });
    this._renderAll();
    this._bindCollapseToggle();
    this._bindGlobalControls();
    this._startPolling();
    this._loadProjects();
  }

  disconnectedCallback() {
    clearInterval(this._pollInterval);
    clearTimeout(this._retryTimer);
    this._cleanupResizablePanel?.();
    document.removeEventListener("sa-open-runtime", this._handleOpenRuntime);
    document.removeEventListener("keydown", this._handleGlobalKeyDown);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _render() {
    this.innerHTML = `
      <div class="runtime-header app-side-panel-header" id="runtime-header">
        <span class="runtime-title">Tasks</span>
        <button class="icon-btn app-side-panel-close-btn" data-collapse-btn title="Close" aria-label="Close activity panel">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="runtime-filters" data-filters>
        <button class="runtime-filter active" data-filter="all">All</button>
        <button class="runtime-filter" data-filter="pending">Pending <span data-pending-count>0</span></button>
        <button class="runtime-filter" data-filter="running">Running <span data-running-count>0</span></button>
        <button class="runtime-filter" data-filter="done">Done <span data-done-count>0</span></button>
      </div>
      <div class="runtime-task-list" data-task-list></div>
      <div class="runtime-bulk-actions" data-bulk-actions></div>
    `;

    // Default closed; only reopen automatically when the user explicitly left it open.
    if (localStorage.getItem("sa-runtime-collapsed") !== "0") {
      this.classList.add("collapsed");
    }

    this.querySelector("[data-filters]").addEventListener("click", (e) => {
      const btn = e.target.closest(".runtime-filter");
      if (!btn) return;
      this._filter = btn.dataset.filter;
      this.querySelectorAll(".runtime-filter").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      this._renderTasks();
    });
  }

  _bindCollapseToggle() {
    const toggle = () => {
      const collapsed = this.classList.toggle("collapsed");
      localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
    };
    this.querySelector("[data-collapse-btn]")?.addEventListener("click", toggle);
  }

  _bindGlobalControls() {
    this._handleOpenRuntime = (event) => {
      this._openPanel(event.detail?.filter);
    };
    this._handleGlobalKeyDown = (event) => {
      if (!event.metaKey || !event.shiftKey || event.key.toLowerCase() !== "i") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      const collapsed = this.classList.toggle("collapsed");
      localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
    };
    document.addEventListener("sa-open-runtime", this._handleOpenRuntime);
    document.addEventListener("keydown", this._handleGlobalKeyDown);
  }

  _openPanel(filter = null) {
    this.classList.remove("collapsed");
    localStorage.setItem("sa-runtime-collapsed", "0");
    if (filter) this._setFilter(filter);
  }

  _setFilter(filter) {
    this._filter = filter;
    this.querySelectorAll(".runtime-filter").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === filter);
    });
    this._renderTasks();
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._retryDelay = 400;
    this._poll();
    this._pollInterval = setInterval(() => this._poll(), 3000);
  }

  async _poll() {
    try {
      const res = await fetch("/api/super-agent/tasks");
      if (!res.ok) {
        this._scheduleRetry();
        return;
      }
      const json = await res.text();
      this._hasLoadedOnce = true;
      this._retryDelay = 400;
      if (json === this._lastJson) return;
      this._lastJson = json;
      this._tasks = normalizeSuperAgentTasks(JSON.parse(json).tasks || []);
      this._renderAll();
    } catch {
      this._scheduleRetry();
    }
  }

  async _loadProjects() {
    try {
      const res = await fetch("/api/super-agent/projects");
      if (!res.ok) return;
      const data = await res.json();
      this._projects = Array.isArray(data.projects) ? data.projects : [];
      this._projectsLoadedOnce = true;
      this._renderTasks();
    } catch {
      this._projects = [];
    }
  }

  // The embedded pi server can still be warming up its extension routes
  // right after a fresh workspace/session spawn even though /api/health
  // already answered (see wait_for_endpoint in pi_manager.rs). Rather than
  // waiting out the full 3s interval on a failed/errored first poll, retry
  // quickly with backoff until we've loaded successfully once.
  _scheduleRetry() {
    if (this._hasLoadedOnce) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._poll(), this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, 3000);
  }

  async _save() {
    await fetch("/api/super-agent/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: this._tasks }),
    });
    this._lastJson = null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async _approve(taskId) {
    const task = this._tasks.find((t) => t.id === taskId);
    if (!task || !isDispatchableProjectPath(task.targetProject)) return;
    const index = this._tasks.findIndex((t) => t.id === taskId);
    this._tasks[index] = markTaskForDispatch(task);
    await this._save();
    this._renderAll();
    this.dispatchEvent(
      new CustomEvent("sa-dispatch", { detail: this._tasks[index], bubbles: true }),
    );
  }

  _selectProject(taskId, targetProject) {
    const index = this._tasks.findIndex((t) => t.id === taskId);
    if (index < 0) return;
    const project = this._projects.find((item) => item.cwd === targetProject);
    this._tasks[index] = {
      ...this._tasks[index],
      targetProject,
      dispatch: {
        ...(this._tasks[index].dispatch || {}),
        targetProject,
      },
      routingConfidence: "user_selected",
      routingReason: project
        ? `Selected in Picot Runtime panel from project registry (${project.name}).`
        : "Selected in Picot Runtime panel.",
    };
    this._renderTasks();
  }

  async _dismiss(taskId) {
    this._tasks = this._tasks.filter((t) => t.id !== taskId);
    await this._save();
    this._renderAll();
  }

  async _forceCancel(taskId) {
    const index = this._tasks.findIndex((t) => t.id === taskId);
    if (index < 0) return;
    this._tasks[index] = markTaskFinished(this._tasks[index], {
      status: "failed",
      failReason: "Manually cancelled from Runtime panel.",
    });
    await this._save();
    this._renderAll();
  }

  async _approveAll() {
    const readyTasks = this._tasks.filter(
      (task) => task.status === "pending" && isDispatchableProjectPath(task.targetProject),
    );
    if (readyTasks.length === 0) return;
    const readyIds = new Set(readyTasks.map((task) => task.id));
    this._tasks = this._tasks.map((task) =>
      readyIds.has(task.id) ? markTaskForDispatch(task) : task,
    );
    await this._save();
    this._renderAll();
    for (const task of this._tasks) {
      if (readyIds.has(task.id)) {
        this.dispatchEvent(new CustomEvent("sa-dispatch", { detail: task, bubbles: true }));
      }
    }
  }

  async _clearDone() {
    const nextTasks = this._tasks.filter((task) => task.status !== "done");
    if (nextTasks.length === this._tasks.length) return;
    this._tasks = nextTasks;
    await this._save();
    this._renderAll();
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  _renderAll() {
    const pending = this._tasks.filter((t) => t.status === "pending").length;
    const running = this._tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status)).length;
    const done = this._tasks.filter((t) => t.status === "done").length;

    const q = (sel) => this.querySelector(sel);
    q("[data-pending-count]").textContent = pending;
    q("[data-running-count]").textContent = running;
    q("[data-done-count]").textContent = done;

    this._renderBulkActions();

    // Update sidebar entry badge (outside this component)
    const badge = document.getElementById("super-agent-badge");
    if (badge) {
      const urgent = pending + running;
      badge.textContent = urgent;
      badge.classList.toggle("hidden", urgent === 0);
    }

    this._renderTasks();
  }

  _renderTasks() {
    const list = this.querySelector("[data-task-list]");
    if (!list) return;

    if (!this._hasLoadedOnce) {
      list.innerHTML = `<div style="padding:20px 0;text-align:center;font-size:12px;color:var(--text-dim)">
        Connecting…
      </div>`;
      return;
    }

    const order = { pending: 0, needs_input: 1, blocked: 2, running: 3, failed: 4, done: 5 };
    let filtered = this._tasks.filter((t) => {
      if (this._filter === "all") return true;
      if (this._filter === "running") return ACTIVE_TASK_STATUSES.has(t.status);
      return t.status === this._filter;
    });
    filtered = [...filtered].sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));

    if (filtered.length === 0) {
      list.innerHTML = `<div style="padding:20px 0;text-align:center;font-size:12px;color:var(--text-dim)">
        No tasks${this._filter !== "all" ? ` with status "${this._filter}"` : ""}…
      </div>`;
      return;
    }

    list.innerHTML = filtered.map((t) => this._cardHtml(t)).join("");
    this._bindCardEvents(list);
  }

  _renderBulkActions() {
    const container = this.querySelector("[data-bulk-actions]");
    if (!container) return;
    const ready = this._tasks.filter(
      (task) => task.status === "pending" && isDispatchableProjectPath(task.targetProject),
    ).length;
    const done = this._tasks.filter((task) => task.status === "done").length;
    container.innerHTML = `
      <button class="sa-btn sa-btn-approve" data-action="approve-all" type="button" ${ready === 0 ? "disabled" : ""}>Approve ${ready}</button>
      <button class="sa-btn sa-btn-dismiss" data-action="clear-done" type="button" ${done === 0 ? "disabled" : ""}>Clear Done</button>
    `;
    container.querySelector('[data-action="approve-all"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      this._approveAll();
    });
    container.querySelector('[data-action="clear-done"]')?.addEventListener("click", (event) => {
      event.stopPropagation();
      this._clearDone();
    });
  }

  _cardHtml(task) {
    const isExpanded = this._expandedTaskIds.has(task.id);
    const hasTargetProject = isDispatchableProjectPath(task.targetProject);
    const projectName = task.targetProject?.split("/").pop() || "";
    let body = "";

    if (isExpanded) {
      if (task.description) {
        body += `<div class="runtime-task-desc">${formatTaskDescription(task.description)}</div>`;
      }
      body += sourceHtml(task);

      if (task.status === "pending") {
        body += this._projectPickerHtml(task);
        body += `
          <div class="runtime-approve-row">
            <button class="sa-btn" data-action="prompt-task" data-task-id="${task.id}">Prompt AI</button>
            ${
              hasTargetProject
                ? `<button class="sa-btn sa-btn-approve" data-action="approve" data-task-id="${task.id}">Approve</button>`
                : ""
            }
            <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">✕</button>
          </div>`;
      } else if (task.status === "done" || task.status === "running") {
        if (hasTargetProject) {
          body += `<div class="runtime-task-target">Target: <strong>${esc(projectName)}</strong></div>`;
        }
        if (task.dispatch?.childPort) {
          body += `<div class="runtime-approve-row">
            <button class="sa-btn" data-action="view-session" data-task-id="${escAttr(task.id)}">View Session →</button>
            ${task.status === "running" ? `<button class="sa-btn sa-btn-dismiss" data-action="force-cancel" data-task-id="${escAttr(task.id)}">Force Cancel</button>` : ""}
          </div>`;
        } else if (task.status === "running") {
          body += `<div class="runtime-approve-row">
            <button class="sa-btn sa-btn-dismiss" data-action="force-cancel" data-task-id="${escAttr(task.id)}">Force Cancel</button>
          </div>`;
        }
      } else if (
        task.status === "failed" ||
        task.status === "blocked" ||
        task.status === "needs_input"
      ) {
        body += `<div class="runtime-task-error">${esc(task.result?.failReason || task.failReason || "Waiting for input.")}</div>`;
        if (hasTargetProject) {
          body += `<div class="runtime-task-target">Project: <strong>${esc(projectName)}</strong></div>`;
          body += `
            <div class="runtime-approve-row">
              <button class="sa-btn sa-btn-approve" data-action="retry" data-task-id="${task.id}">Retry</button>
              <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">Dismiss</button>
            </div>`;
        } else {
          body += `
            <div class="runtime-task-missing-target">Choose a project when creating this task.</div>
            <div class="runtime-approve-row">
              <button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${task.id}">Dismiss</button>
            </div>`;
        }
      }
      body += this._historyHtml(task);
    }

    return this._cardShell(task, body, isExpanded);
  }

  _cardShell(task, body, isExpanded = true) {
    return `<div class="runtime-task-card status-${task.status} ${isExpanded ? "is-expanded" : "is-collapsed"}"
      data-task-id="${task.id}" role="button" tabindex="0" aria-expanded="${isExpanded}">
      <div class="runtime-task-header">
        <span class="runtime-status-dot"></span>
        <span class="runtime-task-title">${esc(task.title || "(untitled)")}</span>
        ${this._quickActionsHtml(task)}
        <span class="runtime-task-expand-icon" aria-hidden="true"></span>
      </div>
      ${body}
    </div>`;
  }

  _quickActionsHtml(task) {
    const actions = [];
    if (task.status === "pending") {
      actions.push(
        `<button class="sa-btn" data-action="prompt-task" data-task-id="${escAttr(task.id)}" type="button">Prompt AI</button>`,
      );
      if (isDispatchableProjectPath(task.targetProject)) {
        actions.push(
          `<button class="sa-btn sa-btn-approve" data-action="approve" data-task-id="${escAttr(task.id)}" type="button">Approve</button>`,
        );
      }
      actions.push(
        `<button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}" type="button">Dismiss</button>`,
      );
    } else if (task.status === "done") {
      actions.push(
        `<button class="sa-btn sa-btn-dismiss" data-action="dismiss" data-task-id="${escAttr(task.id)}" type="button">Clear</button>`,
      );
    }
    if (actions.length === 0) return "";
    return `<span class="runtime-quick-actions">${actions.join("")}</span>`;
  }

  _historyHtml(task) {
    if (!Array.isArray(task.events) || task.events.length === 0) return "";
    const open = this._historyTaskIds.has(task.id);
    const items = open
      ? `<div class="runtime-task-history-list">
          ${task.events
            .map(
              (event) => `<div class="runtime-task-history-item">
                <span>${esc(formatHistoryTimestamp(event.at))}</span>
                <strong>${esc(event.type || event.status || "event")}</strong>
                <p>${esc(event.message || event.status || "")}</p>
              </div>`,
            )
            .join("")}
        </div>`
      : "";
    return `<div class="runtime-task-history">
      <button class="sa-btn" data-action="toggle-history" data-task-id="${escAttr(task.id)}" type="button">History</button>
      ${items}
    </div>`;
  }

  _projectPickerHtml(task) {
    const targetProject = String(task.targetProject || "");
    const projectOptions = [...this._projects];
    if (targetProject && !projectOptions.some((project) => project.cwd === targetProject)) {
      projectOptions.unshift({
        name: targetProject.split("/").pop() || targetProject,
        cwd: targetProject,
        status: "unknown",
      });
    }
    const options = [
      `<option value="">Choose a project…</option>`,
      ...projectOptions.map((project) => {
        const selected = project.cwd === targetProject ? " selected" : "";
        const status = project.status === "running" ? " · running" : "";
        return `<option value="${escAttr(project.cwd)}"${selected}>${esc(project.name || project.cwd)}${status}</option>`;
      }),
    ].join("");
    const hint = targetProject
      ? `Project: ${esc(targetProject.split("/").pop() || targetProject)}`
      : this._projectsLoadedOnce
        ? "Choose a project before approval."
        : "Loading projects…";
    return `
      <label class="runtime-project-picker">
        <span>${hint}</span>
        <select class="runtime-project-select" data-action="select-project" data-task-id="${escAttr(task.id)}">
          ${options}
        </select>
      </label>`;
  }

  _bindCardEvents(list) {
    list.querySelectorAll(".runtime-task-card").forEach((card) => {
      const toggle = () => {
        const { taskId } = card.dataset;
        if (this._expandedTaskIds.has(taskId)) {
          this._expandedTaskIds.delete(taskId);
        } else {
          this._expandedTaskIds.add(taskId);
        }
        this._renderTasks();
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, textarea, a")) return;
        toggle();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("button, input, select, textarea, a")) return;
        e.preventDefault();
        toggle();
      });
    });

    list.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const { action, taskId } = el.dataset;
        if (action === "approve" || action === "retry") {
          this._approve(taskId);
        } else if (action === "dismiss") {
          this._dismiss(taskId);
        } else if (action === "prompt-task") {
          const task = this._tasks.find((item) => item.id === taskId);
          if (task) {
            this.dispatchEvent(new CustomEvent("sa-prompt-task", { detail: task, bubbles: true }));
          }
        } else if (action === "approve-all") {
          this._approveAll();
        } else if (action === "clear-done") {
          this._clearDone();
        } else if (action === "force-cancel") {
          this._forceCancel(taskId);
        } else if (action === "view-session") {
          const task = this._tasks.find((item) => item.id === taskId);
          if (task) {
            this.dispatchEvent(new CustomEvent("sa-view-session", { detail: task, bubbles: true }));
          }
        } else if (action === "toggle-history") {
          if (this._historyTaskIds.has(taskId)) {
            this._historyTaskIds.delete(taskId);
          } else {
            this._historyTaskIds.add(taskId);
          }
          this._renderTasks();
        } else if (action === "select-project") {
          this._selectProject(taskId, el.value);
        }
      });
    });

    list.querySelectorAll('[data-action="select-project"]').forEach((el) => {
      el.addEventListener("change", (e) => {
        e.stopPropagation();
        this._selectProject(el.dataset.taskId, el.value);
      });
    });
  }
}

function isDispatchableProjectPath(path) {
  const normalized = String(path || "").replace(/\/+$/, "");
  return normalized.includes("/") && !normalized.endsWith("/.pi/agent/super-agent");
}

function sourceHtml(task) {
  if (!task.source || task.source.channel === "local") return "";
  return `<div class="runtime-task-source">Source: ${esc(task.source.channel)}</div>`;
}

function formatTaskDescription(description) {
  const lines = normalizeTaskDescription(description);
  if (lines.length === 0) return "";

  return lines
    .map((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        return `<div class="runtime-task-section-title">${renderTaskInline(heading[1])}</div>`;
      }

      const bullet = line.match(/^[-*]\s+(.+)$/);
      if (bullet) {
        return `<div class="runtime-task-list-item">${renderTaskInline(bullet[1])}</div>`;
      }

      const numbered = line.match(/^\d+\.\s+(.+)$/);
      if (numbered) {
        return `<div class="runtime-task-list-item">${renderTaskInline(numbered[1])}</div>`;
      }

      return `<div class="runtime-task-paragraph">${renderTaskInline(line)}</div>`;
    })
    .join("");
}

function normalizeTaskDescription(description) {
  return String(description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+(#{1,6})\s+/g, "\n$1 ")
    .replace(/[ \t]+[-*]\s+(?=(?:\p{Extended_Pictographic}|\*\*|[A-Z0-9]))/gu, "\n- ")
    .replace(/[ \t]+(\d+)\.\s+/g, "\n$1. ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderTaskInline(text) {
  return esc(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(str) {
  return esc(str).replace(/'/g, "&#39;");
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function formatHistoryTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

customElements.define("super-agent-runtime", SuperAgentRuntime);
