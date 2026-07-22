// ABOUTME: Lists sessions grouped by project and handles session switching.
// ABOUTME: Coordinates recent, pinned, and live workspace state for the sidebar.

/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

import { onLocaleChange, t } from "../i18n.js";
import { createPinnedItemsStore } from "../pinned-items.js";
import {
  readRecentSessions,
  recordRecentSession,
  writeRecentSessions,
} from "../recent-sessions.js";
import { buildSidebarSection, buildSidebarWorkspaceGroup } from "../sidebar-workspace-group.js";
import { getSuperAgentProject, isSuperAgentProjectPath } from "../super-agent/session.js";
import { isSuperAgentEnabled } from "../super-agent/settings.js";
import { basenameLocalPath } from "../workspace/path-utils.js";
import { mergeWorkspaceProjects, resolvePinnedWorkspaceGroups } from "../workspace-projects.js";
import { WorkspaceQuickInfo } from "../workspace-quick-info.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function readJsonArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function createSvgIcon(kind) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const elements =
    kind === "archive"
      ? [
          ["rect", { x: "3", y: "4", width: "18", height: "4", rx: "1.5" }],
          ["path", { d: "M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" }],
          ["path", { d: "M10 12h4" }],
        ]
      : kind === "folder"
        ? [
            [
              "path",
              { d: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" },
            ],
          ]
        : [
            ["path", { d: "M6 7h12l-1 14H7z" }],
            ["path", { d: "M4 7h16M9 7V4h6v3" }],
          ];
  for (const [tag, attrs] of elements) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    svg.appendChild(element);
  }
  return svg;
}

function appendHighlightedText(container, text, query) {
  const source = String(text || "");
  if (!query) {
    container.textContent = source;
    return;
  }
  const expression = new RegExp(query.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&"), "gi");
  let cursor = 0;
  for (const match of source.matchAll(expression)) {
    if (match.index > cursor)
      container.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    const mark = document.createElement("mark");
    mark.textContent = match[0];
    container.appendChild(mark);
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
}

export class SessionSidebar {
  constructor(container, onSessionSelect, onNewChat, options = {}) {
    this.projectSessionInitialLimit = 5;
    this.projectSessionStep = 10;
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.onNewChat = onNewChat;
    this.onOpenProject = options.onOpenProject || null;
    this.superAgentPath = options.superAgentPath || "";
    this.activeSessionFile = null;
    this.projects = [];
    this.collapsedProjects = new Set();
    this.searchQuery = "";
    this.recent = readRecentSessions();
    this.recentCollapsed = false;
    this.archived = readJsonArray("pi-studio-archived");
    this.archivedCollapsed = localStorage.getItem("pi-studio-archived-collapsed") !== "false";
    this.unread = new Set(readJsonArray("pi-studio-unread"));
    this.pinStore = options.pinStore || createPinnedItemsStore();
    this.quickInfo = options.quickInfo || new WorkspaceQuickInfo({ pinStore: this.pinStore });
    this.unsubscribePinStore =
      this.pinStore.subscribe?.(() => this.render({ preserveQuickInfo: true })) || null;
    this.pinStore.migrateLegacyFavourites?.({ excludedSessions: this.archived });
    this.streamingFiles = new Set();
    this.projectVisibleSessionCounts = new Map();
    this.contextMenu = null;
    // `loadSeq` counts issued loads; `loadCommitted` is the highest seq that has
    // actually rendered. We discard a response only when a *newer* one has
    // already committed (out-of-order arrival), never just because a newer load
    // was issued — an in-flight later load must not starve an earlier fetch that
    // already returned fresh data (e.g. the first response that observes a
    // brand-new session's just-written .jsonl).
    this.loadSeq = 0;
    this.loadCommitted = 0;

    // Close context menu on click anywhere
    document.addEventListener("click", () => {
      this.closeContextMenu();
    });
    document.addEventListener("contextmenu", (e) => {
      if (!e.target.closest(".workspace-header, .sidebar-context-menu")) this.closeContextMenu();
    });

    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.container || this.container.children.length === 0) return;
      if (this.loadSeq > this.loadCommitted) return; // load in-flight
      const savedScroll = this.container.scrollTop;
      this.render();
      this.container.scrollTop = savedScroll;
    });
  }

  saveArchived() {
    localStorage.setItem("pi-studio-archived", JSON.stringify(this.archived));
  }

  saveArchivedCollapsed() {
    localStorage.setItem("pi-studio-archived-collapsed", String(this.archivedCollapsed));
  }

  saveUnread() {
    localStorage.setItem("pi-studio-unread", JSON.stringify(Array.from(this.unread)));
  }

  isUnread(filePath) {
    return this.unread.has(filePath);
  }

  isStreaming(filePath) {
    return this.streamingFiles.has(filePath);
  }

  markUnread(filePath) {
    if (!filePath) return;
    if (filePath === this.activeSessionFile) return;
    if (this.unread.has(filePath)) return;
    this.unread.add(filePath);
    this.saveUnread();
    this.applyStatusToItem(filePath);
  }

  markRead(filePath) {
    if (!filePath) return;
    if (!this.unread.has(filePath)) return;
    this.unread.delete(filePath);
    this.saveUnread();
    this.applyStatusToItem(filePath);
  }

  setStreaming(filePath, streaming) {
    if (!filePath) return;
    const had = this.streamingFiles.has(filePath);
    if (streaming && !had) {
      this.streamingFiles.add(filePath);
    } else if (!streaming && had) {
      this.streamingFiles.delete(filePath);
    } else {
      return;
    }
    this.applyStatusToItem(filePath);
  }

  clearStreaming() {
    if (this.streamingFiles.size === 0) return;
    const files = Array.from(this.streamingFiles);
    this.streamingFiles.clear();
    files.forEach((f) => {
      this.applyStatusToItem(f);
    });
  }

  applyStatusToItem(filePath) {
    const items = this.container.querySelectorAll(
      `.session-item[data-file-path="${CSS.escape(filePath)}"]`,
    );
    items.forEach((el) => {
      el.classList.toggle("unread", this.unread.has(filePath));
      el.classList.toggle("streaming", this.streamingFiles.has(filePath));
      el.classList.toggle("mirror-live", this.streamingFiles.has(filePath));
    });
  }

  isArchived(filePath) {
    return this.archived.includes(filePath);
  }

  toggleArchived(filePath) {
    const idx = this.archived.indexOf(filePath);
    if (idx >= 0) {
      this.archived.splice(idx, 1);
    } else {
      this.archived.push(filePath);
    }
    this.saveArchived();
    this.render();
  }

  async deleteAllArchived() {
    const paths = [...this.archived];
    if (paths.length === 0) return;

    const count = paths.length;
    const ok = await this.confirmArchivedDeletion(count);
    if (!ok) return;

    try {
      const res = await fetch("/api/sessions/delete-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePaths: paths }),
      });
      const data = await res.json();
      const errorSet = new Set(data.errors || []);
      const deleted = new Set(paths.filter((p) => !errorSet.has(p)));
      this.archived = this.archived.filter((p) => !deleted.has(p));
      this.saveArchived();
    } catch (err) {
      console.error("[Sidebar] deleteAllArchived failed:", err);
    }

    await this.loadSessions();
  }

  async confirmArchivedDeletion(count) {
    const message =
      count === 1
        ? t("sidebar.deleteArchivedConfirmOne", { count })
        : t("sidebar.deleteArchivedConfirmMany", { count });
    return this.showFallbackConfirmDialog(message);
  }

  showFallbackConfirmDialog(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sidebar-confirm-overlay";
      const dialog = document.createElement("div");
      dialog.className = "sidebar-confirm-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", t("sidebar.deleteArchivedAriaLabel"));
      const messageElement = document.createElement("div");
      messageElement.className = "sidebar-confirm-message";
      messageElement.textContent = message;
      const actions = document.createElement("div");
      actions.className = "sidebar-confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "sidebar-confirm-no";
      cancel.textContent = t("actions.cancel");
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "sidebar-confirm-yes";
      confirm.textContent = t("actions.delete");
      actions.append(cancel, confirm);
      dialog.append(messageElement, actions);
      overlay.appendChild(dialog);

      const cleanup = (result) => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };

      const onKeyDown = (event) => {
        if (event.key === "Escape") cleanup(false);
      };

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) cleanup(false);
      });

      overlay.querySelector(".sidebar-confirm-no").addEventListener("click", () => cleanup(false));
      overlay.querySelector(".sidebar-confirm-yes").addEventListener("click", () => cleanup(true));

      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
    });
  }

  async loadSessions({ retries = 4, retryDelayMs = 250, quiet = false } = {}) {
    const seq = ++this.loadSeq;
    if (!quiet) {
      this.container.replaceChildren();
      for (let index = 0; index < 6; index += 1) {
        const skeleton = document.createElement("div");
        skeleton.className = "session-skeleton";
        const title = document.createElement("div");
        title.className = "session-skeleton-title";
        const meta = document.createElement("div");
        meta.className = "session-skeleton-meta";
        skeleton.append(title, meta);
        this.container.appendChild(skeleton);
      }
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const historyProjects = Array.isArray(data.projects) ? data.projects : [];
        let instances = [];
        try {
          const instancesRes = await fetch("/api/instances");
          if (instancesRes.ok) {
            const instancesData = await instancesRes.json();
            instances = Array.isArray(instancesData.instances) ? instancesData.instances : [];
          }
        } catch {
          // History still receives stable workspace IDs when live-instance lookup fails.
        }
        const merged = mergeWorkspaceProjects(historyProjects, instances, this.projects);
        const projects = merged.projects;
        if (seq < this.loadCommitted) return this.projects;
        for (const reconciliation of merged.reconciliations) {
          this.pinStore.reconcileWorkspace?.(reconciliation);
        }
        this.loadCommitted = seq;
        this.projects = projects;
        this.render();
        return this.projects;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        }
      }
    }

    console.error("[Sidebar] Failed to load sessions:", lastError);
    if (seq < this.loadCommitted) return this.projects;
    const reason = String(lastError?.message || lastError || "").toLowerCase();
    const likelyRuntimeDown =
      reason.includes("failed to fetch") ||
      reason.includes("networkerror") ||
      reason.includes("load failed");
    const message = likelyRuntimeDown
      ? t("sidebar.failedToLoadSessionsRuntime")
      : t("sidebar.failedToLoadSessions");
    this.container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "session-loading";
    loading.textContent = message;
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "retry-link";
    retryBtn.id = "retry-load-sessions";
    retryBtn.textContent = t("sidebar.retry");
    retryBtn.addEventListener("click", () => this.loadSessions());
    loading.append(" ", retryBtn);
    this.container.appendChild(loading);
  }

  setSearchQuery(query) {
    this.searchQuery = query.toLowerCase().trim();

    // Clear pending full-text search
    if (this._searchTimer) clearTimeout(this._searchTimer);

    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }

    // Instant: filter titles
    this.applySearch();

    // Debounced: full-text search (300ms)
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => this.fullTextSearch(this.searchQuery), 300);
    }
  }

  async fullTextSearch(query) {
    // Don't search if query changed since debounce
    if (query !== this.searchQuery) return;

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (query !== this.searchQuery) return; // stale

      this._searchResults = data.results || [];
      this.renderSearchResults();
    } catch (err) {
      console.error("[Sidebar] Search failed:", err);
    }
  }

  renderSearchResults() {
    if (!this._searchResults || this._searchResults.length === 0) return;

    // Remove previous search results section
    const existing = this.container.querySelector(".search-results-group");
    if (existing) existing.remove();

    const group = document.createElement("div");
    group.className = "search-results-group";

    const header = document.createElement("div");
    header.className = "project-header search-results-header";
    const searchIcon = document.createElement("span");
    searchIcon.textContent = "🔍";
    const label = document.createElement("span");
    label.textContent = t("sidebar.messageMatches");
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = String(this._searchResults.length);
    header.append(searchIcon, label, count);
    group.appendChild(header);

    const sessionsDiv = document.createElement("div");
    sessionsDiv.className = "project-sessions";

    for (const result of this._searchResults) {
      const item = document.createElement("div");
      item.className = "session-item search-result-item";
      item.dataset.filePath = result.filePath;

      if (result.filePath === this.activeSessionFile) {
        item.classList.add("active");
      }

      const title = result.sessionName || result.firstMessage || t("sidebar.untitled");
      const snippet = result.matches[0]?.snippet || "";
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);

      const titleRow = document.createElement("div");
      titleRow.className = "session-title-row";
      const titleElement = document.createElement("div");
      titleElement.className = "session-title";
      titleElement.title = title;
      titleElement.textContent = title;
      titleRow.appendChild(titleElement);
      const snippetElement = document.createElement("div");
      snippetElement.className = "search-snippet";
      appendHighlightedText(snippetElement, snippet, this.searchQuery);
      const meta = document.createElement("div");
      meta.className = "session-meta";
      meta.textContent = time;
      if (matchCount > 1) meta.append(` · ${t("sidebar.matchCount", { count: matchCount })}`);
      item.append(titleRow, snippetElement, meta);

      // Find the matching project/session to pass to onSessionSelect
      item.addEventListener("click", () => {
        for (const project of this.projects) {
          const session = project.sessions.find((s) => s.filePath === result.filePath);
          if (session) {
            this.onSessionSelect(session, project);
            return;
          }
        }
        // Session not in loaded list (unlikely) — try switching by path
        this.onSessionSelect(
          { filePath: result.filePath, name: result.sessionName },
          { path: result.project },
        );
      });

      sessionsDiv.appendChild(item);
    }

    group.appendChild(sessionsDiv);
    // Insert at top of container
    this.container.insertBefore(group, this.container.firstChild);
  }

  highlightMatch(text, query) {
    const fragment = document.createDocumentFragment();
    appendHighlightedText(fragment, text, query);
    return fragment;
  }
  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll(".session-item").forEach((el) => {
        el.classList.remove("hidden");
      });
      this.container
        .querySelectorAll(".project-group, .pinned-group, .archived-group, .recent-group")
        .forEach((el) => {
          el.style.display = "";
        });
      const searchGroup = this.container.querySelector(".search-results-group");
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search RECENT section
    const recentSection = this.container.querySelector(".recent-group");
    if (recentSection) {
      let hasVisible = false;
      recentSection.querySelectorAll(".session-item").forEach((item) => {
        const matches = this.sessionItemMatchesSearch(item);
        item.classList.toggle("hidden", !matches);
        if (matches) hasVisible = true;
      });
      recentSection.style.display = hasVisible ? "" : "none";
    }

    this.container.querySelectorAll(".project-group, .archived-group").forEach((group) => {
      let hasVisible = false;
      const projectMatches = (group.dataset.projectSearchText || "").includes(this.searchQuery);
      group.querySelectorAll(".session-item").forEach((item) => {
        const matches = projectMatches || this.sessionItemMatchesSearch(item);
        item.classList.toggle("hidden", !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? "" : "none";
    });
  }

  sessionItemMatchesSearch(item) {
    const title = (item.querySelector(".session-title")?.textContent || "").toLowerCase();
    const projectText = item.dataset.projectSearchText || "";
    return title.includes(this.searchQuery) || projectText.includes(this.searchQuery);
  }

  resolveRecentSessions() {
    const sessionsByPath = new Map();
    for (const project of this.projects) {
      for (const session of project.sessions) {
        if (!this.isArchived(session.filePath)) {
          sessionsByPath.set(session.filePath, { session, project });
        }
      }
    }

    const resolved = this.recent.map((filePath) => sessionsByPath.get(filePath)).filter(Boolean);
    const validPaths = resolved.map(({ session }) => session.filePath);
    if (JSON.stringify(validPaths) !== JSON.stringify(this.recent)) {
      this.recent = writeRecentSessions(validPaths);
    }
    return resolved;
  }

  recordRecent(filePath) {
    const next = recordRecentSession(filePath);
    const changed = JSON.stringify(next) !== JSON.stringify(this.recent);
    this.recent = next;
    return changed;
  }
  setActive(filePath) {
    this.activeSessionFile = filePath;
    if (filePath && this.unread.has(filePath)) {
      this.unread.delete(filePath);
      this.saveUnread();
    }
    this.container.querySelectorAll(".session-item").forEach((el) => {
      const isActive = el.dataset.filePath === filePath;
      el.classList.toggle("active", isActive);
      if (isActive) {
        el.classList.remove("unread");
      }
    });

    if (this.recordRecent(filePath) && this.projects.length > 0) {
      this.render();
    }
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll(".session-item").forEach((el) => {
      el.classList.remove("active");
    });
  }

  // ═══════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════

  showWorkspaceContextMenu(event, workspace) {
    event.preventDefault();
    this.closeContextMenu();

    const isPinned = this.pinStore.isWorkspacePinned(workspace.workspaceId);
    const items = [
      {
        iconClass: "context-menu-pin-icon",
        label: isPinned ? t("sidebar.unpinWorkspace") : t("sidebar.pinWorkspace"),
        action: () => {
          this.quickInfo.close();
          if (isPinned) this.pinStore.unpinWorkspace(workspace.workspaceId);
          else this.pinStore.pinWorkspace(workspace.workspaceId, workspace.path);
        },
      },
      {
        iconKind: "folder",
        label: t("sidebar.openInFinder"),
        action: () => this.onOpenProject?.(workspace),
      },
      {
        iconKind: "archive",
        label: t("sidebar.archiveWorkspaceSessions"),
        action: () => this.archiveWorkspaceSessions(workspace),
      },
    ];

    const menu = document.createElement("div");
    menu.className = "sidebar-context-menu";
    menu.setAttribute("role", "menu");
    for (const item of items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "context-menu-item";
      row.setAttribute("role", "menuitem");

      const icon = document.createElement("span");
      icon.className = `context-menu-icon${item.iconClass ? ` ${item.iconClass}` : ""}`;
      icon.setAttribute("aria-hidden", "true");
      if (item.iconKind) icon.appendChild(createSvgIcon(item.iconKind));
      const label = document.createElement("span");
      label.textContent = item.label;
      row.append(icon, label);
      row.addEventListener("click", (clickEvent) => {
        clickEvent.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = event.clientX;
    let y = event.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    this.contextMenu = menu;
  }

  archiveWorkspaceSessions(workspace) {
    const filePaths = (workspace?.sessions || [])
      .map((session) => session?.filePath)
      .filter((filePath) => typeof filePath === "string" && filePath && !this.isArchived(filePath));
    if (filePaths.length === 0) return;
    this.archived.push(...filePaths);
    this.saveArchived();
    this.render();
  }

  closeContextMenu() {
    if (this.contextMenu) {
      this.contextMenu.remove();
      this.contextMenu = null;
    }
  }

  startRename(itemEl) {
    const titleEl = itemEl.querySelector(".session-title");
    if (!titleEl) return;
    const currentName = titleEl.textContent;

    const input = document.createElement("input");
    input.className = "session-rename-input";
    input.value = currentName;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch("/api/rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "set_session_name", name: newName }),
          });
        } catch {
          /* silent */
        }
      }
      const newTitle = document.createElement("div");
      newTitle.className = "session-title";
      newTitle.title = newName || currentName;
      newTitle.textContent = newName || currentName;
      input.replaceWith(newTitle);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") {
        ke.preventDefault();
        input.blur();
      }
      if (ke.key === "Escape") {
        input.value = currentName;
        input.blur();
      }
    });
  }

  async exportSession(_session) {
    try {
      const data = await (
        await fetch("/api/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "export_html" }),
        })
      ).json();
      if (data?.success && data.data?.path) {
        const downloadUrl = `/api/sessions/${encodeURIComponent(data.data.path)}`;
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = "";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
    } catch {
      /* silent */
    }
  }

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  buildSessionItem(session, project, options = {}) {
    const { showArchiveButton = true } = options;
    const item = document.createElement("div");
    item.className = "session-item";
    item.dataset.filePath = session.filePath;
    item.dataset.projectSearchText = this.getProjectSearchText(project);

    if (session.filePath === this.activeSessionFile) item.classList.add("active");
    if (this.unread.has(session.filePath)) item.classList.add("unread");
    if (this.streamingFiles.has(session.filePath)) item.classList.add("streaming");

    const title = session.name || session.firstMessage || t("sidebar.emptySession");
    const time = this.formatTime(session.timestamp);
    const isArchived = this.isArchived(session.filePath);
    const isPinned = this.pinStore.isSessionPinned(session.filePath);
    const pinBtnLabel = isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession");
    const archiveBtnLabel = isArchived
      ? t("sidebar.unarchiveSession")
      : t("sidebar.archiveSession");

    const titleRow = document.createElement("div");
    titleRow.className = "session-title-row";
    const titleElement = document.createElement("div");
    titleElement.className = "session-title";
    titleElement.title = title;
    titleElement.textContent = title;
    titleRow.appendChild(titleElement);
    if (session.tmux) {
      const tmuxTag = document.createElement("span");
      tmuxTag.className = "session-tag tmux-tag";
      tmuxTag.textContent = "tmux";
      titleRow.appendChild(tmuxTag);
    }
    const actionSlot = document.createElement("span");
    actionSlot.className = "session-action-slot";
    const timeElement = document.createElement("span");
    timeElement.className = "session-time";
    timeElement.textContent = time;
    actionSlot.appendChild(timeElement);
    titleRow.appendChild(actionSlot);
    item.appendChild(titleRow);

    item.addEventListener("click", () => this.onSessionSelect(session, project));
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "session-pin-btn";
    pinBtn.title = pinBtnLabel;
    pinBtn.setAttribute("aria-label", pinBtnLabel);
    pinBtn.setAttribute("aria-pressed", String(isPinned));
    const pinIcon = document.createElement("span");
    pinIcon.className = "session-pin-icon";
    pinIcon.setAttribute("aria-hidden", "true");
    pinBtn.appendChild(pinIcon);
    pinBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (isPinned) this.pinStore.unpinSession(session.filePath);
      else this.pinStore.pinSession(session.filePath);
    });
    actionSlot.appendChild(pinBtn);

    if (showArchiveButton) {
      const archiveBtn = document.createElement("button");
      archiveBtn.type = "button";
      archiveBtn.className = "session-archive-btn";
      archiveBtn.title = archiveBtnLabel;
      archiveBtn.setAttribute("aria-label", archiveBtnLabel);
      archiveBtn.appendChild(createSvgIcon("archive"));
      archiveBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleArchived(session.filePath);
      });
      actionSlot.appendChild(archiveBtn);
    }

    return item;
  }

  /**
   * Pins the latest Super Agent session at the top of the sidebar as the
   * "Agent Inbox" entry. Only the most recent session is shown; the rest of
   * the Super Agent project's history stays out of the regular project list.
   */
  buildPinnedSuperAgentGroup(pinned) {
    if (!pinned) return null;

    const group = document.createElement("div");
    group.className = "super-agent-pinned-group";
    group.dataset.projectSearchText = this.getProjectSearchText(pinned.project);

    const header = document.createElement("div");
    header.className = "project-header super-agent-pinned-header";
    const star = document.createElement("span");
    star.className = "fav-star";
    star.textContent = "★";
    const title = document.createElement("span");
    title.textContent = "Agent Inbox";
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = "Pinned";
    header.append(star, title, count);
    group.appendChild(header);

    const sessionsDiv = document.createElement("div");
    sessionsDiv.className = "project-sessions";
    sessionsDiv.appendChild(
      this.buildSessionItem(pinned.session, pinned.project, {
        showArchiveButton: false,
      }),
    );
    group.appendChild(sessionsDiv);

    return group;
  }

  getProjectVisibilityKey(project) {
    return project?.path || project?.dirName || "";
  }

  getProjectVisibleSessionCount(project, sessionCount) {
    const key = this.getProjectVisibilityKey(project);
    const stored = this.projectVisibleSessionCounts.get(key);
    if (typeof stored === "number" && Number.isFinite(stored)) {
      return Math.max(this.projectSessionInitialLimit, Math.min(sessionCount, Math.floor(stored)));
    }
    return Math.min(sessionCount, this.projectSessionInitialLimit);
  }

  setProjectVisibleSessionCount(project, sessionCount) {
    const key = this.getProjectVisibilityKey(project);
    if (!key) return;
    this.projectVisibleSessionCounts.set(
      key,
      Math.max(this.projectSessionInitialLimit, sessionCount),
    );
  }

  buildProjectSessionsToggleRow(project, visibleCount, totalCount) {
    const hasMore = visibleCount < totalCount;
    const canShowLess = visibleCount > this.projectSessionInitialLimit;
    if (!hasMore && !canShowLess) return null;

    const toggleRow = document.createElement("div");
    toggleRow.className = "project-sessions-toggle-row";

    if (hasMore) {
      const showMoreButton = document.createElement("button");
      showMoreButton.type = "button";
      showMoreButton.className = "project-sessions-toggle";
      showMoreButton.textContent = t("sidebar.showMore");
      showMoreButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setProjectVisibleSessionCount(project, visibleCount + this.projectSessionStep);
        this.render();
      });
      toggleRow.appendChild(showMoreButton);
    }

    if (canShowLess) {
      const showLessButton = document.createElement("button");
      showLessButton.type = "button";
      showLessButton.className = "project-sessions-toggle project-sessions-toggle-less";
      showLessButton.textContent = t("sidebar.showLess");
      showLessButton.addEventListener("click", (event) => {
        event.stopPropagation();
        this.setProjectVisibleSessionCount(
          project,
          Math.max(this.projectSessionInitialLimit, visibleCount - this.projectSessionStep),
        );
        this.render();
      });
      toggleRow.appendChild(showLessButton);
    }

    return toggleRow;
  }
  renderPinnedSection() {
    const state = this.pinStore.getRenderableState();
    const pinnedGroups = resolvePinnedWorkspaceGroups({
      pinState: state,
      projects: this.projects,
      archivedPaths: this.archived,
    });
    const { section } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      count: pinnedGroups.length,
      renderSessions: (body) => {
        for (const pinned of pinnedGroups) {
          const workspace = pinned.workspace;
          const unavailableFilePath = pinned.sessions[0]?.filePath || "";
          const workspacePath = workspace?.path || "";
          const folderName =
            workspace?.folderName ||
            basenameLocalPath(workspacePath) ||
            unavailableFilePath ||
            t("sidebar.unavailable");
          const workspaceId = workspace?.workspaceId || `pinned-session:${unavailableFilePath}`;
          const { group, header } = buildSidebarWorkspaceGroup({
            workspaceId,
            folderName,
            workspacePath,
            sessionCount: pinned.sessions.length,
            expanded: true,
            onNewChat:
              !pinned.unavailable && workspacePath ? () => this.onNewChat(workspacePath) : null,
            onContextMenu:
              !pinned.unavailable && workspace
                ? (event) => this.showWorkspaceContextMenu(event, workspace)
                : null,
            onMoreActions:
              !pinned.unavailable && workspace
                ? (event) => this.showWorkspaceContextMenu(event, workspace)
                : null,
            renderSessions: (container) => {
              if (pinned.unavailable) {
                const unavailable = document.createElement("div");
                unavailable.className = "pinned-unavailable";
                unavailable.textContent =
                  workspacePath || unavailableFilePath || t("sidebar.unavailable");
                container.appendChild(unavailable);

                const unpin = document.createElement("button");
                unpin.type = "button";
                unpin.textContent = pinned.workspacePin
                  ? t("sidebar.unpinWorkspace")
                  : t("sidebar.unpinSession");
                unpin.addEventListener("click", () => {
                  if (pinned.workspacePin) this.pinStore.unpinWorkspace(workspace.workspaceId);
                  else this.pinStore.unpinSession(unavailableFilePath);
                });
                container.appendChild(unpin);
                return;
              }

              for (const session of pinned.sessions) {
                container.appendChild(this.buildSessionItem(session, workspace));
              }
            },
          });
          group.classList.add("pinned-workspace-group");

          if (!pinned.unavailable && workspace) this.quickInfo.bindHeader(header, workspace);

          body.appendChild(group);
        }
      },
    });
    section.className = `pinned-group ${section.className}`;
    this.container.appendChild(section);
  }

  render({ preserveQuickInfo = false } = {}) {
    const recentSessions = this.resolveRecentSessions();

    const pinnedSuperAgent = isSuperAgentEnabled()
      ? getSuperAgentProject(this.projects, this.superAgentPath)
      : null;
    const pinnedSessionFile = pinnedSuperAgent?.session?.filePath || null;

    this.container.replaceChildren();
    this.quickInfo.clearHeaders({ preserveCard: preserveQuickInfo });
    this.quickInfo.setWorkspaces(this.projects);

    const pinnedSuperAgentGroup = this.buildPinnedSuperAgentGroup(pinnedSuperAgent);
    if (pinnedSuperAgentGroup) {
      this.container.appendChild(pinnedSuperAgentGroup);
    }

    const archivedSessions = [];
    for (const project of this.projects) {
      const isSuperAgentProject = isSuperAgentProjectPath(project.path, this.superAgentPath);
      for (const session of project.sessions || []) {
        if (session.filePath === pinnedSessionFile || isSuperAgentProject) continue;
        if (this.isArchived(session.filePath)) archivedSessions.push({ session, project });
      }
    }

    if (recentSessions.length > 0) {
      const recentGroup = document.createElement("div");
      recentGroup.className = "recent-group";

      const header = document.createElement("div");
      header.className = `project-header recent-header${this.recentCollapsed ? " collapsed" : ""}`;
      header.setAttribute("role", "button");
      header.tabIndex = 0;
      header.setAttribute("aria-expanded", String(!this.recentCollapsed));
      const chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.textContent = "▼";
      const label = document.createElement("span");
      label.textContent = t("sidebar.recent");
      header.append(chevron, label);
      recentGroup.appendChild(header);

      const sessionsDiv = document.createElement("div");
      sessionsDiv.className = `project-sessions${this.recentCollapsed ? " collapsed" : ""}`;
      for (const { session, project } of recentSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }

      const toggleRecent = () => {
        this.recentCollapsed = !this.recentCollapsed;
        header.classList.toggle("collapsed", this.recentCollapsed);
        header.setAttribute("aria-expanded", String(!this.recentCollapsed));
        sessionsDiv.classList.toggle("collapsed", this.recentCollapsed);
      };
      header.addEventListener("click", toggleRecent);
      header.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggleRecent();
      });

      recentGroup.appendChild(sessionsDiv);
      this.container.appendChild(recentGroup);
    }
    this.renderPinnedSection();

    const { section: projectsSection, sessionsContainer: projectsGroup } = buildSidebarSection({
      region: "projects",
      titleKey: "sidebar.projects",
      count: this.projects.length,
    });
    projectsSection.className = `projects-group ${projectsSection.className}`;
    for (const project of this.projects) {
      if (isSuperAgentProjectPath(project.path, this.superAgentPath)) continue;
      const visibleSessions = (project.sessions || []).filter(
        (session) => session.filePath !== pinnedSessionFile && !this.isArchived(session.filePath),
      );
      const visibleCount = this.getProjectVisibleSessionCount(project, visibleSessions.length);
      const sessionsToRender = this.searchQuery
        ? visibleSessions
        : visibleSessions.slice(0, visibleCount);
      const projectKey = this.getProjectVisibilityKey(project);
      const { group, header } = buildSidebarWorkspaceGroup({
        workspaceId: project.workspaceId,
        folderName:
          project.folderName ||
          basenameLocalPath(project.path) ||
          project.path ||
          t("sidebar.unavailable"),
        workspacePath: project.path,
        sessionCount: visibleSessions.length,
        expanded: !this.collapsedProjects.has(projectKey),
        onToggle: (expanded) => {
          if (expanded) this.collapsedProjects.delete(projectKey);
          else this.collapsedProjects.add(projectKey);
        },
        onNewChat: this.onNewChat ? () => this.onNewChat(project) : null,
        onContextMenu: (event) => this.showWorkspaceContextMenu(event, project),
        onMoreActions: (event) => this.showWorkspaceContextMenu(event, project),
        renderSessions: (sessionsDiv) => {
          for (const session of sessionsToRender) {
            sessionsDiv.appendChild(this.buildSessionItem(session, project));
          }
          if (!this.searchQuery) {
            const toggleRow = this.buildProjectSessionsToggleRow(
              project,
              sessionsToRender.length,
              visibleSessions.length,
            );
            if (toggleRow) sessionsDiv.appendChild(toggleRow);
          }
        },
      });
      group.dataset.projectSearchText = this.getProjectSearchText(project);
      projectsGroup.appendChild(group);
      this.quickInfo.bindHeader(header, project);
    }
    this.container.appendChild(projectsSection);

    {
      archivedSessions.sort((a, b) => {
        const aCreated = a.session.timestamp
          ? new Date(a.session.timestamp).getTime()
          : a.session.ctime || 0;
        const bCreated = b.session.timestamp
          ? new Date(b.session.timestamp).getTime()
          : b.session.ctime || 0;
        return bCreated - aCreated;
      });
      const archivedGroup = document.createElement("div");
      archivedGroup.className = "archived-group";

      const header = document.createElement("div");
      header.className = `project-header archived-header${this.archivedCollapsed ? " collapsed" : ""}`;
      const archivedChevron = document.createElement("span");
      archivedChevron.className = "chevron";
      archivedChevron.textContent = "▼";
      const archivedLabel = document.createElement("span");
      archivedLabel.textContent = t("sidebar.archived");
      const archivedCount = document.createElement("span");
      archivedCount.className = "project-count";
      archivedCount.textContent = String(archivedSessions.length);
      const deleteAllBtn = document.createElement("button");
      deleteAllBtn.type = "button";
      deleteAllBtn.className = "archived-delete-all-btn";
      deleteAllBtn.title = t("sidebar.deleteAllArchived");
      deleteAllBtn.setAttribute("aria-label", t("sidebar.deleteAllArchived"));
      deleteAllBtn.appendChild(createSvgIcon("trash"));
      header.append(archivedChevron, archivedLabel, archivedCount, deleteAllBtn);
      archivedGroup.appendChild(header);

      deleteAllBtn.hidden = archivedSessions.length === 0;
      deleteAllBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteAllArchived();
      });

      const sessionsDiv = document.createElement("div");
      sessionsDiv.className = `project-sessions${this.archivedCollapsed ? " collapsed" : ""}`;
      for (const { session, project } of archivedSessions) {
        sessionsDiv.appendChild(
          this.buildSessionItem(session, project, { showArchiveButton: false }),
        );
      }

      header.addEventListener("click", () => {
        this.archivedCollapsed = !this.archivedCollapsed;
        this.saveArchivedCollapsed();
        header.classList.toggle("collapsed", this.archivedCollapsed);
        sessionsDiv.classList.toggle("collapsed", this.archivedCollapsed);
      });

      archivedGroup.appendChild(sessionsDiv);
      this.container.appendChild(archivedGroup);
    }

    const nonSuperAgentProjects = this.projects.filter(
      (project) => !isSuperAgentProjectPath(project.path, this.superAgentPath),
    );
    const pinState = this.pinStore.getRenderableState();
    if (
      !pinnedSuperAgent &&
      nonSuperAgentProjects.length === 0 &&
      recentSessions.length === 0 &&
      archivedSessions.length === 0 &&
      pinState.workspaces.length === 0 &&
      pinState.sessions.length === 0
    ) {
      this.renderEmptyState({ append: true });
    }

    if (this.searchQuery) this.applySearch();
  }

  renderEmptyState({ append = false } = {}) {
    const empty = document.createElement("div");
    empty.className = "session-empty-state";
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "session-empty-open-project";
    openButton.title = t("sidebar.openProject");
    openButton.setAttribute("aria-label", t("sidebar.openProject"));
    openButton.textContent = t("sidebar.openProject");
    openButton.addEventListener("click", () => this.onOpenProject?.());
    empty.appendChild(openButton);
    if (append) this.container.appendChild(empty);
    else this.container.replaceChildren(empty);
  }

  getProjectSearchText(project) {
    const path = typeof project?.path === "string" ? project.path : "";
    const dirName = typeof project?.dirName === "string" ? project.dirName : "";
    const shortPath = basenameLocalPath(path) || path;
    return [shortPath, dirName, path].join(" ").toLowerCase();
  }

  formatTime(isoTimestamp) {
    try {
      const date = new Date(isoTimestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const days = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return t("sidebar.justNow");
      if (diffMins < 60) return t("sidebar.minutesAgo", { minutes: diffMins });
      if (diffHours < 24) return t("sidebar.hoursAgo", { hours: diffHours });
      if (days === 1) return t("sidebar.yesterday");
      if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
      return date.toLocaleDateString([], { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }
}
