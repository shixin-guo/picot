/**
 * File Browser — right sidebar file tree with drag-and-drop
 */
import { onLocaleChange, t } from "../i18n.js";
import { normalizeLocalPath, parentLocalPath } from "./path-utils.js";

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
  constructor(container, pathEl, messageInput, options = {}) {
    this.container = container;
    this.pathEl = pathEl;
    this.messageInput = messageInput;
    this.onFileSelect = options.onFileSelect || null;
    this.currentPath = null;
    this.workspaceRoot = "";
    this.loadSequence = 0;
    this.fileStatus = null;
    this.fileErrorText = null;

    // Item interactions are delegated to the container — one set of listeners
    // total instead of one per rendered row. `event.target.closest(".file-item")`
    // resolves the originating row (or null when the click missed any row).
    this.container.addEventListener("click", (e) => this.onItemClick(e));
    this.container.addEventListener("dblclick", (e) => this.onItemDoubleClick(e));
    this.container.addEventListener("mousedown", (e) => this.onItemMouseDown(e));

    onLocaleChange(() => {
      this.refreshStatusText();
    });
  }

  setWorkspaceRoot(path = "") {
    const normalized = normalizeLocalPath(path);
    this.workspaceRoot = normalized;
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
      const url = dirPath
        ? `/api/files?path=${encodeURIComponent(dirPath)}&scope=workspace`
        : "/api/files?scope=workspace";
      const res = await fetch(url);
      const data = await res.json();

      // A newer load() or setWorkspaceRoot() has superseded this request.
      if (sequence !== this.loadSequence) return;
      if (res.ok === false || data.error) {
        this.showFileStatus("failed", data.error || `HTTP ${res.status}`);
        return;
      }

      const normalizedRoot = normalizeLocalPath(this.workspaceRoot);
      const normalizedRequest = typeof dirPath === "string" ? normalizeLocalPath(dirPath) : "";
      if (!dirPath || (normalizedRoot && normalizedRequest === normalizedRoot)) {
        this.workspaceRoot = data.path;
      }
      this.currentPath = data.path;
      this.pathEl.textContent = data.path;
      this.pathEl.title = data.path;
      this.render(data.items);
    } catch (error) {
      if (sequence !== this.loadSequence) return;
      this.showFileStatus("failed", error instanceof Error ? error.message : String(error));
    }
  }
  getParentPath() {
    if (!this.currentPath) return null;
    const parent = parentLocalPath(this.currentPath);
    const normalizedRoot = normalizeLocalPath(this.workspaceRoot);
    if (!parent || !normalizedRoot || normalizeLocalPath(this.currentPath) === normalizedRoot)
      return null;

    // Clamp to workspace root using path segments, so sibling prefixes such as
    // /work/app and /work/application cannot bypass the workspace boundary.
    const parentSegments = parent.split("/").filter(Boolean);
    const rootSegments = normalizedRoot.split("/").filter(Boolean);
    const isInsideRoot = rootSegments.every((segment, index) => parentSegments[index] === segment);
    return isInsideRoot ? parent : null;
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
      el.draggable = false;
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

  itemFromEvent(event) {
    return event.target?.closest?.(".file-item") || null;
  }

  onItemClick(event) {
    const item = this.itemFromEvent(event);
    if (!item) return;
    if (item.dataset.isDirectory === "true") {
      this.load(item.dataset.path);
    } else {
      // Single-click on a file → trigger onFileSelect callback for preview.
      if (this.onFileSelect) {
        this.onFileSelect(item.dataset.path, {
          name: item.dataset.name,
          path: item.dataset.path,
        });
      }
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

  /**
   * Custom drag-to-chat via mouse events. WKWebView does not fire
   * dragover/dragend/drop — only dragstart — making HTML5 DnD unusable.
   * We listen for mousedown on file rows, start a custom drag after a
   * small movement threshold, and detect the drop target with
   * elementFromPoint on mouseup.
   */
  onItemMouseDown(event) {
    if (event.button !== 0) return;
    const item = this.itemFromEvent(event);
    if (!item || item.dataset.isDirectory === "true") return;
    event.preventDefault();

    const filePath = item.dataset.path;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let composerFocused = false;
    let ghost = null;
    const input = this.messageInput;
    const card = input.closest("#composer-card");

    const onMove = (e) => {
      if (!dragging) {
        if (Math.abs(e.clientX - startX) < 4 && Math.abs(e.clientY - startY) < 4) return;
        dragging = true;
        item.classList.add("dragging");
        document.body.classList.add("file-dragging");
        ghost = document.createElement("div");
        ghost.className = "file-drag-ghost";
        ghost.textContent = item.dataset.name;
        document.body.appendChild(ghost);
      }
      if (ghost) {
        ghost.style.left = `${e.clientX}px`;
        ghost.style.top = `${e.clientY}px`;
      }
      if (card) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const overComposer = !!el && (el === card || card.contains(el));
        card.classList.toggle("file-drop-hover", overComposer);
        if (overComposer && !composerFocused) {
          composerFocused = true;
          input.focus();
        }
      }
    };

    const onUp = (e) => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      item.classList.remove("dragging");
      document.body.classList.remove("file-dragging");
      if (ghost) ghost.remove();
      if (card) card.classList.remove("file-drop-hover");

      if (!dragging) return;

      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || !card) return;
      const overComposer = el === card || card.contains(el);
      if (!overComposer) return;

      // Keep focus inside the trusted mouse gesture. WKWebView may reject
      // focus requests deferred beyond mouseup, leaving the mention inserted
      // without an active composer.
      e.preventDefault();
      this.insertFileMention(filePath);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }
  showFileStatus(status, errorText = null) {
    this.fileStatus = status;
    this.fileErrorText = errorText;
    this.container.innerHTML = "";
    const el = document.createElement("div");
    el.className = "file-loading";
    el.textContent = this.statusText();
    if (errorText) el.title = errorText;
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

  /**
   * Compute a workspace-relative mention token (`@<posix-relpath>`) for an
   * absolute file path, or null when no workspace root is known or the file
   * is not representable as a relative path. Segment-based (not startsWith)
   * so trailing/double slashes fold cleanly, sibling prefixes are
   * disambiguated, and different Windows drives are rejected.
   */
  toMentionPath(filePath) {
    if (!this.workspaceRoot || typeof filePath !== "string" || filePath === "") return null;

    const segs = (p) =>
      p
        .replace(/\\/g, "/")
        .split("/")
        .filter((s) => s !== "" && s !== ".");
    const rootSegs = segs(this.workspaceRoot);
    const fileSegs = segs(filePath);

    if (rootSegs.length === 0) return null;
    if (fileSegs.includes("..") || rootSegs.includes("..")) return null;

    // Reject cross-drive Windows paths (e.g. root C: vs file D:)
    const isDriveSeg = (s) => /^[A-Za-z]:$/.test(s);
    const isWindowsPath =
      isDriveSeg(rootSegs[0]) ||
      isDriveSeg(fileSegs[0]) ||
      this.workspaceRoot.replace(/\\/g, "/").startsWith("//") ||
      filePath.replace(/\\/g, "/").startsWith("//");
    const sameSegment = (left, right) =>
      isWindowsPath ? left.toLowerCase() === right.toLowerCase() : left === right;
    if (
      !sameSegment(rootSegs[0], fileSegs[0]) &&
      (isDriveSeg(rootSegs[0]) || isDriveSeg(fileSegs[0]))
    )
      return null;

    // Find common prefix length
    let i = 0;
    while (i < rootSegs.length && i < fileSegs.length && sameSegment(rootSegs[i], fileSegs[i])) {
      i++;
    }

    const upCount = rootSegs.length - i;
    const remaining = fileSegs.slice(i);
    if (remaining.length === 0) return null; // file is an ancestor dir of root

    const parts = [];
    for (let j = 0; j < upCount; j++) parts.push("..");
    parts.push(...remaining);
    return `@${parts.join("/")}`;
  }

  /**
   * Insert a file mention (`@<relative-path>`) at the textarea selection.
   * Called by the composer-card drop handler in app.js. Returns true when
   * a mention was inserted, false when the path is not a representable file.
   */
  insertFileMention(filePath) {
    if (!filePath) return false;
    const mention = this.toMentionPath(filePath);
    if (!mention) return false;

    const input = this.messageInput;
    input.focus();
    // setRangeText triggers WKWebView's native text-edit repaint,
    // unlike direct .value assignment which may not visually update.
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    try {
      input.setRangeText(mention, start, end, "end");
    } catch {
      // Fallback for environments without setRangeText
      const before = input.value.substring(0, start);
      const after = input.value.substring(end);
      input.value = before + mention + after;
      input.selectionStart = input.selectionEnd = start + mention.length;
    }
    input.dispatchEvent(new Event("input"));
    return true;
  }
}
