// ABOUTME: Task-workbench sidebar shown when a workspace enters Focus mode.
// ABOUTME: Renders back/new-task controls, a workspace info card, and a session list.
import { onLocaleChange, t } from "../../i18n.js";
import { createIcon } from "../../icons.js";

const INITIAL_LIMIT = 5;
const STEP = 10;

function folderNameOf(project) {
  if (!project) return "";
  if (project.folderName) return project.folderName;
  if (project.dirName) return project.dirName;
  const path = typeof project.path === "string" ? project.path : "";
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] || path;
}

function createIconRow(rowClass, iconClass, valueClass) {
  const row = document.createElement("div");
  row.className = `wqi-row ${rowClass}`;
  const icon = document.createElement("span");
  icon.className = iconClass;
  icon.setAttribute("aria-hidden", "true");
  const value = document.createElement("span");
  value.className = `wqi-row-value ${valueClass}`;
  row.append(icon, value);
  return { row, value };
}

export class WorkspaceFocusSidebar {
  constructor(container, options = {}) {
    this.container = container;
    this.project = options.project || null;
    this.activeSessionFile = options.activeSessionFile || null;
    this.unread = options.unread instanceof Set ? options.unread : new Set();
    this.streaming = options.streaming instanceof Set ? options.streaming : new Set();
    this.buildSessionItem = options.buildSessionItem || null;
    this.isArchived = typeof options.isArchived === "function" ? options.isArchived : null;
    this.cardInfo = options.cardInfo || null;
    this.onBack = options.onBack || null;
    this.onNewTask = options.onNewTask || null;
    this.onSessionSelect = options.onSessionSelect || null;
    this.onDelete = options.onDelete || null;
    this.onRename = options.onRename || null;
    this.initialLimit = INITIAL_LIMIT;
    this.step = STEP;
    // Default to fully expanded so the active session is never hidden, even
    // when it is an older entry beyond the initial limit.
    this.visibleCount = Number.POSITIVE_INFINITY;
    this.unsubscribeLocale = onLocaleChange(() => this.render());
  }

  setProjectState({ project, activeSessionFile, unread, streaming, cardInfo } = {}) {
    if (project !== undefined) this.project = project;
    if (activeSessionFile !== undefined) this.activeSessionFile = activeSessionFile;
    if (unread !== undefined) this.unread = unread instanceof Set ? unread : new Set();
    if (streaming !== undefined) this.streaming = streaming instanceof Set ? streaming : new Set();
    if (cardInfo !== undefined) this.cardInfo = cardInfo;
  }

  render() {
    const root = document.createElement("div");
    root.className = "workspace-focus-sidebar";

    const back = document.createElement("button");
    back.type = "button";
    back.className = "focus-back-btn";
    const backIcon = document.createElement("span");
    backIcon.className = "focus-back-icon";
    backIcon.setAttribute("aria-hidden", "true");
    const backGlyph = createIcon("chevron-left", { size: 14 });
    if (backGlyph) backIcon.appendChild(backGlyph);
    back.appendChild(backIcon);
    const backLabel = document.createElement("span");
    backLabel.textContent = t("workspace.back");
    back.appendChild(backLabel);
    back.addEventListener("click", () => this.onBack?.());
    root.appendChild(back);

    // Workspace info card — same shape/content as the sidebar hover card
    // (.workspace-quick-info), but without the Pin/Unpin control.
    root.appendChild(this._buildCard());

    const newTask = document.createElement("button");
    newTask.type = "button";
    newTask.className = "focus-new-task-btn";
    newTask.textContent = t("workspace.newTask");
    newTask.addEventListener("click", () => this.onNewTask?.(this.project));
    root.appendChild(newTask);

    const allSessions = Array.isArray(this.project?.sessions) ? this.project.sessions : [];
    const sessions = this.isArchived
      ? allSessions.filter((session) => !this.isArchived(session.filePath))
      : allSessions;
    const list = document.createElement("div");
    list.className = "focus-session-list";
    const visible = sessions.slice(0, this.visibleCount);
    for (const session of visible) {
      if (this.buildSessionItem) {
        const item = this.buildSessionItem({
          session,
          project: this.project,
          isActive: session.filePath === this.activeSessionFile,
          isUnread: this.unread.has(session.filePath),
          isStreaming: this.streaming.has(session.filePath),
          showPinButton: false,
          showArchiveButton: false,
          showDeleteButton: true,
          onSelect: (s, p) => this.onSessionSelect?.(s, p),
          onDelete: (filePath) => this.onDelete?.(filePath),
          onRename: (filePath, targetSession, item) =>
            this.onRename?.(filePath, targetSession, item),
        });
        list.appendChild(item);
      } else {
        list.appendChild(this.#buildSessionRow(session));
      }
    }
    root.appendChild(list);

    const total = sessions.length;
    const hasMore = this.visibleCount < total;
    const canShowLess = this.visibleCount > this.initialLimit && total > this.initialLimit;
    if (hasMore || canShowLess) {
      const toggleRow = document.createElement("div");
      toggleRow.className = "focus-sessions-toggle-row";
      if (hasMore) {
        const showMore = document.createElement("button");
        showMore.type = "button";
        showMore.className = "focus-sessions-toggle";
        showMore.textContent = t("workspace.showMore");
        showMore.addEventListener("click", () => {
          this.visibleCount += this.step;
          this.render();
        });
        toggleRow.appendChild(showMore);
      }
      if (canShowLess) {
        const showLess = document.createElement("button");
        showLess.type = "button";
        showLess.className = "focus-sessions-toggle focus-sessions-toggle-less";
        showLess.textContent = t("sidebar.showLess");
        showLess.addEventListener("click", () => {
          this.visibleCount = this.initialLimit;
          this.render();
        });
        toggleRow.appendChild(showLess);
      }
      root.appendChild(toggleRow);
    }

    this.container.replaceChildren(root);
  }

  destroy() {
    this.unsubscribeLocale?.();
    this.container?.replaceChildren();
  }

  // Fallback session row builder when buildSessionItem is not provided.
  // Mirrors the normal sidebar's #buildItem title logic: session.name if
  // present, otherwise the first message, otherwise the empty placeholder.
  // Never falls back to the session ID — the ID is not user-facing.
  #buildSessionRow(session) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `focus-session-row${
      session.filePath === this.activeSessionFile ? " active" : ""
    }`;
    const name = document.createElement("span");
    name.className = "focus-session-name";
    const title = session.name || session.firstMessage || t("sidebar.emptySession");
    name.textContent = title;
    name.title = title;
    row.appendChild(name);
    row.addEventListener("click", () => this.onSessionSelect?.(session));
    return row;
  }

  _buildCard() {
    const info = this.cardInfo || {};
    const card = document.createElement("div");
    card.className = "workspace-quick-info workspace-focus-card";

    const headerRow = document.createElement("div");
    headerRow.className = "wqi-header-row";
    const folderIcon = document.createElement("span");
    folderIcon.className = "wqi-folder-icon";
    folderIcon.setAttribute("aria-hidden", "true");
    const folderEl = document.createElement("span");
    folderEl.className = "wqi-folder-name";
    folderEl.textContent = info.folder || folderNameOf(this.project);
    headerRow.append(folderIcon, folderEl);

    const content = document.createElement("div");
    content.className = "wqi-content";

    const countRow = createIconRow("wqi-count-row", "wqi-count-icon", "wqi-count");
    countRow.value.textContent = info.count != null ? String(info.count) : "";
    const pathRow = createIconRow("wqi-path-row", "wqi-path-icon", "wqi-path");
    pathRow.value.textContent = info.path || this.project?.path || "";
    content.append(countRow.row, pathRow.row);

    if (info.repository) {
      const gitRegion = document.createElement("div");
      gitRegion.className = "wqi-git-region";
      const repoRow = createIconRow("wqi-repo-row", "wqi-repo-icon", "wqi-repo");
      repoRow.value.textContent = info.repository;
      gitRegion.appendChild(repoRow.row);
      content.appendChild(gitRegion);
    }

    card.append(headerRow, content);
    return card;
  }
}
