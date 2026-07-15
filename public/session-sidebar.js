/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

import { onLocaleChange, t } from "./i18n.js";
import { createPinnedItemsStore } from "./pinned-items.js";
import { readRecentSessions, recordRecentSession, writeRecentSessions } from "./recent-sessions.js";
import { buildSidebarSection, buildSidebarWorkspaceGroup } from "./sidebar-workspace-group.js";
import { mergeWorkspaceProjects, resolvePinnedWorkspaceGroups } from "./workspace-projects.js";
import { WorkspaceQuickInfo } from "./workspace-quick-info.js";

export class SessionSidebar {
  constructor(container, onSessionSelect, onNewChat, options = {}) {
    this.projectSessionInitialLimit = 5;
    this.projectSessionStep = 10;
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.onNewChat = onNewChat;
    this.onOpenProject = options.onOpenProject || null;
    this.activeSessionFile = null;
    this.projects = [];
    this.collapsedProjects = new Set();
    this.searchQuery = "";
    this.recent = readRecentSessions();
    this.recentCollapsed = false;
    this.archived = JSON.parse(localStorage.getItem("pi-studio-archived") || "[]");
    this.archivedCollapsed = localStorage.getItem("pi-studio-archived-collapsed") !== "false";
    this.unread = new Set(JSON.parse(localStorage.getItem("pi-studio-unread") || "[]"));
    this.pinStore = options.pinStore || createPinnedItemsStore();
    this.quickInfo = options.quickInfo || new WorkspaceQuickInfo({ pinStore: this.pinStore });
    this.unsubscribePinStore =
      this.pinStore.subscribe?.(() => this.render({ preserveQuickInfo: true })) || null;
    this.pinStore.migrateLegacyFavourites?.({ excludedSessions: this.archived });
    this.streamingFiles = new Set();
    this.projectVisibleSessionCounts = new Map();
    this.contextMenu = null;
    this.sessionItemData = new WeakMap();
    this.onSessionItemContextMenu = (event) => {
      const item = event.target.closest?.(".session-item");
      if (!item || !this.container.contains(item)) return;
      const data = this.sessionItemData.get(item);
      if (data) this.showContextMenu(event, data.session, data.project, item);
    };
    this.container.addEventListener("contextmenu", this.onSessionItemContextMenu);
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
      // Close if right-clicking outside a session item
      if (!e.target.closest(".session-item")) this.closeContextMenu();
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
      overlay.innerHTML = `
        <div class="sidebar-confirm-dialog" role="dialog" aria-modal="true" aria-label="${this.escapeHtml(t("sidebar.deleteArchivedAriaLabel"))}">
          <div class="sidebar-confirm-message">${this.escapeHtml(message)}</div>
          <div class="sidebar-confirm-actions">
            <button type="button" class="sidebar-confirm-no">${this.escapeHtml(t("actions.cancel"))}</button>
            <button type="button" class="sidebar-confirm-yes">${this.escapeHtml(t("actions.delete"))}</button>
          </div>
        </div>
      `;

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
      this.container.innerHTML = Array.from(
        { length: 6 },
        () =>
          '<div class="session-skeleton"><div class="session-skeleton-title"></div><div class="session-skeleton-meta"></div></div>',
      ).join("");
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
    const retryLabel = this.escapeHtml(t("sidebar.retry"));
    this.container.innerHTML = `<div class="session-loading">${this.escapeHtml(message)} <button class="retry-link" id="retry-load-sessions">${retryLabel}</button></div>`;
    const retryBtn = this.container.querySelector("#retry-load-sessions");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => this.loadSessions());
    }
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
    header.innerHTML = `<span>🔍</span> <span>${this.escapeHtml(t("sidebar.messageMatches"))}</span> <span class="project-count">${this._searchResults.length}</span>`;
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

      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        </div>
        <div class="search-snippet">${this.highlightMatch(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${this.escapeHtml(t("sidebar.matchCount", { count: matchCount }))}` : ""}</div>
      `;

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
    if (!query) return this.escapeHtml(text);
    const escaped = this.escapeHtml(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return escaped.replace(re, "<mark>$1</mark>");
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

  showContextMenu(e, session, _project, _itemEl) {
    e.preventDefault();
    this.closeContextMenu();

    const menu = document.createElement("div");
    menu.className = "session-context-menu";

    const isArchived = this.isArchived(session.filePath);
    const isPinned = this.pinStore.isSessionPinned(session.filePath);
    const items = [
      {
        icon: isPinned ? "📌" : "📍",
        label: isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession"),
        action: () => {
          if (isPinned) this.pinStore.unpinSession(session.filePath);
          else this.pinStore.pinSession(session.filePath);
        },
      },
      {
        icon: isArchived ? "📤" : "🗄️",
        label: isArchived ? t("sidebar.unarchive") : t("sidebar.archive"),
        action: () => this.toggleArchived(session.filePath),
      },
    ];

    for (const item of items) {
      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${this.escapeHtml(item.label)}`;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        item.action();
      });
      menu.appendChild(row);
    }

    // Position
    document.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    let x = e.clientX;
    let y = e.clientY;
    if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 8;
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    this.contextMenu = menu;
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
        window.open(`/api/sessions/${encodeURIComponent(data.data.path)}`);
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

    if (session.filePath === this.activeSessionFile) {
      item.classList.add("active");
    }
    if (this.unread.has(session.filePath)) {
      item.classList.add("unread");
    }
    if (this.streamingFiles.has(session.filePath)) {
      item.classList.add("streaming");
    }

    const title = session.name || session.firstMessage || t("sidebar.emptySession");
    const time = this.formatTime(session.timestamp);
    const tmuxTag = session.tmux ? '<span class="session-tag tmux-tag">tmux</span>' : "";
    const isArchived = this.isArchived(session.filePath);
    const archiveBtnLabel = isArchived
      ? t("sidebar.unarchiveSession")
      : t("sidebar.archiveSession");
    const archiveBtnIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="4" width="18" height="4" rx="1.5"></rect>
        <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"></path>
        <path d="M10 12h4"></path>
      </svg>
    `;

    const archiveButtonHtml = showArchiveButton
      ? `<button class="session-archive-btn" title="${this.escapeHtml(archiveBtnLabel)}" aria-label="${this.escapeHtml(archiveBtnLabel)}">${archiveBtnIcon}</button>`
      : "";

    item.innerHTML = `
      <div class="session-title-row">
        <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        ${tmuxTag}
        <span class="session-action-slot">
          <span class="session-time">${time}</span>
          ${archiveButtonHtml}
        </span>
      </div>
    `;

    this.sessionItemData.set(item, { session, project });
    item.addEventListener("click", () => this.onSessionSelect(session, project));
    const archiveBtn = item.querySelector(".session-archive-btn");
    if (archiveBtn) {
      archiveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleArchived(session.filePath);
      });
    }

    return item;
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
            workspacePath.split("/").filter(Boolean).at(-1) ||
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

          if (pinned.workspacePin && !pinned.unavailable) {
            const unpin = document.createElement("button");
            unpin.type = "button";
            unpin.className = "pinned-workspace-unpin";
            unpin.textContent = t("sidebar.unpinWorkspace");
            unpin.addEventListener("click", () =>
              this.pinStore.unpinWorkspace(workspace.workspaceId),
            );
            header.appendChild(unpin);
          }

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

    this.container.innerHTML = "";
    this.quickInfo.clearHeaders({ preserveCard: preserveQuickInfo });
    this.quickInfo.setWorkspaces(this.projects);

    const archivedSessions = [];
    for (const project of this.projects) {
      for (const session of project.sessions || []) {
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
      header.innerHTML = `
        <span class="chevron">▼</span>
        <span>${this.escapeHtml(t("sidebar.recent"))}</span>
      `;
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
      const visibleSessions = (project.sessions || []).filter(
        (session) => !this.isArchived(session.filePath),
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
          project.path?.split("/").filter(Boolean).at(-1) ||
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
      header.innerHTML = `
        <span class="chevron">▼</span>
        <span>${this.escapeHtml(t("sidebar.archived"))}</span>
        <span class="project-count">${archivedSessions.length}</span>
        <button class="archived-delete-all-btn" title="${this.escapeHtml(t("sidebar.deleteAllArchived"))}" aria-label="${this.escapeHtml(t("sidebar.deleteAllArchived"))}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
            <path d="M10 11v6"></path>
            <path d="M14 11v6"></path>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
          </svg>
        </button>
      `;
      archivedGroup.appendChild(header);

      const deleteAllBtn = header.querySelector(".archived-delete-all-btn");
      if (deleteAllBtn) {
        deleteAllBtn.hidden = archivedSessions.length === 0;
        deleteAllBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.deleteAllArchived();
        });
      }

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

    const pinState = this.pinStore.getRenderableState();
    if (
      this.projects.length === 0 &&
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
    const pathParts = path.split("/").filter(Boolean);
    const shortPath = pathParts.length > 0 ? pathParts[pathParts.length - 1] : path;
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

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}
