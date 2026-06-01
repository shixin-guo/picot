/**
 * Session Sidebar - Lists sessions grouped by project, handles switching
 */

export class SessionSidebar {
  constructor(container, onSessionSelect, onNewChat) {
    this.container = container;
    this.onSessionSelect = onSessionSelect;
    this.onNewChat = onNewChat;
    this.activeSessionFile = null;
    this.projects = [];
    this.collapsedProjects = new Set();
    this.searchQuery = '';
    this.favourites = JSON.parse(localStorage.getItem('pi-studio-favourites') || '[]');
    this.archived = JSON.parse(localStorage.getItem('pi-studio-archived') || '[]');
    this.archivedCollapsed = localStorage.getItem('pi-studio-archived-collapsed') !== 'false';
    this.unread = new Set(JSON.parse(localStorage.getItem('pi-studio-unread') || '[]'));
    this.streamingFiles = new Set();
    this.contextMenu = null;

    // Close context menu on click anywhere
    document.addEventListener('click', () => this.closeContextMenu());
    document.addEventListener('contextmenu', (e) => {
      // Close if right-clicking outside a session item
      if (!e.target.closest('.session-item')) this.closeContextMenu();
    });
  }

  saveFavourites() {
    localStorage.setItem('pi-studio-favourites', JSON.stringify(this.favourites));
  }

  saveArchived() {
    localStorage.setItem('pi-studio-archived', JSON.stringify(this.archived));
  }

  saveArchivedCollapsed() {
    localStorage.setItem('pi-studio-archived-collapsed', String(this.archivedCollapsed));
  }

  saveUnread() {
    localStorage.setItem('pi-studio-unread', JSON.stringify(Array.from(this.unread)));
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
    files.forEach((f) => this.applyStatusToItem(f));
  }

  applyStatusToItem(filePath) {
    const items = this.container.querySelectorAll(`.session-item[data-file-path="${CSS.escape(filePath)}"]`);
    items.forEach((el) => {
      el.classList.toggle('unread', this.unread.has(filePath));
      el.classList.toggle('streaming', this.streamingFiles.has(filePath));
      el.classList.toggle('mirror-live', this.streamingFiles.has(filePath));
    });
  }

  isFavourite(filePath) {
    return this.favourites.includes(filePath);
  }

  isArchived(filePath) {
    return this.archived.includes(filePath);
  }

  toggleFavourite(filePath) {
    const idx = this.favourites.indexOf(filePath);
    if (idx >= 0) {
      this.favourites.splice(idx, 1);
    } else {
      this.favourites.push(filePath);
    }
    this.saveFavourites();
    this.render();
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
      const res = await fetch('/api/sessions/delete-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePaths: paths }),
      });
      const data = await res.json();
      const errorSet = new Set(data.errors || []);
      const deleted = new Set(paths.filter(p => !errorSet.has(p)));
      this.archived = this.archived.filter(p => !deleted.has(p));
      this.saveArchived();
    } catch (err) {
      console.error('[Sidebar] deleteAllArchived failed:', err);
    }

    await this.loadSessions();
  }

  async confirmArchivedDeletion(count) {
    const message = `Delete ${count} archived session${count === 1 ? '' : 's'} permanently? This cannot be undone.`;
    return this.showFallbackConfirmDialog(message);
  }

  showFallbackConfirmDialog(message) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'sidebar-confirm-overlay';
      overlay.innerHTML = `
        <div class="sidebar-confirm-dialog" role="dialog" aria-modal="true" aria-label="Delete archived sessions">
          <div class="sidebar-confirm-message">${this.escapeHtml(message)}</div>
          <div class="sidebar-confirm-actions">
            <button type="button" class="sidebar-confirm-no">Cancel</button>
            <button type="button" class="sidebar-confirm-yes">Delete</button>
          </div>
        </div>
      `;

      const cleanup = (result) => {
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        resolve(result);
      };

      const onKeyDown = (event) => {
        if (event.key === 'Escape') cleanup(false);
      };

      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) cleanup(false);
      });

      overlay.querySelector('.sidebar-confirm-no').addEventListener('click', () => cleanup(false));
      overlay.querySelector('.sidebar-confirm-yes').addEventListener('click', () => cleanup(true));

      document.addEventListener('keydown', onKeyDown);
      document.body.appendChild(overlay);
    });
  }

  async loadSessions({ retries = 4, retryDelayMs = 250, quiet = false } = {}) {
    if (!quiet) {
      this.container.innerHTML = Array.from({ length: 6 }, () =>
        '<div class="session-skeleton"><div class="session-skeleton-title"></div><div class="session-skeleton-meta"></div></div>'
      ).join('');
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch('/api/sessions');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        this.projects = data.projects || [];
        this.render();
        return;
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * (attempt + 1)));
        }
      }
    }

    console.error('[Sidebar] Failed to load sessions:', lastError);
    const reason = String(lastError?.message || lastError || '').toLowerCase();
    const likelyRuntimeDown =
      reason.includes('failed to fetch') ||
      reason.includes('networkerror') ||
      reason.includes('load failed');
    const message = likelyRuntimeDown
      ? 'Failed to load sessions. Pi runtime may be unavailable.'
      : 'Failed to load sessions.';
    this.container.innerHTML =
      `<div class="session-loading">${message} <button class="retry-link" id="retry-load-sessions">Retry</button></div>`;
    const retryBtn = this.container.querySelector('#retry-load-sessions');
    if (retryBtn) {
      retryBtn.addEventListener('click', () => this.loadSessions());
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
      console.error('[Sidebar] Search failed:', err);
    }
  }

  renderSearchResults() {
    if (!this._searchResults || this._searchResults.length === 0) return;

    // Remove previous search results section
    const existing = this.container.querySelector('.search-results-group');
    if (existing) existing.remove();

    const group = document.createElement('div');
    group.className = 'search-results-group';

    const header = document.createElement('div');
    header.className = 'project-header search-results-header';
    header.innerHTML = `<span>🔍</span> <span>Message matches</span> <span class="project-count">${this._searchResults.length}</span>`;
    group.appendChild(header);

    const sessionsDiv = document.createElement('div');
    sessionsDiv.className = 'project-sessions';

    for (const result of this._searchResults) {
      const item = document.createElement('div');
      item.className = 'session-item search-result-item';
      item.dataset.filePath = result.filePath;

      if (result.filePath === this.activeSessionFile) {
        item.classList.add('active');
      }

      const title = result.sessionName || result.firstMessage || 'Untitled';
      const snippet = result.matches[0]?.snippet || '';
      const matchCount = result.matches.length;
      const time = this.formatTime(result.sessionTimestamp);

      item.innerHTML = `
        <div class="session-title-row">
          <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        </div>
        <div class="search-snippet">${this.highlightMatch(snippet, this.searchQuery)}</div>
        <div class="session-meta">${time}${matchCount > 1 ? ` · ${matchCount} matches` : ''}</div>
      `;

      // Find the matching project/session to pass to onSessionSelect
      item.addEventListener('click', () => {
        for (const project of this.projects) {
          const session = project.sessions.find(s => s.filePath === result.filePath);
          if (session) {
            this.onSessionSelect(session, project);
            return;
          }
        }
        // Session not in loaded list (unlikely) — try switching by path
        this.onSessionSelect({ filePath: result.filePath, name: result.sessionName }, { path: result.project });
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
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  applySearch() {
    if (!this.searchQuery) {
      this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('hidden'));
      this.container.querySelectorAll('.project-group, .archived-group').forEach(el => el.style.display = '');
      const favSection = this.container.querySelector('.favourites-group');
      if (favSection) favSection.style.display = '';
      // Remove full-text results
      const searchGroup = this.container.querySelector('.search-results-group');
      if (searchGroup) searchGroup.remove();
      return;
    }

    // Search favourites section
    const favSection = this.container.querySelector('.favourites-group');
    if (favSection) {
      let hasVisible = false;
      favSection.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      favSection.style.display = hasVisible ? '' : 'none';
    }

    this.container.querySelectorAll('.project-group, .archived-group').forEach(group => {
      let hasVisible = false;
      group.querySelectorAll('.session-item').forEach(item => {
        const title = (item.querySelector('.session-title')?.textContent || '').toLowerCase();
        const matches = title.includes(this.searchQuery);
        item.classList.toggle('hidden', !matches);
        if (matches) hasVisible = true;
      });
      group.style.display = hasVisible ? '' : 'none';
    });
  }

  setActive(filePath) {
    this.activeSessionFile = filePath;
    if (filePath && this.unread.has(filePath)) {
      this.unread.delete(filePath);
      this.saveUnread();
    }
    this.container.querySelectorAll('.session-item').forEach(el => {
      const isActive = el.dataset.filePath === filePath;
      el.classList.toggle('active', isActive);
      if (isActive) {
        el.classList.remove('unread');
      }
    });
  }

  clearActive() {
    this.activeSessionFile = null;
    this.container.querySelectorAll('.session-item').forEach(el => el.classList.remove('active'));
  }

  // ═══════════════════════════════════════
  // Context Menu
  // ═══════════════════════════════════════

  showContextMenu(e, session, project, itemEl) {
    e.preventDefault();
    this.closeContextMenu();

    const menu = document.createElement('div');
    menu.className = 'session-context-menu';

    const isArchived = this.isArchived(session.filePath);
    const items = [
      { icon: isArchived ? '📤' : '🗄️', label: isArchived ? 'Unarchive' : 'Archive', action: () => this.toggleArchived(session.filePath) },
    ];

    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'context-menu-item';
      row.innerHTML = `<span class="context-menu-icon">${item.icon}</span>${item.label}`;
      row.addEventListener('click', (ev) => {
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
    const titleEl = itemEl.querySelector('.session-title');
    if (!titleEl) return;
    const currentName = titleEl.textContent;

    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.value = currentName;
    titleEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newName = input.value.trim();
      if (newName && newName !== currentName) {
        try {
          await fetch('/api/rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'set_session_name', name: newName }),
          });
        } catch { /* silent */ }
      }
      const newTitle = document.createElement('div');
      newTitle.className = 'session-title';
      newTitle.title = newName || currentName;
      newTitle.textContent = newName || currentName;
      input.replaceWith(newTitle);
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (ke) => {
      if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
      if (ke.key === 'Escape') { input.value = currentName; input.blur(); }
    });
  }

  async exportSession(session) {
    try {
      const data = await (await fetch('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'export_html' }),
      })).json();
      if (data?.success && data.data?.path) {
        window.open(`/api/sessions/${encodeURIComponent(data.data.path)}`);
      }
    } catch { /* silent */ }
  }

  // ═══════════════════════════════════════
  // Render
  // ═══════════════════════════════════════

  buildSessionItem(session, project, options = {}) {
    const { showArchiveButton = true } = options;
    const item = document.createElement('div');
    item.className = 'session-item';
    item.dataset.filePath = session.filePath;

    if (session.filePath === this.activeSessionFile) {
      item.classList.add('active');
    }
    if (this.unread.has(session.filePath)) {
      item.classList.add('unread');
    }
    if (this.streamingFiles.has(session.filePath)) {
      item.classList.add('streaming');
    }

    const title = session.name || session.firstMessage || 'Empty session';
    const time = this.formatTime(session.timestamp);
    const tmuxTag = session.tmux ? '<span class="session-tag tmux-tag">tmux</span>' : '';
    const favIcon = this.isFavourite(session.filePath) ? '<span class="session-fav-icon">★</span>' : '';
    const isArchived = this.isArchived(session.filePath);
    const archiveBtnLabel = isArchived ? 'Unarchive session' : 'Archive session';
    const archiveBtnIcon = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="4" width="18" height="4" rx="1.5"></rect>
        <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"></path>
        <path d="M10 12h4"></path>
      </svg>
    `;

    const archiveButtonHtml = showArchiveButton
      ? `<button class="session-archive-btn" title="${archiveBtnLabel}" aria-label="${archiveBtnLabel}">${archiveBtnIcon}</button>`
      : '';

    item.innerHTML = `
      <div class="session-title-row">
        ${favIcon}
        <div class="session-title" title="${this.escapeHtml(title)}">${this.escapeHtml(title)}</div>
        ${tmuxTag}
        <span class="session-action-slot">
          <span class="session-time">${time}</span>
          ${archiveButtonHtml}
        </span>
      </div>
    `;

    item.addEventListener('click', () => this.onSessionSelect(session, project));
    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.toggleArchived(session.filePath);
      });
    }

    return item;
  }

  render() {
    if (this.projects.length === 0) {
      this.container.innerHTML = '<div class="session-loading">No sessions found</div>';
      return;
    }

    this.container.innerHTML = '';

    // Favourites + archived sections — collect from all projects
    const favSessions = [];
    const archivedSessions = [];
    for (const project of this.projects) {
      for (const session of project.sessions) {
        if (this.isArchived(session.filePath)) {
          archivedSessions.push({ session, project });
          continue;
        }
        if (this.isFavourite(session.filePath)) {
          favSessions.push({ session, project });
        }
      }
    }

    if (favSessions.length > 0) {
      const favGroup = document.createElement('div');
      favGroup.className = 'favourites-group';

      const header = document.createElement('div');
      header.className = 'project-header favourites-header';
      header.innerHTML = `<span class="fav-star">★</span> <span>Favourites</span> <span class="project-count">${favSessions.length}</span>`;
      favGroup.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = 'project-sessions';
      for (const { session, project } of favSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }
      favGroup.appendChild(sessionsDiv);
      this.container.appendChild(favGroup);
    }

    // Regular project groups
    for (const project of this.projects) {
      const visibleSessions = project.sessions.filter((session) => !this.isArchived(session.filePath));
      if (visibleSessions.length === 0) continue;

      const group = document.createElement('div');
      group.className = 'project-group';
      const isCollapsed = this.collapsedProjects.has(project.dirName);

      const header = document.createElement('div');
      header.className = `project-header${isCollapsed ? ' collapsed' : ''}`;

      const pathParts = project.path.split('/').filter(Boolean);
      const shortPath = pathParts.length > 0 ? pathParts[pathParts.length - 1] : project.path;

      header.innerHTML = `
        <span class="chevron">▼</span>
        <span class="project-name" title="${project.path}">${shortPath}</span>
        <span class="project-count">${visibleSessions.length}</span>
        <button class="project-new-chat-btn" title="New chat in ${this.escapeHtml(shortPath)}" aria-label="New chat in ${this.escapeHtml(shortPath)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      `;

      const newChatBtn = header.querySelector('.project-new-chat-btn');
      newChatBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onNewChat) this.onNewChat(project);
      });

      header.addEventListener('click', () => {
        if (this.collapsedProjects.has(project.dirName)) {
          this.collapsedProjects.delete(project.dirName);
        } else {
          this.collapsedProjects.add(project.dirName);
        }
        header.classList.toggle('collapsed');
        sessionsDiv.classList.toggle('collapsed');
      });

      group.appendChild(header);

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = `project-sessions${isCollapsed ? ' collapsed' : ''}`;

      for (const session of visibleSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project));
      }

      group.appendChild(sessionsDiv);
      this.container.appendChild(group);
    }

    if (archivedSessions.length > 0) {
      archivedSessions.sort((a, b) => (b.session.mtime || 0) - (a.session.mtime || 0));
      const archivedGroup = document.createElement('div');
      archivedGroup.className = 'archived-group';

      const header = document.createElement('div');
      header.className = `project-header archived-header${this.archivedCollapsed ? ' collapsed' : ''}`;
      header.innerHTML = `
        <span class="chevron">▼</span>
        <span>Archived</span>
        <span class="project-count">${archivedSessions.length}</span>
        <button class="archived-delete-all-btn" title="Delete all archived sessions" aria-label="Delete all archived sessions">
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

      const deleteAllBtn = header.querySelector('.archived-delete-all-btn');
      deleteAllBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteAllArchived();
      });

      const sessionsDiv = document.createElement('div');
      sessionsDiv.className = `project-sessions${this.archivedCollapsed ? ' collapsed' : ''}`;
      for (const { session, project } of archivedSessions) {
        sessionsDiv.appendChild(this.buildSessionItem(session, project, { showArchiveButton: false }));
      }

      header.addEventListener('click', () => {
        this.archivedCollapsed = !this.archivedCollapsed;
        this.saveArchivedCollapsed();
        header.classList.toggle('collapsed', this.archivedCollapsed);
        sessionsDiv.classList.toggle('collapsed', this.archivedCollapsed);
      });

      archivedGroup.appendChild(sessionsDiv);
      this.container.appendChild(archivedGroup);
    }

    if (this.searchQuery) this.applySearch();
  }

  formatTime(isoTimestamp) {
    try {
      const date = new Date(isoTimestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const days = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (days === 1) return 'Yesterday';
      if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
