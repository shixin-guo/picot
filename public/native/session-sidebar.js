import { isSuperAgentProjectPath } from "../super-agent/session.js";
import { isSuperAgentEnabled } from "../super-agent/settings.js";
import { randomId } from "./random-id.js";

// Rich session sidebar for the native host runtime.
//
// Ported from the legacy `public/sidebar/index.js` visual/interaction layer,
// but re-wired onto the native gateways:
//   - listing        → HostDataGateway.listSessions(workspaceId)   (flat list)
//   - full-text search→ HostDataGateway.searchSessions(workspaceId, query)
//   - rename          → RuntimeGateway.request({ type: "set_session_name" })
//   - selection       → navigate to the session route (page re-bootstraps)
//   - streaming/unread→ driven by the caller from runtime_event frames
//
// Sessions from every project are listed via HostDataGateway.listAllSessions and
// grouped by project: favourites → current project → other projects → archived.
// Selecting a session in the current project navigates in-window; selecting one
// from another project opens (or focuses) that project's workspace window at the
// session (native `open_session_in_project` command). Favourites / archived /
// unread / per-project collapse state are local-only (localStorage), keyed by
// the globally-unique session id or project path.

const INITIAL_LIMIT = 8;
const STEP = 10;
const LOAD_RETRY_DELAYS_MS = [250, 750, 1500];

const STORAGE = {
  favourites: "picot-favourites",
  archived: "picot-archived",
  archivedCollapsed: "picot-archived-collapsed",
  projectsCollapsed: "picot-projects-collapsed",
  sessionCache: "picot-session-list-cache",
  latestSessionCache: "picot-session-list-cache:latest",
  unread: "picot-unread",
};

function readObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

function readArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function sessionCacheKey(workspaceId) {
  return `${STORAGE.sessionCache}:${workspaceId}`;
}

function readSessionCache(workspaceId, activeSessionId) {
  try {
    const workspaceValue = JSON.parse(localStorage.getItem(sessionCacheKey(workspaceId)) || "[]");
    if (Array.isArray(workspaceValue) && workspaceValue.length > 0) return workspaceValue;
    const latestValue = JSON.parse(localStorage.getItem(STORAGE.latestSessionCache) || "[]");
    return Array.isArray(latestValue) ? rebaseCachedSessions(latestValue, activeSessionId) : [];
  } catch {
    return [];
  }
}

function writeSessionCache(workspaceId, sessions) {
  try {
    localStorage.setItem(sessionCacheKey(workspaceId), JSON.stringify(sessions));
    localStorage.setItem(STORAGE.latestSessionCache, JSON.stringify(sessions));
  } catch {
    // Cache writes are best-effort; private browsing/quota issues should not
    // affect the live sidebar.
  }
}

function rebaseCachedSessions(sessions, activeSessionId) {
  const active = sessions.find((session) => session?.id === activeSessionId);
  const activeProjectPath = active?.projectPath;
  if (!activeProjectPath) return sessions;
  return sessions.map((session) => ({
    ...session,
    isCurrentWorkspace: session?.projectPath === activeProjectPath,
  }));
}

function sessionListSignature(sessions) {
  return JSON.stringify(
    (sessions ?? []).map((session) => ({
      id: session?.id ?? null,
      name: session?.name ?? null,
      firstMessage: session?.firstMessage ?? null,
      timestamp: session?.timestamp ?? null,
      modifiedAtMs: session?.modifiedAtMs ?? null,
      projectPath: session?.projectPath ?? null,
      projectName: session?.projectName ?? null,
      isCurrentWorkspace: session?.isCurrentWorkspace === true,
      kind: session?.kind ?? null,
      status: session?.status ?? null,
      state: session?.state ?? null,
      isWorking: session?.isWorking === true,
      unread: session?.unread === true,
      hasUnread: session?.hasUnread === true,
      target: session?.target ?? null,
    })),
  );
}

function cssEscape(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  // jsdom / older engines: session ids are UUIDs, so a conservative escape is safe.
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

function isWorkingSession(session) {
  return (
    session?.status === "working" || session?.state === "working" || session?.isWorking === true
  );
}

function hasLiveStatus(session) {
  return session?.status != null || session?.state != null || session?.isWorking != null;
}

function isUnreadSession(session) {
  return session?.unread === true || session?.hasUnread === true;
}

function sessionTimeMs(session) {
  const modified = Number(session?.modifiedAtMs);
  if (Number.isFinite(modified) && modified > 0) return modified;
  const parsed = Date.parse(session?.timestamp || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function asPinnedSuperAgentSession(session) {
  if (!session) return null;
  return {
    ...session,
    kind: "super-agent",
    name: "Agent Inbox",
    projectName: "Agent Inbox",
  };
}

function latestSession(sessions) {
  return [...sessions].sort((left, right) => sessionTimeMs(right) - sessionTimeMs(left))[0] ?? null;
}

export function formatSessionTime(isoTimestamp) {
  if (!isoTimestamp) return "";
  try {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) return "";
    const diffMs = Date.now() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (days === 1) return "Yesterday";
    if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

const ARCHIVE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <rect x="3" y="4" width="18" height="4" rx="1.5"></rect>
    <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"></path>
    <path d="M10 12h4"></path>
  </svg>`;

const TRASH_ICON = `
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <polyline points="3 6 5 6 21 6"></polyline>
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
    <path d="M10 11v6"></path>
    <path d="M14 11v6"></path>
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
  </svg>`;

export class SessionSidebar {
  constructor(
    container,
    { data, runtime, control, getTarget, onSelect, onCreateSession, onSessionsLoaded },
  ) {
    this.container = container;
    this.data = data;
    this.runtime = runtime;
    this.control = control;
    this.getTarget = getTarget;
    this.onSelect = onSelect;
    this.onCreateSession = onCreateSession;
    this.onSessionsLoaded = onSessionsLoaded;

    this.sessions = [];
    this.activeSessionId = getTarget()?.sessionId ?? null;
    this.favourites = readArray(STORAGE.favourites);
    this.archived = readArray(STORAGE.archived);
    this.archivedCollapsed = localStorage.getItem(STORAGE.archivedCollapsed) !== "false";
    this.projectsCollapsed = readObject(STORAGE.projectsCollapsed);
    this.unread = new Set(readArray(STORAGE.unread));
    this.streaming = new Set();

    this.searchQuery = "";
    this._searchResults = null;
    this._searchTimer = null;
    this._visibleCount = INITIAL_LIMIT;
    this._loadSeq = 0;
    this._loadCommitted = 0;
    this.contextMenu = null;

    document.addEventListener("click", () => this.closeContextMenu());
  }

  // ── persistence ────────────────────────────────────────────────
  #save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  isFavourite(id) {
    return this.favourites.includes(id);
  }
  isArchived(id) {
    return this.archived.includes(id);
  }
  toggleFavourite(id) {
    const idx = this.favourites.indexOf(id);
    if (idx >= 0) this.favourites.splice(idx, 1);
    else this.favourites.push(id);
    this.#save(STORAGE.favourites, this.favourites);
    this.render();
  }
  toggleArchived(id) {
    const idx = this.archived.indexOf(id);
    if (idx >= 0) this.archived.splice(idx, 1);
    else this.archived.push(id);
    this.#save(STORAGE.archived, this.archived);
    this.render();
  }

  archiveProject(project) {
    const ids = this.sessions
      .filter(
        (session) =>
          session.projectPath === project.path && !isSuperAgentProjectPath(session.projectPath),
      )
      .map((session) => session.id);
    if (ids.length === 0) return;

    const projectIds = new Set(ids);
    this.archived = [...new Set([...this.archived, ...ids])];
    this.favourites = this.favourites.filter((id) => !projectIds.has(id));
    this.#save(STORAGE.archived, this.archived);
    this.#save(STORAGE.favourites, this.favourites);
    this.render();
  }

  // Permanently deletes every archived session from disk (after a confirm
  // dialog) and drops the successfully-deleted ids from local state + the
  // in-memory session list.
  async deleteAllArchived() {
    const ids = [...this.archived];
    if (ids.length === 0 || !this.control) return;
    const ok = await this.#confirmArchivedDeletion(ids.length);
    if (!ok) return;
    try {
      const { deleted } = await this.control.deleteSessions(ids);
      const deletedSet = new Set(deleted);
      this.archived = this.archived.filter((id) => !deletedSet.has(id));
      this.#save(STORAGE.archived, this.archived);
      this.sessions = this.sessions.filter((session) => !deletedSet.has(session.id));
      this.render();
    } catch (error) {
      console.error("[Sidebar] deleteAllArchived failed:", error);
    }
  }

  #confirmArchivedDeletion(count) {
    const message = `Delete ${count} archived session${count === 1 ? "" : "s"} permanently? This cannot be undone.`;
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "sidebar-confirm-overlay";
      overlay.innerHTML = `
        <div class="sidebar-confirm-dialog" role="dialog" aria-modal="true" aria-label="Delete archived sessions">
          <div class="sidebar-confirm-message">${escapeHtml(message)}</div>
          <div class="sidebar-confirm-actions">
            <button type="button" class="sidebar-confirm-no">Cancel</button>
            <button type="button" class="sidebar-confirm-yes">Delete</button>
          </div>
        </div>`;

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

  // ── status indicators (driven by the caller) ───────────────────
  setActive(sessionId) {
    this.activeSessionId = sessionId;
    if (sessionId && this.unread.has(sessionId)) {
      this.unread.delete(sessionId);
      this.#save(STORAGE.unread, [...this.unread]);
    }
    this.container.querySelectorAll(".session-item").forEach((el) => {
      const isActive = el.dataset.sessionId === sessionId;
      el.classList.toggle("active", isActive);
      if (isActive) el.classList.remove("unread");
    });
  }
  markUnread(id) {
    if (!id || id === this.activeSessionId || this.unread.has(id)) return;
    this.unread.add(id);
    this.#save(STORAGE.unread, [...this.unread]);
    this.#applyStatus(id);
  }
  markRead(id) {
    if (!id || !this.unread.has(id)) return;
    this.unread.delete(id);
    this.#save(STORAGE.unread, [...this.unread]);
    this.#applyStatus(id);
  }
  setStreaming(id, streaming) {
    if (!id) return;
    const had = this.streaming.has(id);
    if (streaming && !had) this.streaming.add(id);
    else if (!streaming && had) this.streaming.delete(id);
    else return;
    this.#applyStatus(id);
  }
  clearStreaming() {
    if (this.streaming.size === 0) return;
    const ids = [...this.streaming];
    this.streaming.clear();
    ids.forEach((id) => {
      this.#applyStatus(id);
    });
  }
  #applyStatus(id) {
    this.container
      .querySelectorAll(`.session-item[data-session-id="${cssEscape(id)}"]`)
      .forEach((el) => {
        el.classList.toggle("unread", this.unread.has(id));
        el.classList.toggle("streaming", this.streaming.has(id));
        el.classList.toggle("mirror-live", this.streaming.has(id));
      });
  }

  // ── loading ─────────────────────────────────────────────────────
  async load({ quiet = false, retryAttempt = 0 } = {}) {
    const seq = ++this._loadSeq;
    const workspaceId = this.getTarget()?.workspaceId;
    if (!workspaceId) return;
    let renderedFromCache = false;
    if (!quiet && this.sessions.length === 0) {
      const cachedSessions = readSessionCache(workspaceId, this.activeSessionId);
      if (cachedSessions.length > 0) {
        this.sessions = cachedSessions;
        this.#hydrateStatuses(this.sessions);
        this.onSessionsLoaded?.(this.sessions);
        this.render();
        renderedFromCache = true;
      }
    }
    if (!quiet && this.sessions.length === 0) {
      this.container.innerHTML = Array.from(
        { length: 6 },
        () => '<div class="session-skeleton"><div class="session-skeleton-title"></div></div>',
      ).join("");
    }
    const previousSignature = sessionListSignature(this.sessions);
    try {
      const response = await this.data.listAllSessions(workspaceId);
      if (seq < this._loadCommitted) return;
      this._loadCommitted = seq;
      const nextSessions = response.sessions ?? [];
      const changed = sessionListSignature(nextSessions) !== previousSignature;
      this.sessions = nextSessions;
      this.#hydrateStatuses(this.sessions);
      writeSessionCache(workspaceId, this.sessions);
      this.onSessionsLoaded?.(this.sessions);
      if (changed || (!quiet && !renderedFromCache)) this.render();
    } catch (error) {
      if (seq < this._loadCommitted) return;
      const retryDelay = LOAD_RETRY_DELAYS_MS[retryAttempt];
      if (retryDelay != null) {
        console.warn("[Sidebar] Session load failed; retrying:", error);
        if (!quiet && this.sessions.length === 0) {
          this.container.innerHTML = '<div class="session-loading">Loading sessions...</div>';
        }
        setTimeout(() => {
          if (seq === this._loadSeq) {
            this.load({ quiet: true, retryAttempt: retryAttempt + 1 });
          }
        }, retryDelay);
        return;
      }
      console.error("[Sidebar] Failed to load sessions:", error);
      if (this.sessions.length > 0) return;
      this.container.innerHTML =
        '<div class="session-loading">Failed to load sessions. <button class="retry-link" id="retry-load-sessions">Retry</button></div>';
      this.container
        .querySelector("#retry-load-sessions")
        ?.addEventListener("click", () => this.load());
    }
  }

  // ── search ──────────────────────────────────────────────────────
  setSearchQuery(query) {
    this.searchQuery = (query || "").toLowerCase().trim();
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (!this.searchQuery) {
      this._searchResults = null;
      this.applySearch();
      return;
    }
    this.applySearch();
    if (this.searchQuery.length >= 2) {
      this._searchTimer = setTimeout(() => this.#fullTextSearch(this.searchQuery), 300);
    }
  }

  async #fullTextSearch(query) {
    if (query !== this.searchQuery) return;
    const workspaceId = this.getTarget()?.workspaceId;
    if (!workspaceId) return;
    try {
      const response = await this.data.searchSessions(workspaceId, query);
      if (query !== this.searchQuery) return;
      this._searchResults = response.results ?? [];
      this.#renderSearchResults();
    } catch (error) {
      console.error("[Sidebar] Search failed:", error);
    }
  }

  #renderSearchResults() {
    if (!this._searchResults || this._searchResults.length === 0) return;
    this.container.querySelector(".search-results-group")?.remove();

    const group = document.createElement("div");
    group.className = "search-results-group";
    const header = document.createElement("div");
    header.className = "project-header search-results-header";
    header.innerHTML = `<span>🔍</span> <span>Message matches</span> <span class="project-count">${this._searchResults.length}</span>`;
    group.appendChild(header);

    const sessionsDiv = document.createElement("div");
    sessionsDiv.className = "project-sessions";
    for (const result of this._searchResults) {
      const item = document.createElement("div");
      item.className = "session-item search-result-item";
      item.dataset.sessionId = result.sessionId;
      if (result.sessionId === this.activeSessionId) item.classList.add("active");
      const title = result.sessionName || result.firstMessage || "Untitled";
      const snippet = result.matches?.[0]?.snippet || "";
      const matchCount = result.matches?.length ?? 0;
      const time = formatSessionTime(result.sessionTimestamp);
      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        </div>
        <div class="search-snippet">${this.#highlight(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${matchCount} matches` : ""}</div>`;
      item.addEventListener("click", () =>
        this.onSelect({ id: result.sessionId, isCurrentWorkspace: true }),
      );
      sessionsDiv.appendChild(item);
    }
    group.appendChild(sessionsDiv);
    this.container.insertBefore(group, this.container.firstChild);
  }

  #highlight(text, query) {
    const escaped = escapeHtml(text);
    if (!query) return escaped;
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    return escaped.replace(re, "<mark>$1</mark>");
  }

  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll(".session-item").forEach((el) => {
        el.classList.remove("hidden");
      });
      this.container
        .querySelectorAll(".favourites-group, .project-group, .archived-group")
        .forEach((el) => {
          el.style.display = "";
        });
      this.container.querySelector(".search-results-group")?.remove();
      return;
    }
    this.container
      .querySelectorAll(".favourites-group, .project-group, .archived-group")
      .forEach((group) => {
        let hasVisible = false;
        group.querySelectorAll(".session-item").forEach((item) => {
          const title = (item.querySelector(".session-title")?.textContent || "").toLowerCase();
          const matches = title.includes(this.searchQuery);
          item.classList.toggle("hidden", !matches);
          if (matches) hasVisible = true;
        });
        group.style.display = hasVisible ? "" : "none";
      });
  }

  #hydrateStatuses(sessions) {
    for (const session of sessions) {
      if (!session?.id) continue;
      if (isWorkingSession(session)) this.streaming.add(session.id);
      else if (hasLiveStatus(session)) this.streaming.delete(session.id);

      if (isUnreadSession(session) && session.id !== this.activeSessionId)
        this.unread.add(session.id);
      else if (session.id === this.activeSessionId) this.unread.delete(session.id);
    }
    this.#save(STORAGE.unread, [...this.unread]);
  }

  // ── item + section builders ─────────────────────────────────────
  #buildItem(session, { showArchiveButton = true } = {}) {
    const item = document.createElement("div");
    item.className = "session-item";
    item.dataset.sessionId = session.id;
    if (session.id === this.activeSessionId) item.classList.add("active");
    if (this.unread.has(session.id)) item.classList.add("unread");
    if (this.streaming.has(session.id)) item.classList.add("streaming", "mirror-live");

    const title = session.name || session.firstMessage || "Empty session";
    const isArchived = this.isArchived(session.id);
    const archiveLabel = isArchived ? "Unarchive session" : "Archive session";
    const archiveBtn = showArchiveButton
      ? `<button class="session-archive-btn" title="${archiveLabel}" aria-label="${archiveLabel}">${ARCHIVE_ICON}</button>`
      : "";

    item.innerHTML = `
      <div class="session-title-row">
        <div class="session-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        ${archiveBtn ? `<span class="session-action-slot">${archiveBtn}</span>` : ""}
      </div>`;

    item.addEventListener("click", () => this.onSelect(session));
    item.addEventListener("contextmenu", (event) => this.#showContextMenu(event, session));
    item.querySelector(".session-archive-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.toggleArchived(session.id);
    });
    return item;
  }

  #sectionHeader(className, innerHtml) {
    const header = document.createElement("div");
    header.className = `project-header ${className}`;
    header.innerHTML = innerHtml;
    return header;
  }

  render() {
    this.container.innerHTML = "";
    if (this.sessions.length === 0) {
      this.container.innerHTML = '<div class="session-loading">No saved sessions</div>';
      return;
    }

    const superAgentEnabled = isSuperAgentEnabled();
    const superAgentSessions = this.sessions.filter((session) =>
      isSuperAgentProjectPath(session.projectPath),
    );
    const pinnedSuperAgent = superAgentEnabled
      ? asPinnedSuperAgentSession(latestSession(superAgentSessions))
      : null;
    const pinnedSuperAgentId = pinnedSuperAgent?.id ?? null;

    if (pinnedSuperAgent) {
      this.container.appendChild(this.#buildPinnedSuperAgentGroup(pinnedSuperAgent));
    }

    const favourites = [];
    const archived = [];
    const regular = [];
    for (const session of this.sessions) {
      if (isSuperAgentProjectPath(session.projectPath)) continue;
      if (this.isArchived(session.id)) archived.push(session);
      else if (this.isFavourite(session.id)) favourites.push(session);
      else regular.push(session);
    }

    if (
      !pinnedSuperAgentId &&
      favourites.length === 0 &&
      archived.length === 0 &&
      regular.length === 0
    ) {
      this.container.innerHTML = '<div class="session-loading">No saved sessions</div>';
      return;
    }

    // Favourites
    if (favourites.length > 0) {
      const group = document.createElement("div");
      group.className = "favourites-group";
      group.appendChild(
        this.#sectionHeader(
          "favourites-header",
          `<span class="fav-star">★</span> <span>Favourites</span> <span class="project-count">${favourites.length}</span>`,
        ),
      );
      const list = document.createElement("div");
      list.className = "project-sessions";
      favourites.forEach((s) => {
        list.appendChild(this.#buildItem(s));
      });
      group.appendChild(list);
      this.container.appendChild(group);
    }

    // Regular sessions, grouped by project in the list's existing recency order.
    for (const project of this.#groupByProject(regular)) {
      this.container.appendChild(this.#buildProjectGroup(project));
    }

    // Archived
    if (archived.length > 0) {
      const group = document.createElement("div");
      group.className = "archived-group";
      const header = this.#sectionHeader(
        `archived-header${this.archivedCollapsed ? " collapsed" : ""}`,
        `<span class="chevron folder-icon">
          <svg class="folder-closed-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
          <svg class="folder-open-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
        </span>
        <span>Archived</span>
        <span class="project-count">${archived.length}</span>
        <button class="archived-delete-all-btn" title="Delete all archived sessions" aria-label="Delete all archived sessions">${TRASH_ICON}</button>`,
      );
      const list = document.createElement("div");
      list.className = `project-sessions${this.archivedCollapsed ? " collapsed" : ""}`;
      archived.forEach((s) => {
        list.appendChild(this.#buildItem(s, { showArchiveButton: false }));
      });
      header.querySelector(".archived-delete-all-btn")?.addEventListener("click", (event) => {
        event.stopPropagation();
        this.deleteAllArchived();
      });
      header.addEventListener("click", () => {
        this.archivedCollapsed = !this.archivedCollapsed;
        localStorage.setItem(STORAGE.archivedCollapsed, String(this.archivedCollapsed));
        header.classList.toggle("collapsed", this.archivedCollapsed);
        list.classList.toggle("collapsed", this.archivedCollapsed);
      });
      group.appendChild(header);
      group.appendChild(list);
      this.container.appendChild(group);
    }

    if (this.searchQuery) this.applySearch();
  }

  // Group regular sessions by their originating project. The list arrives
  // sorted newest-first, so the first session from each project determines the
  // project's position without reordering projects around the active project.
  #buildPinnedSuperAgentGroup(session) {
    const group = document.createElement("div");
    group.className = "super-agent-pinned-group";
    group.appendChild(
      this.#sectionHeader(
        "super-agent-pinned-header",
        '<span class="fav-star">★</span> <span>Agent Inbox</span> <span class="project-count">Pinned</span>',
      ),
    );

    const list = document.createElement("div");
    list.className = "project-sessions";
    list.appendChild(this.#buildItem(session, { showArchiveButton: false }));
    group.appendChild(list);
    return group;
  }

  #groupByProject(sessions) {
    const order = [];
    const byPath = new Map();
    for (const session of sessions) {
      const path = session.projectPath || "unknown";
      if (!byPath.has(path)) {
        byPath.set(path, {
          path,
          name: session.projectName || path,
          isCurrent: Boolean(session.isCurrentWorkspace),
          sessions: [],
        });
        order.push(path);
      }
      byPath.get(path).sessions.push(session);
    }
    return order.map((path) => byPath.get(path));
  }

  #isProjectCollapsed(project) {
    const stored = this.projectsCollapsed[project.path];
    // Default: current project expanded, all other projects collapsed.
    return stored === undefined ? !project.isCurrent : stored === true;
  }

  #buildProjectGroup(project) {
    const group = document.createElement("div");
    group.className = `project-group${project.isCurrent ? " current-project" : ""}`;
    const collapsed = this.#isProjectCollapsed(project);

    const invoke = globalThis.__TAURI__?.core?.invoke ?? null;
    const canCreateSession = Boolean(invoke || (project.isCurrent && this.onCreateSession));
    const newChatButtonHtml = canCreateSession
      ? `<button class="project-new-chat-btn" title="New chat in ${escapeHtml(project.name)}" aria-label="New chat in ${escapeHtml(project.name)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>`
      : "";

    const header = this.#sectionHeader(
      `project-group-header${collapsed ? " collapsed" : ""}`,
      `<span class="chevron folder-icon">
        <svg class="folder-closed-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
        <svg class="folder-open-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
      </span>
      <span class="project-name" title="${escapeHtml(project.path)}">${escapeHtml(project.name)}</span>
      <span class="project-count">${project.sessions.length}</span>
      ${newChatButtonHtml}`,
    );

    header.querySelector(".project-new-chat-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const create = invoke
        ? invoke("open_new_session_in_workspace", { projectPath: project.path })
        : this.onCreateSession?.(this.getTarget()?.workspaceId);
      create?.catch((error) => {
        console.error("[Sidebar] Failed to start new chat:", error);
      });
    });

    const list = document.createElement("div");
    list.className = `project-sessions${collapsed ? " collapsed" : ""}`;

    // Only the current project gets show-more/less; other projects list all
    // their sessions once expanded.
    const visible =
      project.isCurrent && !this.searchQuery
        ? project.sessions.slice(0, this._visibleCount)
        : project.sessions;
    visible.forEach((session) => {
      list.appendChild(this.#buildItem(session));
    });
    if (project.isCurrent && !this.searchQuery) {
      const toggle = this.#buildToggleRow(visible.length, project.sessions.length);
      if (toggle) list.appendChild(toggle);
    }

    header.addEventListener("click", () => {
      const next = !this.#isProjectCollapsed(project);
      this.projectsCollapsed[project.path] = next;
      localStorage.setItem(STORAGE.projectsCollapsed, JSON.stringify(this.projectsCollapsed));
      header.classList.toggle("collapsed", next);
      list.classList.toggle("collapsed", next);
    });
    header.addEventListener("contextmenu", (event) => this.#showProjectContextMenu(event, project));

    group.appendChild(header);
    group.appendChild(list);
    return group;
  }

  #buildToggleRow(visibleCount, totalCount) {
    const hasMore = visibleCount < totalCount;
    const canShowLess = visibleCount > INITIAL_LIMIT;
    if (!hasMore && !canShowLess) return null;
    const row = document.createElement("div");
    row.className = "project-sessions-toggle-row";
    if (hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "project-sessions-toggle";
      more.textContent = "Show more";
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        this._visibleCount = visibleCount + STEP;
        this.render();
      });
      row.appendChild(more);
    }
    if (canShowLess) {
      const less = document.createElement("button");
      less.type = "button";
      less.className = "project-sessions-toggle project-sessions-toggle-less";
      less.textContent = "Show less";
      less.addEventListener("click", (event) => {
        event.stopPropagation();
        this._visibleCount = Math.max(INITIAL_LIMIT, visibleCount - STEP);
        this.render();
      });
      row.appendChild(less);
    }
    return row;
  }

  // ── context menu ────────────────────────────────────────────────
  #showContextMenu(event, session) {
    event.preventDefault();
    const rows = [
      {
        icon: this.isFavourite(session.id) ? "☆" : "★",
        label: this.isFavourite(session.id) ? "Unfavourite" : "Favourite",
        action: () => this.toggleFavourite(session.id),
      },
      {
        icon: this.isArchived(session.id) ? "📤" : "🗄️",
        label: this.isArchived(session.id) ? "Unarchive" : "Archive",
        action: () => this.toggleArchived(session.id),
      },
    ];
    if (session.id === this.activeSessionId) {
      rows.push({ icon: "✏️", label: "Rename", action: () => this.#startRename(session) });
    }
    this.#showMenu(event, rows);
  }

  #showProjectContextMenu(event, project) {
    event.preventDefault();
    this.#showMenu(event, [
      {
        icon: "🗄️",
        label: "Archive all sessions",
        action: () => this.archiveProject(project),
      },
    ]);
  }

  #showMenu(event, rows) {
    this.closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "session-context-menu";

    for (const entry of rows) {
      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.innerHTML = `<span class="context-menu-icon">${entry.icon}</span>${entry.label}`;
      row.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.closeContextMenu();
        entry.action();
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

  closeContextMenu() {
    this.contextMenu?.remove();
    this.contextMenu = null;
  }

  // Rename only works for the active (foreground) session — set_session_name
  // targets the running runtime, so non-active sessions cannot be renamed.
  #startRename(session) {
    const item = this.container.querySelector(
      `.session-item[data-session-id="${cssEscape(session.id)}"]`,
    );
    const titleEl = item?.querySelector(".session-title");
    if (!titleEl) return;
    const current = titleEl.textContent;
    const input = document.createElement("input");
    input.className = "session-rename-input";
    input.value = current;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const name = input.value.trim();
      if (name && name !== current) {
        try {
          await this.runtime.request({ type: "set_session_name", name }, this.getTarget(), {
            idempotencyKey: randomId(),
          });
          session.name = name;
        } catch (error) {
          console.error("[Sidebar] Rename failed:", error);
        }
      }
      const el = document.createElement("div");
      el.className = "session-title";
      el.title = name || current;
      el.textContent = name || current;
      input.replaceWith(el);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      } else if (event.key === "Escape") {
        input.value = current;
        input.blur();
      }
    });
  }
}
