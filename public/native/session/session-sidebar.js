import { t } from "../../i18n.js";
import { createIcon } from "../../icons.js";
import { buildSidebarSection, buildSidebarWorkspaceGroup } from "../../sidebar-workspace-group.js";
import { isSuperAgentProjectPath } from "../../super-agent/session.js";
import { isSuperAgentEnabled } from "../../super-agent/settings.js";
import { randomId } from "../utils/random-id.js";
import { createPinnedItemsStore, migrateFavourites, startPinnedItemsSync } from "./pinned-items.js";

// Rich session sidebar for the native host runtime.
//
// Ported from the legacy `public/sidebar/index.js` visual/interaction layer,
// but re-wired onto the native gateways:
//   - listing        → HostDataGateway.listSessions(workspaceId)   (flat list)
//   - full-text search→ HostDataGateway.searchSessions(workspaceId, query)
//   - rename/title    → RuntimeGateway for active sessions, ConfigGateway + Pi SessionManager for history
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
  recent: "picot-recent-sessions",
  recentCollapsed: "picot-recent-collapsed",
};

// Cap on how many recently-accessed sessions the sidebar tracks. Mirrors the
// feature-v3 recents list: enough to be useful, bounded so the section never
// crowds out the project groups below it.
const MAX_RECENT_SESSIONS = 5;

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
      filePath: session?.filePath ?? null,
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

function mergeSessionSummary(existing, incoming) {
  return {
    ...(existing ?? {}),
    ...(incoming ?? {}),
    name: incoming?.name ?? existing?.name ?? null,
    firstMessage: existing?.firstMessage ?? incoming?.firstMessage ?? null,
    timestamp: incoming?.timestamp ?? existing?.timestamp ?? new Date().toISOString(),
    modifiedAtMs: incoming?.modifiedAtMs ?? existing?.modifiedAtMs ?? Date.now(),
  };
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

export class SessionSidebar {
  constructor(
    container,
    {
      data,
      runtime,
      control,
      config,
      getTarget,
      onSelect,
      onCreateSession,
      onSessionsLoaded,
      onFocusProject,
    },
  ) {
    this.container = container;
    this.data = data;
    this.runtime = runtime;
    this.control = control;
    this.config = config;
    this.getTarget = getTarget;
    this.onSelect = onSelect;
    this.onCreateSession = onCreateSession;
    this.onSessionsLoaded = onSessionsLoaded;
    this.onFocusProject = onFocusProject;

    this.sessions = [];
    this.activeSessionId = getTarget()?.sessionId ?? null;
    this.favourites = readArray(STORAGE.favourites);
    this.archived = readArray(STORAGE.archived);
    this.archivedCollapsed = localStorage.getItem(STORAGE.archivedCollapsed) !== "false";
    this.projectsCollapsed = readObject(STORAGE.projectsCollapsed);
    this.recent = readArray(STORAGE.recent).slice(0, MAX_RECENT_SESSIONS);
    this.recentCollapsed = localStorage.getItem(STORAGE.recentCollapsed) !== "false";
    // In-memory collapse state for PINNED and PROJECTS — resets every app
    // launch (mirrors feature-v3) so a previous session's expand choice
    // does not carry over.
    this.pinnedCollapsed = false;
    this.unread = new Set(readArray(STORAGE.unread));
    this.streaming = new Set();
    this.autoTitleAttempted = new Set();

    this.searchQuery = "";
    this._searchResults = null;
    this._searchTimer = null;
    this._visibleCountsByProject = new Map();
    this._loadSeq = 0;
    this._loadCommitted = 0;
    this.contextMenu = null;

    // Pin store + sync. Persists workspace/session Pins in host-owned
    // localStorage and reacts to cross-tab changes via focus + visibility.
    // Migration of the legacy `pi-studio-favourites` localStorage value
    // runs once on construction so existing users keep their pins.
    this.pinnedStore = createPinnedItemsStore();
    try {
      const migration = migrateFavourites();
      if (migration.pendingLegacySessions?.length > 0) {
        console.warn(
          `[Sidebar] Pin migration deferred ${migration.pendingLegacySessions.length} legacy favourites (capacity).`,
        );
      }
    } catch (error) {
      console.error("[Sidebar] Pin migration failed:", error);
    }
    this._unsubscribePinned = this.pinnedStore.subscribe(() => this.render());
    this._stopPinnedSync = startPinnedItemsSync({});

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

  // Record a session as just-accessed, moving it to the front of the recents
  // list. Bounded to MAX_RECENT_SESSIONS so the section stays scannable.
  // Called from setActive() so every navigation path (sidebar click, route
  // boot, external link) converges on one recording point.
  #recordRecent(id) {
    if (!id) return;
    const next = [id, ...this.recent.filter((existing) => existing !== id)].slice(
      0,
      MAX_RECENT_SESSIONS,
    );
    if (JSON.stringify(next) === JSON.stringify(this.recent)) return;
    this.recent = next;
    this.#save(STORAGE.recent, this.recent);
  }

  // Join the stored recent ids against the loaded session list, dropping ids
  // that no longer resolve to a visible (non-archived) session. The prune is
  // lazy: we only rewrite storage when the set actually shrank, avoiding
  // write churn on every render.
  #resolveRecentSessions() {
    if (this.recent.length === 0) return [];
    const byId = new Map(this.sessions.map((session) => [session.id, session]));
    const resolved = this.recent
      .map((id) => byId.get(id))
      .filter((session) => session && !this.isArchived(session.id));
    const validIds = resolved.map((session) => session.id);
    if (JSON.stringify(validIds) !== JSON.stringify(this.recent)) {
      this.recent = validIds;
      this.#save(STORAGE.recent, this.recent);
    }
    return resolved;
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
      const dialog = document.createElement("div");
      dialog.className = "sidebar-confirm-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", "Delete archived sessions");
      const msgEl = document.createElement("div");
      msgEl.className = "sidebar-confirm-message";
      msgEl.textContent = message;
      dialog.appendChild(msgEl);
      const actions = document.createElement("div");
      actions.className = "sidebar-confirm-actions";
      const noBtn = document.createElement("button");
      noBtn.type = "button";
      noBtn.className = "sidebar-confirm-no";
      noBtn.textContent = "Cancel";
      const yesBtn = document.createElement("button");
      yesBtn.type = "button";
      yesBtn.className = "sidebar-confirm-yes";
      yesBtn.textContent = "Delete";
      actions.append(noBtn, yesBtn);
      dialog.appendChild(actions);
      overlay.appendChild(dialog);
      function onKeyDown(event) {
        if (event.key === "Escape") cleanup(false);
      }
      function cleanup(result) {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      }
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
    this.#recordRecent(sessionId);
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
      this.container.replaceChildren(
        ...Array.from({ length: 6 }, () => {
          const skel = document.createElement("div");
          skel.className = "session-skeleton";
          const skelTitle = document.createElement("div");
          skelTitle.className = "session-skeleton-title";
          skel.appendChild(skelTitle);
          return skel;
        }),
      );
    }
    const previousSignature = sessionListSignature(this.sessions);
    try {
      const response = await this.data.listAllSessions(workspaceId);
      if (seq < this._loadCommitted) return;
      this._loadCommitted = seq;
      const nextSessions = response.sessions ?? [];
      // Preserve a just-created active session that the server hasn't persisted
      // yet. Without this, a quiet reload fired right after upsertSession (e.g.
      // on session_bound) overwrites the list with the on-disk snapshot and the
      // new session vanishes until a manual refresh.
      const activeId = this.activeSessionId;
      if (activeId && !nextSessions.some((session) => session?.id === activeId)) {
        const local = this.sessions.find((session) => session?.id === activeId);
        if (local) nextSessions.unshift(local);
      }
      const changed = sessionListSignature(nextSessions) !== previousSignature;
      this.sessions = nextSessions;
      this.#hydrateStatuses(this.sessions, { authoritative: true });
      writeSessionCache(workspaceId, this.sessions);
      this.onSessionsLoaded?.(this.sessions);
      if (changed || (!quiet && !renderedFromCache)) this.render();
    } catch (error) {
      if (seq < this._loadCommitted) return;
      const retryDelay = LOAD_RETRY_DELAYS_MS[retryAttempt];
      if (retryDelay != null) {
        console.warn("[Sidebar] Session load failed; retrying:", error);
        if (!quiet && this.sessions.length === 0) {
          this.container.replaceChildren(
            (() => {
              const el = document.createElement("div");
              el.className = "session-loading";
              el.textContent = "Loading sessions...";
              return el;
            })(),
          );
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
      const loadingEl = document.createElement("div");
      loadingEl.className = "session-loading";
      loadingEl.textContent = "Failed to load sessions. ";
      const retryLink = document.createElement("button");
      retryLink.className = "retry-link";
      retryLink.id = "retry-load-sessions";
      retryLink.textContent = "Retry";
      loadingEl.appendChild(retryLink);
      this.container.replaceChildren(loadingEl);
      retryLink.addEventListener("click", () => this.load());
    }
  }

  upsertSession(session) {
    if (!session?.id) return;
    const index = this.sessions.findIndex((existing) => existing.id === session.id);
    const existing = index >= 0 ? this.sessions[index] : null;
    const projectFallback =
      existing ??
      this.sessions.find((candidate) => candidate.isCurrentWorkspace) ??
      this.sessions[0] ??
      {};
    const next = mergeSessionSummary(existing, {
      workspaceId: this.getTarget()?.workspaceId ?? projectFallback.workspaceId ?? "",
      projectPath: projectFallback.projectPath ?? this.getTarget()?.workspaceId ?? "unknown",
      projectName: projectFallback.projectName ?? projectFallback.projectPath ?? "Current project",
      isCurrentWorkspace: true,
      fileName: "",
      ...session,
    });

    if (index >= 0) this.sessions.splice(index, 1);
    this.sessions.unshift(next);
    this.#hydrateStatuses(this.sessions);
    writeSessionCache(this.getTarget()?.workspaceId, this.sessions);
    this.onSessionsLoaded?.(this.sessions);
    this.render();
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
    const searchIcon = document.createElement("span");
    searchIcon.textContent = "\u{1F50D}";
    const matchesLabel = document.createElement("span");
    matchesLabel.textContent = "Message matches";
    const countBadge = document.createElement("span");
    countBadge.className = "project-count";
    countBadge.textContent = String(this._searchResults.length);
    header.append(searchIcon, matchesLabel, countBadge);
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

      const titleRow = document.createElement("div");
      titleRow.className = "session-title-row";
      const titleElement = document.createElement("div");
      titleElement.className = "session-title";
      titleElement.title = title;
      titleElement.textContent = title;
      titleRow.appendChild(titleElement);
      item.appendChild(titleRow);

      const snippetEl = document.createElement("div");
      snippetEl.className = "search-snippet";
      snippetEl.textContent = snippet;
      item.appendChild(snippetEl);

      const metaEl = document.createElement("div");
      metaEl.className = "session-meta";
      metaEl.textContent = `${time}${matchCount > 1 ? ` · ${matchCount} matches` : ""}`;
      item.appendChild(metaEl);

      item.addEventListener("click", () =>
        this.onSelect({ id: result.sessionId, isCurrentWorkspace: true }),
      );
      sessionsDiv.appendChild(item);
    }
    group.appendChild(sessionsDiv);
    this.container.insertBefore(group, this.container.firstChild);
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

  #hydrateStatuses(sessions, { authoritative = false } = {}) {
    const listedIds = new Set();
    for (const session of sessions) {
      if (!session?.id) continue;
      listedIds.add(session.id);
      if (isWorkingSession(session)) this.streaming.add(session.id);
      else if (authoritative || hasLiveStatus(session)) this.streaming.delete(session.id);

      if (isUnreadSession(session) && session.id !== this.activeSessionId)
        this.unread.add(session.id);
      else if (session.id === this.activeSessionId) this.unread.delete(session.id);
    }
    if (authoritative) {
      for (const id of this.streaming) {
        if (!listedIds.has(id)) this.streaming.delete(id);
      }
    }
    this.#save(STORAGE.unread, [...this.unread]);
  }

  // ── item + section builders ─────────────────────────────────────
  // Ported from feature-v3 sidebar/build-session-item.js. Uses createIcon
  // SVGs (not emoji) for pin/archive/rename, rendered via DOM API so all
  // workspace-supplied text stays inert.
  #buildItem(session, { showArchiveButton = true, showPinButton = true } = {}) {
    const item = document.createElement("div");
    item.className = "session-item";
    item.dataset.sessionId = session.id;
    if (session.id === this.activeSessionId) item.classList.add("active");
    if (this.unread.has(session.id)) item.classList.add("unread");
    if (this.streaming.has(session.id)) item.classList.add("streaming", "mirror-live");

    const title = session.name || session.firstMessage || t("sidebar.emptySession");
    const isArchived = this.isArchived(session.id);
    const isPinned = this.pinnedStore?.isSessionPinned(session.id) ?? false;
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

    const actionSlot = document.createElement("span");
    actionSlot.className = "session-action-slot";
    titleRow.appendChild(actionSlot);
    item.appendChild(titleRow);

    item.addEventListener("click", () => this.onSelect(session));
    item.addEventListener("contextmenu", (event) => this.#showContextMenu(event, session));

    if (showPinButton && session.filePath) {
      const pinBtn = document.createElement("button");
      pinBtn.type = "button";
      pinBtn.className = "session-pin-btn";
      pinBtn.title = pinBtnLabel;
      pinBtn.setAttribute("aria-label", pinBtnLabel);
      pinBtn.setAttribute("aria-pressed", String(isPinned));
      const pinIconWrap = document.createElement("span");
      pinIconWrap.className = "session-pin-icon";
      const pinGlyph = createIcon("pin", { size: 13 });
      if (pinGlyph) pinIconWrap.appendChild(pinGlyph);
      pinBtn.appendChild(pinIconWrap);
      pinBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        if (this.pinnedStore?.isSessionPinned(session.id)) {
          this.pinnedStore.unpinSession(session.id);
        } else {
          this.pinnedStore.pinSession(session.id);
        }
        this.render();
      });
      actionSlot.appendChild(pinBtn);
    }

    if (showArchiveButton) {
      const archiveBtn = document.createElement("button");
      archiveBtn.type = "button";
      archiveBtn.className = "session-archive-btn";
      archiveBtn.title = archiveBtnLabel;
      archiveBtn.setAttribute("aria-label", archiveBtnLabel);
      const archiveGlyph = createIcon("archive");
      if (archiveGlyph) archiveBtn.appendChild(archiveGlyph);
      archiveBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleArchived(session.id);
      });
      actionSlot.appendChild(archiveBtn);
    }

    if (session.filePath) {
      const renameBtn = document.createElement("button");
      renameBtn.type = "button";
      renameBtn.className = "session-rename-btn";
      const renameLabel = t("sidebar.rename");
      renameBtn.title = renameLabel;
      renameBtn.setAttribute("aria-label", renameLabel);
      const renameIcon = createIcon("pencil", { size: 13 });
      if (renameIcon) renameBtn.appendChild(renameIcon);
      renameBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#startRename(session);
      });
      actionSlot.appendChild(renameBtn);
    }

    return item;
  }

  // Legacy header builder kept for callers that still pass pre-built HTML
  // (archived-group delete-all button). New code should use #buildSectionHeader.
  #sectionHeader(className, innerHtml) {
    const header = document.createElement("div");
    header.className = `project-header ${className}`;
    // Parse via DOMParser instead of innerHTML so untrusted content is
    // inert — same pattern as feature-v3 createFolderIcon.
    const doc = new DOMParser().parseFromString(innerHtml, "text/html");
    header.append(...doc.body.childNodes);
    return header;
  }

  render() {
    this.container.replaceChildren();

    const pinState = this.pinnedStore.getState();
    const hasAnyPins = pinState.workspaces.length > 0 || pinState.sessions.length > 0;

    if (this.sessions.length === 0 && !hasAnyPins) {
      const empty = document.createElement("div");
      empty.className = "session-loading";
      empty.textContent = "No saved sessions";
      this.container.appendChild(empty);
      return;
    }

    const superAgentEnabled = isSuperAgentEnabled();
    const superAgentSessions = this.sessions.filter((session) =>
      isSuperAgentProjectPath(session.projectPath),
    );
    const pinnedSuperAgent = superAgentEnabled
      ? asPinnedSuperAgentSession(latestSession(superAgentSessions))
      : null;

    if (pinnedSuperAgent) {
      this.container.appendChild(this.#buildPinnedSuperAgentGroup(pinnedSuperAgent));
    }

    // Partition sessions into archived / regular (excludes pinned).
    const pinnedWorkspacePaths = new Set(pinState.workspaces.map((w) => w.path || w.id));
    const pinnedSessionIds = new Set(pinState.sessions);
    const archived = [];
    const regular = [];
    for (const session of this.sessions) {
      if (isSuperAgentProjectPath(session.projectPath)) continue;
      if (this.isArchived(session.id)) {
        archived.push(session);
      } else if (
        !pinnedSessionIds.has(session.id) &&
        !(session.projectPath && pinnedWorkspacePaths.has(session.projectPath))
      ) {
        regular.push(session);
      }
    }

    // ── RECENT ──────────────────────────────────────────────────
    const recentSessions = this.#resolveRecentSessions();
    if (recentSessions.length > 0) {
      const { section } = buildSidebarSection({
        region: "recent",
        titleKey: "sidebar.recent",
        count: recentSessions.length,
        expanded: !this.recentCollapsed,
        onToggle: (expanded) => {
          this.recentCollapsed = !expanded;
          localStorage.setItem(STORAGE.recentCollapsed, String(this.recentCollapsed));
        },
        renderSessions: (body) => {
          for (const session of recentSessions) {
            body.appendChild(this.#buildItem(session));
          }
        },
      });
      section.classList.add("recent-group");
      this.container.appendChild(section);
    }

    // ── PINNED ──────────────────────────────────────────────────
    this.#renderPinnedSection(pinState);

    // ── PROJECTS ────────────────────────────────────────────────
    if (regular.length > 0) {
      const projects = this.#groupByProject(regular);
      const { section: projectsSection } = buildSidebarSection({
        region: "projects",
        titleKey: "sidebar.projects",
        count: projects.length,
        expanded: true,
        renderSessions: (body) => {
          for (const project of projects) {
            body.appendChild(this.#buildProjectGroup(project));
          }
        },
      });
      projectsSection.classList.add("projects-group");
      this.container.appendChild(projectsSection);
    }

    // ── ARCHIVED ────────────────────────────────────────────────
    if (archived.length > 0) {
      const { section: archivedSection } = buildSidebarSection({
        region: "archived",
        titleKey: "sidebar.archived",
        count: archived.length,
        expanded: !this.archivedCollapsed,
        onToggle: (expanded) => {
          this.archivedCollapsed = !expanded;
          localStorage.setItem(STORAGE.archivedCollapsed, String(this.archivedCollapsed));
        },
        renderSessions: (body) => {
          for (const s of archived) {
            body.appendChild(this.#buildItem(s, { showArchiveButton: false }));
          }
        },
        renderFooter: (footer) => {
          const deleteBtn = document.createElement("button");
          deleteBtn.type = "button";
          deleteBtn.className = "archived-delete-all-btn";
          const deleteLabel = t("sidebar.deleteAllArchived");
          deleteBtn.title = deleteLabel;
          deleteBtn.setAttribute("aria-label", deleteLabel);
          const trashGlyph = createIcon("trash-2", { size: 13 });
          if (trashGlyph) deleteBtn.replaceChildren(trashGlyph);
          deleteBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            this.deleteAllArchived();
          });
          footer.appendChild(deleteBtn);
        },
      });
      archivedSection.classList.add("archived-group");
      this.container.appendChild(archivedSection);
    }

    if (this.searchQuery) this.applySearch();
  }

  // Render the PINNED section using the unified buildSidebarSection +
  // buildSidebarWorkspaceGroup builders. Each pinned workspace (or orphan
  // pinned session) becomes its own workspace-group row with folder icon,
  // name, session count, and quick-info hover binding — visually identical
  // to the PROJECTS section so the four sections share one UI contract.
  #renderPinnedSection(pinState) {
    // Resolve pinned workspaces: each gets its sessions from this.sessions.
    // Orphan workspace pins (no loaded sessions) render an Unavailable row
    // with an Unpin button.
    const byPath = new Map();
    for (const session of this.sessions) {
      if (!session.projectPath) continue;
      if (!byPath.has(session.projectPath)) byPath.set(session.projectPath, []);
      byPath.get(session.projectPath).push(session);
    }

    const pinnedGroups = [];
    for (const ws of pinState.workspaces) {
      const sessions = (byPath.get(ws.path) || []).filter((s) => !this.isArchived(s.id));
      pinnedGroups.push({
        workspacePin: true,
        unavailable: sessions.length === 0,
        workspace: {
          path: ws.path,
          folderName: ws.path.split("/").filter(Boolean).pop() || ws.path,
        },
        sessions,
      });
    }
    // Orphan session pins (session.id in pinState.sessions but workspace not pinned).
    for (const id of pinState.sessions) {
      const session = this.sessions.find((s) => s.id === id);
      if (!session || this.isArchived(session.id)) {
        pinnedGroups.push({
          workspacePin: false,
          unavailable: true,
          workspace: null,
          sessions: [{ id }],
        });
      } else if (!pinState.workspaces.some((w) => w.path === session.projectPath)) {
        pinnedGroups.push({
          workspacePin: false,
          unavailable: false,
          workspace: {
            path: session.projectPath,
            folderName: session.projectPath.split("/").filter(Boolean).pop() || session.projectPath,
          },
          sessions: [session],
        });
      }
    }

    if (pinnedGroups.length === 0) return;

    const { section } = buildSidebarSection({
      region: "pinned",
      titleKey: "sidebar.pinned",
      count: pinnedGroups.length,
      expanded: !this.pinnedCollapsed,
      onToggle: (expanded) => {
        this.pinnedCollapsed = !expanded;
      },
      renderSessions: (body) => {
        for (const pinned of pinnedGroups) {
          const ws = pinned.workspace;
          const workspaceId = ws?.path || `pinned-session:${pinned.sessions[0]?.id || ""}`;
          const { group } = buildSidebarWorkspaceGroup({
            workspaceId,
            folderName: ws?.folderName || t("sidebar.unavailable"),
            workspacePath: ws?.path || "",
            sessionCount: pinned.sessions.length,
            expanded: true,
            onMoreActions: pinned.workspacePin
              ? (event) =>
                  this.#showProjectContextMenu(event, { path: ws.path, name: ws.folderName })
              : null,
            renderSessions: (container) => {
              if (pinned.unavailable) {
                const unavailable = document.createElement("div");
                unavailable.className = "pinned-unavailable";
                unavailable.textContent =
                  ws?.path || pinned.sessions[0]?.id || t("sidebar.unavailable");
                container.appendChild(unavailable);
                const unpin = document.createElement("button");
                unpin.type = "button";
                unpin.textContent = pinned.workspacePin
                  ? t("sidebar.unpinWorkspace")
                  : t("sidebar.unpinSession");
                unpin.addEventListener("click", (event) => {
                  event.stopPropagation();
                  if (pinned.workspacePin) {
                    this.pinnedStore.unpinWorkspace(ws.path);
                  } else {
                    this.pinnedStore.unpinSession(pinned.sessions[0].id);
                  }
                });
                container.appendChild(unpin);
                return;
              }
              for (const session of pinned.sessions) {
                container.appendChild(this.#buildItem(session));
              }
            },
          });
          group.classList.add("pinned-workspace-group");
          body.appendChild(group);
        }
      },
    });
    section.classList.add("pinned-group");
    this.container.appendChild(section);
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

    const focusButtonHtml = project.isCurrent
      ? `<button class="project-focus-btn" title="Focus on this workspace" aria-label="Focus on ${escapeHtml(project.name)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>`
      : "";

    const moreActionsLabel = t("sidebar.workspaceActions");
    const moreActionsButtonHtml = `<button class="workspace-more-actions-btn" title="${escapeHtml(moreActionsLabel)}" aria-label="${escapeHtml(moreActionsLabel)}"></button>`;

    const header = this.#sectionHeader(
      `project-group-header${collapsed ? " collapsed" : ""}`,
      `<span class="chevron folder-icon">
        <svg class="folder-closed-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>
        <svg class="folder-open-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m6 14l1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>
      </span>
      <span class="project-name" title="${escapeHtml(project.path)}">${escapeHtml(project.name)}</span>
      <span class="project-count">${project.sessions.length}</span>
      ${newChatButtonHtml}
      ${moreActionsButtonHtml}
      ${focusButtonHtml}`,
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

    header.querySelector(".project-focus-btn")?.addEventListener("click", (event) => {
      event.stopPropagation();
      this.onFocusProject?.(project);
    });

    const moreActionsEl = header.querySelector(".workspace-more-actions-btn");
    if (moreActionsEl) {
      const moreIcon = createIcon("ellipsis", { size: 14 });
      if (moreIcon) moreActionsEl.replaceChildren(moreIcon);
      moreActionsEl.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#showProjectContextMenu(event, project);
      });
    }

    const list = document.createElement("div");
    list.className = `project-sessions${collapsed ? " collapsed" : ""}`;

    const visibleCount = this.#projectVisibleCount(project, project.sessions.length);
    const visible = this.searchQuery ? project.sessions : project.sessions.slice(0, visibleCount);
    visible.forEach((session) => {
      list.appendChild(this.#buildItem(session));
    });
    if (!this.searchQuery) {
      const toggle = this.#buildToggleRow(project, visible.length, project.sessions.length);
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
    // Bind the workspace header to the hover quick-info card. Uses the
    // workspace's on-disk path as the stable identity since the native
    // arch has no separate `history:` id.
    return group;
  }

  #projectVisibleKey(project) {
    return project.path || project.name || "unknown";
  }

  #projectVisibleCount(project, totalCount) {
    const stored = this._visibleCountsByProject.get(this.#projectVisibleKey(project));
    if (typeof stored === "number" && Number.isFinite(stored)) {
      return Math.max(INITIAL_LIMIT, Math.min(totalCount, Math.floor(stored)));
    }
    return Math.min(totalCount, INITIAL_LIMIT);
  }

  #setProjectVisibleCount(project, count) {
    this._visibleCountsByProject.set(
      this.#projectVisibleKey(project),
      Math.max(INITIAL_LIMIT, count),
    );
  }

  #buildToggleRow(project, visibleCount, totalCount) {
    const hasMore = visibleCount < totalCount;
    const canShowLess = visibleCount > INITIAL_LIMIT;
    if (!hasMore && !canShowLess) return null;
    const row = document.createElement("div");
    row.className = "project-sessions-toggle-row";
    if (hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "project-sessions-toggle";
      more.textContent = t("sidebar.showMore");
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#setProjectVisibleCount(project, visibleCount + STEP);
        this.render();
      });
      row.appendChild(more);
    }
    if (canShowLess) {
      const less = document.createElement("button");
      less.type = "button";
      less.className = "project-sessions-toggle project-sessions-toggle-less";
      less.textContent = t("sidebar.showLess");
      less.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#setProjectVisibleCount(project, Math.max(INITIAL_LIMIT, visibleCount - STEP));
        this.render();
      });
      row.appendChild(less);
    }
    return row;
  }

  // ── context menu ────────────────────────────────────────────────
  #showContextMenu(event, session) {
    event.preventDefault();
    const isPinned = this.pinnedStore?.isSessionPinned(session.id) ?? false;
    // Skip the per-session Pin row when the session's workspace is already
    // pinned: the workspace Pin subsumes the session Pin, so the menu
    // entry would be redundant.
    const workspacePinned = session.projectPath
      ? (this.pinnedStore?.isWorkspacePinned(session.projectPath) ?? false)
      : false;
    const rows = [
      {
        label: this.isFavourite(session.id) ? t("sidebar.unfavourite") : t("sidebar.favourite"),
        action: () => this.toggleFavourite(session.id),
      },
      {
        label: this.isArchived(session.id) ? t("sidebar.unarchive") : t("sidebar.archive"),
        action: () => this.toggleArchived(session.id),
      },
    ];
    if (session.id === this.activeSessionId) {
      rows.push({
        label: t("sidebar.generateTitle"),
        action: () => void this.#generateTitle(session),
      });
    }
    if (session.filePath && !workspacePinned) {
      rows.push({ separator: true });
      rows.push({
        label: isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession"),
        action: () => {
          if (isPinned) {
            this.pinnedStore.unpinSession(session.id);
          } else {
            this.pinnedStore.pinSession(session.id);
          }
          this.render();
        },
      });
      rows.push({ label: t("sidebar.rename"), action: () => this.#startRename(session) });
    } else if (session.filePath) {
      rows.push({ separator: true });
      rows.push({ label: t("sidebar.rename"), action: () => this.#startRename(session) });
    }
    this.#showMenu(event, rows);
  }

  #showProjectContextMenu(event, project) {
    event.preventDefault();
    const isWorkspacePinned = this.pinnedStore?.isWorkspacePinned(project.path) ?? false;
    const rows = [
      {
        label: t("sidebar.archiveWorkspaceSessions"),
        action: () => this.archiveProject(project),
      },
      { separator: true },
      {
        label: isWorkspacePinned ? t("sidebar.unpinWorkspace") : t("sidebar.pinWorkspace"),
        action: () => {
          if (isWorkspacePinned) {
            this.pinnedStore.unpinWorkspace(project.path);
          } else {
            this.pinnedStore.pinWorkspace(project.path, project.path);
          }
          this.render();
        },
      },
    ];
    this.#showMenu(event, rows);
  }

  #showMenu(event, rows) {
    this.closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "session-context-menu";

    for (const entry of rows) {
      if (entry.separator) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.textContent = entry.label;
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

  async autoGenerateTitle(sessionId) {
    if (!sessionId || this.autoTitleAttempted.has(sessionId)) return;
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) return;
    const currentName = String(session.name || "").trim();
    if (currentName && currentName !== "Untitled" && currentName !== "New Session") return;
    this.autoTitleAttempted.add(sessionId);
    await this.#generateTitle(session);
  }

  async #generateTitle(session) {
    if (!this.config) return;
    const item = this.container.querySelector(
      `.session-item[data-session-id="${cssEscape(session.id)}"]`,
    );
    const titleEl = item?.querySelector(".session-title");
    const previousTitle = titleEl?.textContent || session.name || "";
    if (titleEl) titleEl.textContent = t("sidebar.generatingTitle");

    try {
      const result = await this.config.call("generate_session_title", {}, { timeoutMs: 100_000 });
      const title = result?.data?.title?.trim();
      if (!result?.ok || !title) throw new Error(result?.error || t("sidebar.generateTitleError"));
      await this.runtime.request({ type: "set_session_name", name: title }, this.getTarget(), {
        idempotencyKey: randomId(),
      });
      session.name = title;
      if (titleEl) {
        titleEl.textContent = title;
        titleEl.title = title;
      }
    } catch (error) {
      if (titleEl) titleEl.textContent = previousTitle;
      console.error("[Sidebar] Generate title failed:", error);
    }
  }

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
          if (session.id === this.activeSessionId) {
            await this.runtime.request({ type: "set_session_name", name }, this.getTarget(), {
              idempotencyKey: randomId(),
            });
          } else {
            const result = await this.config.call("rename_historical_session", {
              filePath: session.filePath,
              name,
            });
            if (!result?.ok) throw new Error(result?.error || "Session rename failed");
          }
          for (const candidate of this.sessions) {
            if (candidate.filePath === session.filePath) candidate.name = name;
          }
          session.name = name;
          void this.load({ quiet: true });
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

  // Tear down Pin store subscriptions and cross-tab sync. Callers (tests,
  // SPA route changes) should invoke this when the sidebar is replaced to
  // avoid listener leaks and stale focus events firing on a detached DOM.
  destroy() {
    try {
      this._unsubscribePinned?.();
    } catch (error) {
      console.error("[Sidebar] Pin unsubscribe failed:", error);
    }
    try {
      this._stopPinnedSync?.();
    } catch (error) {
      console.error("[Sidebar] Pin sync stop failed:", error);
    }
    try {
      this.pinnedStore?.destroy?.();
    } catch (error) {
      console.error("[Sidebar] Pin store destroy failed:", error);
    }
  }
}
