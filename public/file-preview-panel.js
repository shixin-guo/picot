/**
 * File Preview Panel — orchestrator module.
 *
 * Owns panel lifecycle, tab bar rendering, active-tab selection, panel
 * enlarge/collapse, splitter behavior, dirty/save/auto-save/conflict flows,
 * floating toolbar, and renderer mounting. Does NOT own directory listing,
 * Markdown parsing, or CodeMirror configuration.
 */

import { createFileRenderer } from "./file-preview-renderers.js";
import { FileTabState } from "./file-tab-state.js";
import { onLocaleChange, t } from "./i18n.js";

const AUTO_SAVE_DELAY = 1500;
const DEFAULT_PANEL_RATIO = 0.42;
const MIN_PANEL_WIDTH = 320;

export class FilePreviewPanel {
  constructor({ panel, resizer, tabBar, content, mainContainer, onOpenDesktop, onCopyText } = {}) {
    this.panel = panel;
    this.resizer = resizer;
    this.tabBar = tabBar;
    this.content = content;
    this.mainContainer = mainContainer;
    this.onOpenDesktop = onOpenDesktop || (() => {});
    this.onCopyText = onCopyText || ((text) => navigator.clipboard?.writeText(text));

    this.state = new FileTabState();
    this.currentRenderer = null;
    this.loadSequence = 0;
    this.autoSaveTimers = new Map();
    this.autoSaveEnabled = true;
    this.wrapLines = false;
    this.panelOpen = false;
    this.enlarged = false;
    this.panelRatio = DEFAULT_PANEL_RATIO;
    this.toolbarOpen = false;

    // Restore preferences
    this._restorePreferences();

    // Set up listeners
    this._setupListeners();
    this._setupResizer();
    this._setupControls();

    // i18n
    this._unsubscribeLocale = onLocaleChange(() => this._renderTabBar());
  }

  setWorkspaceRoot(root) {
    this.workspaceRoot = root || "";
    this.state.load(this.workspaceRoot);
    this._renderTabBar();

    // Restore tabs from persisted state.
    if (this.state.getTabs().length > 0 && !this.panelOpen) {
      this._openPanel();
      const activeTab = this.state.getActiveTab();
      if (activeTab) {
        void this._loadTabContent(activeTab);
      }
    }
  }

  async openFile(filePath, metadata = {}) {
    const tab = this.state.openFile(filePath, metadata);
    this._openPanel();
    this._renderTabBar();
    await this._loadTabContent(tab);
  }

  closePanel() {
    // Check for dirty tabs.
    const dirtyTabs = this.state.getTabs().filter((t) => t.dirty);
    if (dirtyTabs.length > 0) {
      // For now, just confirm the first dirty tab.
      // A full implementation would show a dialog.
      return false;
    }
    this._closePanel();
    return true;
  }

  enlarge() {
    this.enlarged = true;
    this.panel.classList.add("enlarged");
    this.panel.classList.remove("collapsed");
    if (this.mainContainer) this.mainContainer.classList.add("preview-enlarged");
    this._savePreferences();
    this._updateControlButtons();
  }

  collapse() {
    this.enlarged = false;
    this.panel.classList.remove("enlarged");
    if (this.mainContainer) this.mainContainer.classList.remove("preview-enlarged");
    this._savePreferences();
    this._updateControlButtons();
  }

  destroy() {
    // Flush all pending auto-saves.
    for (const timer of this.autoSaveTimers.values()) {
      clearTimeout(timer);
    }
    this.autoSaveTimers.clear();

    if (this.currentRenderer) {
      this.currentRenderer.destroy();
      this.currentRenderer = null;
    }

    if (this._unsubscribeLocale) {
      this._unsubscribeLocale();
    }
  }

  // ─── Private: panel state ────────────────────────────────────────────

  _openPanel() {
    this.panelOpen = true;
    this.panel.classList.remove("collapsed");
    this.resizer.classList.remove("collapsed");
    this._updatePanelWidth();
    this._updateControlButtons();
  }

  _closePanel() {
    this.panelOpen = false;
    this.panel.classList.add("collapsed");
    this.resizer.classList.add("collapsed");
    if (this.currentRenderer) {
      this.currentRenderer.destroy();
      this.currentRenderer = null;
    }
    this.content.innerHTML = "";
    this._updateControlButtons();
  }

  _updateControlButtons() {
    const enlargeBtn = document.getElementById("file-preview-enlarge");
    const collapseBtn = document.getElementById("file-preview-collapse");
    if (enlargeBtn) enlargeBtn.classList.toggle("hidden", this.enlarged);
    if (collapseBtn) collapseBtn.classList.toggle("hidden", !this.enlarged);
  }

  _updatePanelWidth() {
    if (!this.panel || !this.mainContainer) return;
    const totalWidth = this.mainContainer.offsetWidth || 800;
    const panelWidth = Math.max(MIN_PANEL_WIDTH, Math.round(totalWidth * this.panelRatio));
    this.panel.style.width = `${panelWidth}px`;
    this.panel.style.flexBasis = `${panelWidth}px`;
  }

  // ─── Private: tab bar rendering ──────────────────────────────────────

  _renderTabBar() {
    if (!this.tabBar) return;
    this.tabBar.innerHTML = "";

    for (const tab of this.state.getTabs()) {
      const tabEl = document.createElement("div");
      tabEl.className = `file-preview-tab${tab.id === this.state.activeTabId ? " active" : ""}`;
      tabEl.dataset.tabId = tab.id;

      // File icon
      const icon = document.createElement("span");
      icon.className = "file-preview-tab-icon";
      icon.textContent = this._getFileIcon(tab.fileName);
      tabEl.appendChild(icon);

      // File name
      const name = document.createElement("span");
      name.className = "file-preview-tab-name";
      name.textContent = tab.fileName;
      name.title = tab.filePath;
      tabEl.appendChild(name);

      // Dirty/conflict markers
      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "file-preview-tab-dirty";
        dot.textContent = "●";
        tabEl.appendChild(dot);
      }
      if (tab.conflict) {
        const warn = document.createElement("span");
        warn.className = "file-preview-tab-conflict";
        warn.textContent = "⚠";
        warn.title = t("files.preview.conflict");
        tabEl.appendChild(warn);
      }

      // Close button
      const closeBtn = document.createElement("button");
      closeBtn.className = "file-preview-tab-close";
      closeBtn.setAttribute("aria-label", t("files.preview.close"));
      closeBtn.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._closeTab(tab.id);
      });
      tabEl.appendChild(closeBtn);

      // Tab click selects it.
      tabEl.addEventListener("click", () => {
        this._selectTab(tab.id);
      });

      this.tabBar.appendChild(tabEl);
    }
  }

  _getFileIcon(fileName) {
    const ext = (fileName.split(".").pop() || "").toLowerCase();
    const iconMap = {
      js: "📄",
      ts: "📄",
      jsx: "📄",
      tsx: "📄",
      py: "🐍",
      r: "📊",
      R: "📊",
      json: "📋",
      yaml: "📋",
      yml: "📋",
      md: "📝",
      markdown: "📝",
      html: "🌐",
      css: "🎨",
      png: "🖼️",
      jpg: "🖼️",
      jpeg: "🖼️",
      gif: "🖼️",
      svg: "🎨",
      pdf: "📕",
    };
    return iconMap[ext] || "📄";
  }

  // ─── Private: tab selection ──────────────────────────────────────────

  async _selectTab(tabId) {
    // Check if current tab is dirty before switching.
    const currentTab = this.state.getActiveTab();
    if (currentTab?.dirty && currentTab.id !== tabId) {
      // In a full implementation, this would show a confirm dialog.
      // For now, proceed (the dirty content is preserved in memory).
    }

    // Save current editor content before switching.
    if (this.currentRenderer && currentTab) {
      const content = this.currentRenderer.getValue?.();
      if (typeof content === "string") {
        this.state.updateTab(currentTab.id, { content });
      }
    }

    this.state.selectTab(tabId);
    this._renderTabBar();

    const tab = this.state.getTab(tabId);
    if (tab) {
      await this._mountRenderer(tab);
    }
  }

  _closeTab(tabId) {
    const tab = this.state.getTab(tabId);
    if (tab?.dirty) {
      // In a full implementation, this would show a confirm dialog.
    }

    // Clear pending auto-save timer for this tab.
    const timer = this.autoSaveTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      this.autoSaveTimers.delete(tabId);
    }

    const result = this.state.closeTab(tabId);
    this._renderTabBar();

    if (result.nextTabId) {
      this._selectTab(result.nextTabId);
    } else if (this.state.getTabs().length === 0) {
      this._closePanel();
    }
  }

  // ─── Private: content loading ────────────────────────────────────────

  async _loadTabContent(tab) {
    const sequence = ++this.loadSequence;
    this.state.updateTab(tab.id, { loading: true, error: null });

    try {
      const res = await fetch(`/api/files/content?path=${encodeURIComponent(tab.filePath)}`);
      if (sequence !== this.loadSequence) return; // stale response

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        this.state.updateTab(tab.id, {
          loading: false,
          error: errorData.error || `HTTP ${res.status}`,
        });
        this._renderTabBar();
        await this._mountRenderer(tab);
        return;
      }

      const data = await res.json();
      if (sequence !== this.loadSequence) return;

      this.state.updateTab(tab.id, {
        loading: false,
        content: data.content,
        originalContent: data.content,
        mtimeMs: data.mtimeMs,
        dirty: false,
      });

      this._renderTabBar();
      const freshTab = this.state.getTab(tab.id);
      if (freshTab) await this._mountRenderer(freshTab);
    } catch (err) {
      if (sequence !== this.loadSequence) return;
      this.state.updateTab(tab.id, { loading: false, error: err.message });
      this._renderTabBar();
      await this._mountRenderer(tab);
    }
  }

  async _mountRenderer(tab) {
    // Destroy previous renderer.
    if (this.currentRenderer) {
      this.currentRenderer.destroy();
      this.currentRenderer = null;
    }

    this.content.innerHTML = "";

    // Show loading state.
    if (tab.loading) {
      const loadingEl = document.createElement("div");
      loadingEl.className = "file-preview-loading";
      loadingEl.textContent = t("files.preview.loading");
      this.content.appendChild(loadingEl);
      return;
    }

    // Show error state.
    if (tab.error) {
      const errorEl = document.createElement("div");
      errorEl.className = "file-preview-error";
      errorEl.textContent = tab.error;
      this.content.appendChild(errorEl);
      return;
    }

    this.currentRenderer = createFileRenderer({
      filePath: tab.filePath,
      fileName: tab.fileName,
      content: tab.content || "",
      mimeType: tab.mimeType,
      mode: tab.mode || "preview",
      readOnly: tab.mode === "preview",
      wrapLines: this.wrapLines,
      onChange: (newContent) => {
        const freshTab = this.state.getTab(tab.id);
        this.state.updateTab(tab.id, {
          content: newContent,
          dirty: newContent !== (freshTab?.originalContent ?? tab.originalContent),
        });
        this._renderTabBar();
        this._scheduleAutoSave(tab.id);
      },
      onError: (err) => {
        this.state.updateTab(tab.id, { error: err.message });
        this._renderTabBar();
      },
    });

    this.currentRenderer.mount(this.content);
  }

  // ─── Private: auto-save ──────────────────────────────────────────────

  _scheduleAutoSave(tabId) {
    if (!this.autoSaveEnabled) return;

    // Clear existing timer.
    const existing = this.autoSaveTimers.get(tabId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.autoSaveTimers.delete(tabId);
      void this._saveTab(tabId, { autoSave: true });
    }, AUTO_SAVE_DELAY);

    this.autoSaveTimers.set(tabId, timer);
  }

  async _saveTab(tabId, { autoSave = false } = {}) {
    const tab = this.state.getTab(tabId);
    if (!tab?.dirty) return;

    this.state.updateTab(tabId, { saving: true });
    this._renderTabBar();

    try {
      const res = await fetch("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: tab.filePath,
          content: tab.content,
          expectedMtimeMs: tab.mtimeMs,
        }),
      });

      if (res.status === 409) {
        // Conflict.
        this.state.updateTab(tabId, { saving: false, conflict: true });
        this._renderTabBar();
        if (!autoSave) {
          // Show conflict UI for explicit saves.
        }
        // For auto-save, just mark conflict and wait.
        return;
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        this.state.updateTab(tabId, {
          saving: false,
          error: errorData.error || `HTTP ${res.status}`,
        });
        this._renderTabBar();
        return;
      }

      const data = await res.json();
      this.state.updateTab(tabId, {
        saving: false,
        dirty: false,
        conflict: false,
        mtimeMs: data.mtimeMs,
        originalContent: tab.content,
      });
      this._renderTabBar();
    } catch (err) {
      this.state.updateTab(tabId, { saving: false, error: err.message });
      this._renderTabBar();
    }
  }

  // ─── Private: toolbar ────────────────────────────────────────────────

  _setupControls() {
    const enlargeBtn = document.getElementById("file-preview-enlarge");
    const collapseBtn = document.getElementById("file-preview-collapse");
    const closeBtn = document.getElementById("file-preview-close");

    if (enlargeBtn) {
      enlargeBtn.addEventListener("click", () => this.enlarge());
    }
    if (collapseBtn) {
      collapseBtn.addEventListener("click", () => this.collapse());
    }
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.closePanel());
    }
  }

  // ─── Private: resizer ────────────────────────────────────────────────

  _setupResizer() {
    if (!this.resizer) return;

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startWidth = this.panel.offsetWidth;
      this.resizer.classList.add("dragging");
      document.body.classList.add("file-preview-resizing");
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!dragging) return;
      const delta = startX - e.clientX; // right side: drag left = wider
      const newWidth = startWidth + delta;
      const totalWidth = this.mainContainer?.offsetWidth || 800;
      const minWidth = MIN_PANEL_WIDTH;
      const maxWidth = totalWidth * 0.7;
      const clampedWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
      this.panel.style.width = `${clampedWidth}px`;
      this.panel.style.flexBasis = `${clampedWidth}px`;
      this.panelRatio = clampedWidth / totalWidth;
    };

    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      this.resizer.classList.remove("dragging");
      document.body.classList.remove("file-preview-resizing");
      this._savePreferences();
    };

    this.resizer.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  // ─── Private: listeners ──────────────────────────────────────────────

  _setupListeners() {
    this.state.subscribe(() => this._renderTabBar());
  }

  // ─── Private: preferences ────────────────────────────────────────────

  _restorePreferences() {
    try {
      this.panelRatio =
        Number.parseFloat(localStorage.getItem("picot-preview-panel-ratio")) || DEFAULT_PANEL_RATIO;
      this.wrapLines = localStorage.getItem("picot-preview-wrap") === "true";
      this.autoSaveEnabled = localStorage.getItem("picot-preview-autosave") !== "false";
    } catch {
      // localStorage unavailable — use defaults.
    }
  }

  _savePreferences() {
    try {
      localStorage.setItem("picot-preview-panel-ratio", String(this.panelRatio));
      localStorage.setItem("picot-preview-wrap", String(this.wrapLines));
      localStorage.setItem("picot-preview-autosave", String(this.autoSaveEnabled));
    } catch {
      // non-fatal
    }
  }
}
