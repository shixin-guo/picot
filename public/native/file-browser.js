/**
 * Native file browser — right sidebar file tree backed by the Host data
 * plane. Unlike the legacy `FileBrowser`, every listing is a `list_files`
 * data request scoped to the current workspace root; there is no absolute
 * filesystem path to escape to.
 */
export class NativeFileBrowser {
  #container;
  #pathEl;
  #gateway;
  #workspaceId;
  #requestId = 0;
  #onPathChange;
  currentPath = null;

  /**
   * @param {HTMLElement} container - scrollable list container
   * @param {HTMLElement} pathEl - breadcrumb text element
   * @param {object} gateway - data gateway with listFiles()
   * @param {string} workspaceId
   * @param {{ onPathChange?: (path: string) => void }} [options]
   */
  constructor(container, pathEl, gateway, workspaceId, { onPathChange } = {}) {
    this.#container = container;
    this.#pathEl = pathEl;
    this.#gateway = gateway;
    this.#workspaceId = workspaceId;
    this.#onPathChange = onPathChange ?? null;
  }

  async load(relativePath = "") {
    this.#container.replaceChildren(loadingRow());

    // Guard against out-of-order responses the same way the legacy browser
    // does: a slower request for a directory the user has already navigated
    // away from must not clobber a newer, faster response.
    this.#requestId += 1;
    const requestId = this.#requestId;

    try {
      const response = await this.#gateway.listFiles(this.#workspaceId, relativePath);
      if (requestId !== this.#requestId) return;
      this.currentPath = relativePath;
      this.#pathEl.textContent = relativePath || "/";
      this.#pathEl.title = relativePath || "/";
      this.#onPathChange?.(relativePath);
      this.#render(response.entries ?? []);
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

  #render(entries) {
    this.#container.replaceChildren();
    if (entries.length === 0) {
      this.#container.append(messageRow("Empty directory"));
      return;
    }
    for (const entry of entries) {
      const isDirectory = entry.kind === "directory";
      const item = document.createElement("div");
      item.className = `file-item${isDirectory ? " directory" : ""}`;
      item.dataset.path = entry.relativePath;
      item.dataset.name = entry.name;
      item.dataset.isDirectory = String(isDirectory);

      const icon = document.createElement("span");
      icon.className = "file-icon";
      icon.textContent = fileIcon(entry);
      icon.setAttribute("aria-hidden", "true");
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
      }
      this.#container.append(item);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Return an emoji glyph for the file entry based on its type / extension. */
function fileIcon(entry) {
  if (entry.kind === "directory") return "📁";

  // Special filenames
  if (entry.name === "Dockerfile" || entry.name.startsWith("Dockerfile.")) return "🐳";
  if (entry.name === ".gitignore" || entry.name === ".gitattributes") return "🔧";

  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const map = {
    // Code
    js: "📜",
    ts: "📜",
    jsx: "📜",
    tsx: "📜",
    mjs: "📜",
    cjs: "📜",
    // Data / config
    json: "📋",
    yaml: "📋",
    yml: "📋",
    toml: "📋",
    xml: "📋",
    csv: "📋",
    // Docs
    md: "📝",
    mdx: "📝",
    txt: "📝",
    rst: "📝",
    // Styles
    css: "🎨",
    scss: "🎨",
    sass: "🎨",
    less: "🎨",
    // Web
    html: "🌐",
    htm: "🌐",
    // Images (svg stays 🌐 here because it's usually source, not binary)
    svg: "🌐",
    png: "🖼️",
    jpg: "🖼️",
    jpeg: "🖼️",
    gif: "🖼️",
    webp: "🖼️",
    ico: "🖼️",
    bmp: "🖼️",
    // Video
    mp4: "🎬",
    mov: "🎬",
    avi: "🎬",
    webm: "🎬",
    mkv: "🎬",
    // Audio
    mp3: "🎵",
    wav: "🎵",
    ogg: "🎵",
    flac: "🎵",
    aac: "🎵",
    // Archives
    zip: "📦",
    tar: "📦",
    gz: "📦",
    bz2: "📦",
    rar: "📦",
    "7z": "📦",
    // Docs / binary
    pdf: "📕",
    // Languages
    rs: "🦀",
    py: "🐍",
    rb: "💎",
    go: "🔵",
    java: "☕",
    kt: "🟣",
    swift: "🔶",
    c: "⚙️",
    cpp: "⚙️",
    h: "⚙️",
    hpp: "⚙️",
    // Shell
    sh: "⚡",
    bash: "⚡",
    zsh: "⚡",
    fish: "⚡",
    ps1: "⚡",
    // Lock / env
    lock: "🔒",
    env: "🔑",
  };
  return map[ext] ?? "📄";
}

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
