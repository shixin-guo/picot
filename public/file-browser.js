/**
 * File Browser — right sidebar file tree with drag-and-drop
 */
import { onLocaleChange, t } from "./i18n.js";

const FILE_ICONS = {
  // Folders
  directory: "📁",
  // Code
  js: "📄",
  ts: "📄",
  jsx: "📄",
  tsx: "📄",
  py: "🐍",
  rb: "💎",
  go: "📄",
  rs: "🦀",
  // Web
  html: "🌐",
  css: "🎨",
  svg: "🎨",
  // Data
  json: "📋",
  yaml: "📋",
  yml: "📋",
  toml: "📋",
  xml: "📋",
  csv: "📋",
  // Docs
  md: "📝",
  txt: "📝",
  rst: "📝",
  // Images
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  webp: "🖼️",
  ico: "🖼️",
  // Config
  env: "🔒",
  gitignore: "🔒",
  lock: "🔒",
  // Default
  default: "📄",
};

function getFileIcon(name, isDirectory) {
  if (isDirectory) return FILE_ICONS.directory;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export class FileBrowser {
  constructor(container, pathEl, messageInput) {
    this.container = container;
    this.pathEl = pathEl;
    this.messageInput = messageInput;
    this.currentPath = null;
    this.loadSequence = 0;
    this.fileStatus = null;
    this.fileErrorText = null;

    // Item interactions are delegated to the container — one set of listeners
    // total instead of one per rendered row. `event.target.closest(".file-item")`
    // resolves the originating row (or null when the click missed any row).
    this.container.addEventListener("click", (e) => this.onItemClick(e));
    this.container.addEventListener("dblclick", (e) => this.onItemDoubleClick(e));
    this.container.addEventListener("dragstart", (e) => this.onItemDragStart(e));
    this.container.addEventListener("dragend", (e) => this.onItemDragEnd(e));

    this.setupDropTarget();

    onLocaleChange(() => {
      this.refreshStatusText();
    });
  }
  setWorkspaceRoot(path = "") {
    const normalized = typeof path === "string" ? path.trim() : "";
    // Invalidate any in-flight load so a stale /api/files response can't
    // overwrite the workspace reset.
    this.loadSequence++;
    this.currentPath = null;
    this.fileStatus = null;
    this.pathEl.textContent = normalized;
    this.pathEl.title = normalized;
    this.container.innerHTML = "";
  }

  async load(dirPath) {
    const sequence = ++this.loadSequence;
    this.showFileStatus("loading");

    try {
      const url = dirPath ? `/api/files?path=${encodeURIComponent(dirPath)}` : "/api/files";
      const res = await fetch(url);
      const data = await res.json();

      // A newer load() or setWorkspaceRoot() has superseded this request.
      if (sequence !== this.loadSequence) return;

      if (data.error) {
        this.showFileStatus("error", data.error);
        return;
      }

      this.currentPath = data.path;
      this.pathEl.textContent = data.path;
      this.pathEl.title = data.path;
      this.render(data.items);
    } catch (_err) {
      if (sequence !== this.loadSequence) return;
      this.showFileStatus("failed");
    }
  }

  getParentPath() {
    if (!this.currentPath) return null;
    const parts = this.currentPath.split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  render(items) {
    this.container.innerHTML = "";

    if (items.length === 0) {
      this.showFileStatus("empty");
      return;
    }
    this.fileStatus = null;

    // Build items into a DocumentFragment, then append once — one layout
    // invalidation per refresh instead of N. Item event handling is delegated
    // to a single set of container-level listeners, so per-item listener
    // allocation is also O(1) instead of O(N).
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const el = document.createElement("div");
      el.className = `file-item${item.isDirectory ? " directory" : ""}`;
      el.draggable = true;
      el.dataset.path = item.path;
      el.dataset.name = item.name;
      el.dataset.isDirectory = item.isDirectory ? "true" : "false";

      const icon = getFileIcon(item.name, item.isDirectory);
      const size = item.isDirectory ? "" : formatSize(item.size);

      const iconEl = document.createElement("span");
      iconEl.className = "file-icon";
      iconEl.textContent = icon;
      el.appendChild(iconEl);

      const nameEl = document.createElement("span");
      nameEl.className = "file-name";
      nameEl.title = item.name;
      nameEl.textContent = item.name;
      el.appendChild(nameEl);

      if (size) {
        const sizeEl = document.createElement("span");
        sizeEl.className = "file-size";
        sizeEl.textContent = size;
        el.appendChild(sizeEl);
      }

      fragment.appendChild(el);
    }
    this.container.appendChild(fragment);
  }

  /**
   * Locate the originating `.file-item` for a delegated event. Returns
   * `null` when the event target is outside any row (e.g. clicks on empty
   * space inside the file list).
   */
  itemFromEvent(event) {
    return event.target?.closest?.(".file-item") || null;
  }

  onItemClick(event) {
    const item = this.itemFromEvent(event);
    if (!item) return;
    if (item.dataset.isDirectory === "true") {
      this.load(item.dataset.path);
    }
  }

  onItemDoubleClick(event) {
    const item = this.itemFromEvent(event);
    if (!item) return;
    if (item.dataset.isDirectory !== "true") {
      event.preventDefault();
      this.openNatively(item.dataset.path);
    }
  }

  onItemDragStart(event) {
    const item = this.itemFromEvent(event);
    if (!item) return;
    event.dataTransfer.setData("text/plain", item.dataset.path);
    event.dataTransfer.effectAllowed = "copy";
    item.classList.add("dragging");
  }

  onItemDragEnd(event) {
    const item = this.itemFromEvent(event);
    if (!item) return;
    item.classList.remove("dragging");
  }
  showFileStatus(status, errorText = null) {
    this.fileStatus = status;
    this.fileErrorText = status === "error" ? errorText : null;
    this.container.innerHTML = "";
    const el = document.createElement("div");
    el.className = "file-loading";
    el.textContent = this.statusText();
    this.container.appendChild(el);
  }

  statusText() {
    switch (this.fileStatus) {
      case "loading":
        return t("files.loading");
      case "empty":
        return t("files.empty");
      case "failed":
        return t("files.failedLoad");
      case "error":
        return this.fileErrorText ?? "";
      default:
        return "";
    }
  }

  refreshStatusText() {
    if (!this.fileStatus) return;
    const el = this.container.querySelector(".file-loading");
    if (!el) return;
    el.textContent = this.statusText();
  }

  async openNatively(filePath) {
    try {
      await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
    } catch (err) {
      console.error("[FileBrowser] Failed to open:", err);
    }
  }

  setupDropTarget() {
    const input = this.messageInput;

    input.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      input.classList.add("file-drop-hover");
    });

    input.addEventListener("dragleave", () => {
      input.classList.remove("file-drop-hover");
    });

    input.addEventListener("drop", (e) => {
      e.preventDefault();
      input.classList.remove("file-drop-hover");

      const filePath = e.dataTransfer.getData("text/plain");
      if (filePath?.startsWith("/")) {
        // Insert file path at cursor
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const before = input.value.substring(0, start);
        const after = input.value.substring(end);
        const insert = filePath;
        input.value = before + insert + after;
        input.selectionStart = input.selectionEnd = start + insert.length;
        input.focus();

        // Trigger input event for auto-resize
        input.dispatchEvent(new Event("input"));
      }
    });
  }
}
