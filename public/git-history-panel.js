// ABOUTME: Renders Git first-parent history, commit details, and pagination.
// ABOUTME: Keeps log/detail request channels independent and opens authorized commit diffs.
import { getLocale, t } from "./i18n.js";

const PAGE_SIZE = 50;

export class GitHistoryPanel {
  constructor({ container, client, onDiffRequest } = {}) {
    this.container = container;
    this.client = client;
    this.onDiffRequest = onDiffRequest;
    this._active = false;
    this._unavailable = false;
    this._logRequestId = null;
    this._detailRequestId = null;
    this._commits = [];
    this._hasMore = false;
    this._selectedOid = null;
    this._oid = null;
    this._detailExpanded = false;
    this._splitRatio = 0.5;
    this._resizeCleanup = null;
    this._buildDom();
    this._renderList();
    this._renderDetail();
  }
  _buildDom() {
    this.container.replaceChildren();
    this.listSection = document.createElement("section");
    this.listSection.className = "git-history-section git-history-list-section";
    this.list = document.createElement("div");
    this.list.className = "git-history-list";
    this.listSection.append(this.list);
    this.detailSection = document.createElement("section");
    this.detailSection.className = "git-history-section git-history-detail-section";
    this.detail = document.createElement("div");
    this.detail.className = "git-history-detail-body";
    this.detailSection.append(this.detail);
    this.divider = document.createElement("div");
    this.divider.className = "git-history-divider";
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-orientation", "horizontal");
    this.divider.setAttribute("aria-valuemin", "10");
    this.divider.setAttribute("aria-valuemax", "90");
    this.divider.setAttribute("aria-valuenow", "50");
    this.divider.tabIndex = 0;
    this.divider.addEventListener("pointerdown", (event) => this._beginResize(event));
    this.container.append(this.listSection, this.divider, this.detailSection);
    this._updateSplitStyles();
  }
  setActive(active) {
    this._active = Boolean(active);
    this.container.classList.toggle("hidden", !this._active);
    if (!this._active) this._collapseDetail();
  }
  _updateSplitStyles() {
    const listFlex = this._detailExpanded ? this._splitRatio : 1;
    const detailFlex = this._detailExpanded ? 1 - this._splitRatio : 0;
    this.listSection.style.setProperty("--history-flex", String(listFlex));
    this.detailSection.style.setProperty("--history-flex", String(detailFlex));
    this.container.dataset.detailExpanded = String(this._detailExpanded);
    this.divider?.setAttribute("aria-valuenow", String(Math.round(this._splitRatio * 100)));
  }
  _setSplitRatio(ratio) {
    this._splitRatio = Math.max(0.1, Math.min(0.9, Number(ratio) || 0.5));
    this._updateSplitStyles();
  }
  _expandDetail() {
    this._detailExpanded = true;
    this._updateSplitStyles();
  }
  _collapseDetail() {
    this._detailExpanded = false;
    this._updateSplitStyles();
  }
  _beginResize(event) {
    event.preventDefault();
    if (!this._detailExpanded) this._expandDetail();
    const update = (moveEvent) => {
      const rect = this.container.getBoundingClientRect();
      const dividerHeight = this.divider.getBoundingClientRect().height;
      const available = rect.height - dividerHeight;
      if (available <= 0) return;
      this._setSplitRatio((moveEvent.clientY - rect.top) / available);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      this._resizeCleanup = null;
    };
    this._resizeCleanup?.();
    this._resizeCleanup = cleanup;
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", cleanup, { once: true });
    window.addEventListener("pointercancel", cleanup, { once: true });
    this.divider.setPointerCapture?.(event.pointerId);
  }
  setUnavailable(value = true) {
    this._unavailable = Boolean(value);
    if (this._unavailable) this.clearSession();
  }
  clearSession() {
    this._logRequestId = null;
    this._detailRequestId = null;
    this._commits = [];
    this._hasMore = false;
    this._selectedOid = null;
    this._oid = null;
    this._collapseDetail();
    this._renderList();
    this._renderDetail();
  }
  refresh() {
    if (!this._active || this._unavailable) return null;
    this._detailRequestId = null;
    this._selectedOid = null;
    this._oid = null;
    this._collapseDetail();
    const requestId = this.client?.log?.(PAGE_SIZE, null);
    if (!requestId) return null;
    this._logRequestId = requestId;
    this._commits = [];
    this._hasMore = false;
    this._renderList();
    this._renderDetail();
    return requestId;
  }
  loadMore() {
    if (!this._active || this._unavailable || !this._hasMore) return null;
    const before = this._commits.at(-1)?.oid;
    if (!before) return null;
    const requestId = this.client?.log?.(PAGE_SIZE, before);
    if (!requestId) return null;
    this._logRequestId = requestId;
    return requestId;
  }
  applyLog(detail) {
    if (!detail || detail.requestId !== this._logRequestId || !Array.isArray(detail.commits))
      return;
    const seen = new Set(this._commits.map((commit) => commit.oid));
    for (const commit of detail.commits) {
      if (!commit?.oid || seen.has(commit.oid)) continue;
      seen.add(commit.oid);
      this._commits.push(commit);
    }
    this._hasMore = Boolean(detail.hasMore);
    this._renderList();
  }
  selectCommit(oid) {
    if (!this._active || !oid) return null;
    const requestId = this.client?.logDetail?.(oid);
    if (!requestId) return null;
    this._detailRequestId = requestId;
    this._selectedOid = oid;
    this._expandDetail();
    this._renderList();
    return requestId;
  }
  applyLogDetail(detail) {
    if (!detail || detail.requestId !== this._detailRequestId || !detail.commit?.oid) return;
    this._oid = detail.commit.oid;
    this._selectedOid = detail.commit.oid;
    this._renderList();
    this._renderDetail(detail.commit);
  }
  handleFailure(requestId) {
    if (requestId === this._logRequestId) this._logRequestId = null;
    if (requestId === this._detailRequestId) this._detailRequestId = null;
  }
  async copyHash() {
    if (!this._oid) return;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(this._oid);
        return;
      } catch {
        // Fall through to legacy clipboard path.
      }
    }
    const textarea = document.createElement("textarea");
    textarea.value = this._oid;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  }
  _renderList() {
    this.list.replaceChildren();
    if (!this._commits.length) {
      const empty = document.createElement("p");
      empty.className = "git-history-empty";
      empty.textContent = t("git.historyEmpty");
      this.list.append(empty);
      return;
    }
    for (const commit of this._commits) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `git-history-row${commit.oid === this._selectedOid ? " selected" : ""}`;
      const subject = document.createElement("span");
      subject.className = "git-history-subject";
      subject.textContent = commit.subject || "";
      const meta = document.createElement("span");
      meta.className = "git-history-meta";
      meta.textContent = `${this._relativeTime(commit.authorTime)} · ${commit.authorName || ""}`;
      row.append(subject, meta);
      row.addEventListener("click", () => this.selectCommit(commit.oid));
      this.list.append(row);
    }
    if (this._hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "project-sessions-toggle";
      more.textContent = t("sidebar.showMore");
      more.addEventListener("click", () => this.loadMore());
      this.list.append(more);
    }
  }
  _renderDetail(commit = null) {
    this.detail.replaceChildren();
    if (!commit) {
      const hint = document.createElement("p");
      hint.className = "git-history-detail-empty";
      hint.textContent = t("git.historySelectHint");
      this.detail.append(hint);
      return;
    }
    const header = document.createElement("div");
    header.className = "git-history-detail-header";
    const oid = document.createElement("code");
    oid.className = "git-history-oid-short";
    oid.textContent = commit.oid.slice(0, 7);
    oid.setAttribute("role", "button");
    oid.setAttribute("tabindex", "0");
    oid.setAttribute("aria-label", t("git.copyHash"));
    oid.title = t("git.copyHash");
    oid.addEventListener("click", () => void this.copyHash());
    oid.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        void this.copyHash();
      }
    });
    header.append(oid);
    const message = document.createElement("pre");
    message.className = "git-history-message";
    message.textContent = commit.fullMessage || "";
    const truncation = commit.messageTruncated ? document.createElement("small") : null;
    if (truncation) {
      truncation.className = "git-history-message-truncated";
      truncation.textContent = t("git.messageTruncated");
    }
    const filesTruncation = commit.filesTruncated ? document.createElement("small") : null;
    if (filesTruncation) {
      filesTruncation.className = "git-history-files-truncated";
      filesTruncation.textContent = t("git.filesTruncated");
    }
    const files = document.createElement("ul");
    files.className = "git-history-files";
    for (const file of commit.files || []) {
      const row = document.createElement("li");
      row.className = "git-history-file";
      row.tabIndex = 0;
      const status = document.createElement("span");
      status.className = "git-history-file-status";
      status.textContent = file.status || "";
      const path = document.createElement("span");
      path.textContent = file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;
      row.append(status, path);
      const open = () => {
        const requestId = this.client?.commitDiff?.(commit.oid, file.pathBytesBase64);
        if (requestId) {
          this.onDiffRequest?.(requestId, {
            type: "commit_diff",
            comparison: "commit",
            commitOid: commit.oid,
            displayPath: file.path,
            path: file.path,
            originalPath: file.originalPath,
            pathBytesBase64: file.pathBytesBase64,
          });
        }
      };
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
      files.append(row);
    }
    this.detail.append(header, message);
    if (truncation) this.detail.append(truncation);
    if (filesTruncation) this.detail.append(filesTruncation);
    this.detail.append(files);
  }
  _rowEls() {
    return this.list.querySelectorAll(".git-history-row");
  }
  _relativeTime(unixSeconds) {
    const delta = Math.round((Number(unixSeconds) - Date.now() / 1000) / 60);
    const absoluteDelta = Math.abs(delta);
    if (absoluteDelta < 1) return t("git.justNow");
    const units = [
      ["minute", 1, 60],
      ["hour", 60, 1440],
      ["day", 1440, 10080],
      ["week", 10080, 43200],
      ["month", 43200, 525600],
      ["year", 525600, Infinity],
    ];
    const [unit, divisor] = units.find(([, , upperBound]) => absoluteDelta < upperBound);
    return new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" }).format(
      Math.round(delta / divisor),
      unit,
    );
  }
}
