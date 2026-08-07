/**
 * Native file browser — right sidebar file tree backed by the Host data
 * plane. Unlike the legacy `FileBrowser`, every listing is a `list_files`
 * data request scoped to the current workspace root; there is no absolute
 * filesystem path to escape to.
 */
import { createFileTypeIcon } from "../../file-type-icons.js";

export class NativeFileBrowser {
  #container;
  #pathEl;
  #gateway;
  #workspaceId;
  #requestId = 0;
  #onFileOpen;
  #onFileSelect;
  #onPathChange;
  #gitFiles = [];
  #gitStat = null;
  #entries = [];
  #view = "files";
  #showViewSwitch = true;
  currentPath = null;

  /**
   * @param {HTMLElement} container - scrollable list container
   * @param {HTMLElement} pathEl - breadcrumb text element
   * @param {object} gateway - data gateway with listFiles()
   * @param {string} workspaceId
   * @param {{
   *   onFileOpen?: (entry: object) => void,
   *   onFileSelect?: (entry: object) => void,
   *   onPathChange?: (path: string) => void,
   * }} [options]
   */
  constructor(
    container,
    pathEl,
    gateway,
    workspaceId,
    { onFileOpen, onFileSelect, onPathChange, initialView = "files", showViewSwitch = true } = {},
  ) {
    this.#container = container;
    this.#pathEl = pathEl;
    this.#gateway = gateway;
    this.#workspaceId = workspaceId;
    this.#onFileOpen = onFileOpen ?? null;
    this.#onFileSelect = onFileSelect ?? null;
    this.#onPathChange = onPathChange ?? null;
    this.#view = initialView === "diff" ? "diff" : "files";
    this.#showViewSwitch = showViewSwitch;
  }

  async load(relativePath = "") {
    this.#container.replaceChildren(loadingRow());

    // Guard against out-of-order responses the same way the legacy browser
    // does: a slower request for a directory the user has already navigated
    // away from must not clobber a newer, faster response.
    this.#requestId += 1;
    const requestId = this.#requestId;

    try {
      const [response] = await Promise.all([
        this.#gateway.listFiles(this.#workspaceId, relativePath),
        this.#loadGitStatus(),
        this.#loadGitStat(),
      ]);
      if (requestId !== this.#requestId) return;
      this.currentPath = relativePath;
      this.#entries = response.entries ?? [];
      this.#pathEl.textContent = relativePath || "/";
      this.#pathEl.title = relativePath || "/";
      this.#onPathChange?.(relativePath);
      this.#render();
    } catch (error) {
      if (requestId !== this.#requestId) return;
      this.#container.replaceChildren(messageRow(error?.message || "Failed to load"));
    }
  }

  getParentPath() {
    if (this.currentPath === null || this.currentPath === "") return null;
    const parts = this.currentPath.split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }

  #render() {
    this.#container.replaceChildren();
    if (this.#showViewSwitch) this.#renderViewSwitch();
    if (this.#view === "diff") {
      this.#renderChanges();
      return;
    }
    if (this.#entries.length === 0) {
      this.#container.append(messageRow("Empty directory"));
      return;
    }
    for (const entry of this.#entries) {
      const isDirectory = entry.kind === "directory";
      const item = document.createElement("div");
      item.className = `file-item${isDirectory ? " directory" : ""}`;
      item.dataset.path = entry.relativePath;
      item.dataset.name = entry.name;
      item.dataset.isDirectory = String(isDirectory);

      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.append(
        createFileTypeIcon({
          name: entry.name,
          isDirectory,
          expanded: isDirectory,
        }),
      );
      item.append(icon);

      const name = document.createElement("span");
      name.className = "file-name";
      name.title = entry.name;
      name.textContent = entry.name;
      item.append(name);

      if (!isDirectory && entry.size != null) {
        const size = document.createElement("span");
        size.className = "file-size";
        size.textContent = formatSize(entry.size);
        item.append(size);
      }

      if (isDirectory) {
        item.addEventListener("click", () => this.load(entry.relativePath));
      } else {
        item.addEventListener("click", () => this.#onFileSelect?.(entry));
        item.addEventListener("dblclick", () => this.#onFileOpen?.(entry));
      }
      this.#container.append(item);
    }
  }

  #renderViewSwitch() {
    const switcher = document.createElement("div");
    switcher.className = "file-browser-view-switch ui-toolbar";
    for (const [view, label] of [
      ["files", "Files"],
      ["diff", "Diff"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ui-button ui-button--sm ui-button--ghost${this.#view === view ? " active" : ""}`;
      button.textContent = label;
      button.setAttribute("aria-pressed", String(this.#view === view));
      button.addEventListener("click", () => {
        this.#view = view;
        this.#render();
      });
      switcher.append(button);
    }
    this.#container.append(switcher);
  }

  async #loadGitStatus() {
    try {
      const url = new URL("/api/git/status", window.location.origin);
      url.searchParams.set("workspaceId", this.#workspaceId);
      const response = await fetch(url);
      const data = response.ok ? await response.json() : null;
      this.#gitFiles = data?.isGitRepository && Array.isArray(data.files) ? data.files : [];
    } catch {
      this.#gitFiles = [];
    }
  }

  async #loadGitStat() {
    try {
      const url = new URL("/api/git/stat", window.location.origin);
      url.searchParams.set("workspaceId", this.#workspaceId);
      const response = await fetch(url);
      this.#gitStat = response.ok ? await response.json() : null;
    } catch {
      this.#gitStat = null;
    }
  }

  #renderChanges() {
    if (this.#gitFiles.length === 0) {
      this.#container.append(messageRow("No changes"));
      return;
    }
    const section = document.createElement("section");
    section.className = "file-changes";
    const heading = document.createElement("div");
    heading.className = "file-changes-heading";
    const label = document.createElement("span");
    label.textContent = "Changes";
    const count = document.createElement("span");
    count.className = "ui-badge file-changes-count";
    count.textContent = String(this.#gitFiles.length);
    heading.append(label, count);
    if (this.#gitStat?.isGitRepository) {
      const stat = document.createElement("span");
      stat.className = "file-changes-stat";
      if (this.#gitStat.insertions > 0) {
        const ins = document.createElement("span");
        ins.className = "file-changes-stat--added";
        ins.textContent = `+${this.#gitStat.insertions}`;
        stat.append(ins);
      }
      if (this.#gitStat.deletions > 0) {
        const del = document.createElement("span");
        del.className = "file-changes-stat--removed";
        del.textContent = `-${this.#gitStat.deletions}`;
        stat.append(del);
      }
      heading.append(stat);
    }
    section.append(heading);
    for (const change of this.#gitFiles) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "file-change-item";
      row.title = change.path;
      const badge = document.createElement("span");
      badge.className = "file-git-badge";
      badge.dataset.gitStatus = change.code;
      badge.textContent = change.code;
      const path = document.createElement("span");
      path.className = "file-change-path";
      path.textContent = change.path;
      row.append(badge, path);
      row.addEventListener("click", () =>
        this.#onFileSelect?.({
          name: change.path.split("/").pop(),
          relativePath: change.path,
          kind: "file",
          gitStatus: change.status,
          mode: "diff",
        }),
      );
      section.append(row);
    }
    this.#container.append(section);
  }
}

export function toggleExclusiveSidePanel(panel, otherPanels = []) {
  const willOpen = panel.classList.contains("collapsed");
  if (willOpen) {
    for (const other of otherPanels) other?.classList.add("collapsed");
  }
  panel.classList.toggle("collapsed", !willOpen);
  return willOpen;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Human-readable byte size (B / KB / MB / GB). */
function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function loadingRow() {
  return messageRow("Loading…");
}

function messageRow(text) {
  const row = document.createElement("div");
  row.className = "file-loading";
  row.textContent = text;
  return row;
}
