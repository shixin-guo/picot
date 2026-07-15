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
  currentPath = null;

  constructor(container, pathEl, gateway, workspaceId) {
    this.#container = container;
    this.#pathEl = pathEl;
    this.#gateway = gateway;
    this.#workspaceId = workspaceId;
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

      const name = document.createElement("span");
      name.className = "file-name";
      name.title = entry.name;
      name.textContent = entry.name;
      item.append(name);

      if (isDirectory) {
        item.addEventListener("click", () => this.load(entry.relativePath));
      }
      this.#container.append(item);
    }
  }
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
