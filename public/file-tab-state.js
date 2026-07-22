import { basenameLocalPath, normalizeLocalPath } from "./workspace/path-utils.js";

export class FileTabState {
  /**
   * @param opts.storage — injectable storage (defaults to localStorage)
   * @param opts.storageKey — key under which tab snapshots are persisted
   */
  constructor({ storage, storageKey = "picot-file-tabs" } = {}) {
    if (storage !== undefined) {
      this.storage = storage;
    } else {
      try {
        this.storage = globalThis.document?.defaultView?.localStorage ?? null;
      } catch {
        this.storage = null;
      }
    }
    this.storageKey = storageKey;
    this.workspaceRoot = null;
    this.tabs = [];
    this.activeTabId = null;
    this._listeners = new Set();
  }

  /**
   * Load persisted tab state for the given workspace root.
   * Clears any previously loaded state.
   */
  load(workspaceRoot) {
    const normalized = this._normalizeRoot(workspaceRoot);
    this.workspaceRoot = normalized;
    this.tabs = [];
    this.activeTabId = null;

    const snapshot = this._readSnapshot();
    if (!snapshot) return;

    const rootState = snapshot.byRoot?.[normalized];
    if (!rootState) return;

    this.tabs = (rootState.tabs || [])
      .filter((tab) => tab && typeof tab.id === "string" && typeof tab.filePath === "string")
      .map((tab) => ({
        id: tab.id,
        kind: tab.kind || "file",
        filePath: tab.filePath,
        fileName: tab.fileName || basenameLocalPath(tab.filePath) || tab.filePath,
        mode: tab.mode || "preview",
        content: null,
        originalContent: null,
        dirty: false,
        loading: false,
        saving: false,
        conflict: false,
        error: null,
        mtimeMs: null,
        editable: null,
        truncated: false,
        isBinary: false,
        mimeType: null,
        size: null,
        saveError: null,
        errorDetail: null,
      }));
    this.activeTabId = this.tabs.some((tab) => tab.id === rootState.activeTabId)
      ? rootState.activeTabId
      : (this.tabs[0]?.id ?? null);
  }

  /**
   * Open a file tab (or select it if already open).
   * Returns the tab object.
   */
  openFile(filePath, metadata = {}) {
    const normalizedPath = this._normalizePath(filePath);
    const tabId = `file:${normalizedPath}`;

    const existing = this.tabs.find((tab) => tab.id === tabId);
    if (existing) {
      this.activeTabId = tabId;
      this.persist();
      this._notify();
      return existing;
    }

    const tab = {
      id: tabId,
      kind: "file",
      filePath: normalizedPath,
      fileName: metadata.fileName || basenameLocalPath(normalizedPath) || normalizedPath,
      mode: metadata.mode || "preview",
      content: null,
      originalContent: null,
      dirty: false,
      loading: false,
      saving: false,
      conflict: false,
      error: null,
      mtimeMs: null,
      editable: metadata.editable ?? null,
      truncated: Boolean(metadata.truncated),
      isBinary: Boolean(metadata.isBinary),
      mimeType: metadata.mimeType || null,
      size: metadata.size ?? null,
      saveError: null,
      errorDetail: null,
    };

    this.tabs.push(tab);
    this.activeTabId = tabId;
    this._notify();
    this.persist();
    return tab;
  }

  /**
   * Select a tab by id. Returns true if the tab exists and was selected.
   */
  selectTab(tabId) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    this.activeTabId = tabId;
    this.persist();
    this._notify();
    return true;
  }

  /**
   * Update a tab with a patch object. Only known fields are updated.
   * Returns true if the tab was found.
   */
  updateTab(tabId, patch) {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return false;
    this.tabs[idx] = { ...this.tabs[idx], ...patch };
    this._notify();
    return true;
  }

  getTab(tabId) {
    return this.tabs.find((t) => t.id === tabId) || null;
  }

  getTabs() {
    return [...this.tabs];
  }

  getActiveTab() {
    if (!this.activeTabId) return null;
    return this.getTab(this.activeTabId);
  }

  /**
   * Close a tab. Returns the next tab id to activate, or null if no tabs remain.
   */
  closeTab(tabId) {
    const idx = this.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return { closed: false, nextTabId: null };

    this.tabs.splice(idx, 1);

    let nextTabId = null;
    if (this.activeTabId === tabId) {
      // Prefer right neighbor, then left neighbor.
      if (this.tabs.length > 0) {
        const nextIdx = Math.min(idx, this.tabs.length - 1);
        nextTabId = this.tabs[nextIdx].id;
      }
      this.activeTabId = nextTabId;
    } else {
      // If the closed tab wasn't active, keep current selection.
      nextTabId = this.activeTabId;
    }

    this._notify();
    this.persist();
    return { closed: true, nextTabId };
  }

  /**
   * Subscribe to state changes. Returns an unsubscribe function.
   */
  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /**
   * Persist the current state (sans dirty content) to storage.
   */
  persist() {
    if (!this.storage || !this.workspaceRoot) return;

    const snapshot = this._readSnapshot() || { byRoot: {} };

    snapshot.byRoot[this.workspaceRoot] = {
      tabs: this.tabs.map((t) => ({
        id: t.id,
        kind: t.kind,
        filePath: t.filePath,
        fileName: t.fileName,
        mode: t.mode,
      })),
      activeTabId: this.activeTabId,
      touchedAt: Date.now(),
    };

    // Clamp to 20 most recently touched roots.
    const entries = Object.entries(snapshot.byRoot);
    if (entries.length > 20) {
      entries.sort((a, b) => (b[1].touchedAt || 0) - (a[1].touchedAt || 0));
      snapshot.byRoot = Object.fromEntries(entries.slice(0, 20));
    }

    try {
      this.storage.setItem(this.storageKey, JSON.stringify(snapshot));
    } catch {
      // Storage full or unavailable — non-fatal.
    }
  }

  // ─── Private helpers ────────────────────────────────────────────────

  _normalizeRoot(root) {
    if (typeof root !== "string") return "";
    return normalizeLocalPath(root) || "/";
  }

  _normalizePath(filePath) {
    return normalizeLocalPath(filePath);
  }

  _readSnapshot() {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.byRoot) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  _notify() {
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // Listener error — non-fatal.
      }
    }
  }
}
