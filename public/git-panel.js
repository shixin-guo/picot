// ABOUTME: Owns the Git tab, status groups, and safe user-visible Git actions.
// ABOUTME: Renders untrusted repository paths with DOM text nodes and delegates writes to GitClient.

import { createFileTypeIcon } from "./file-type-icons.js";
import { t } from "./i18n.js";
import { createIcon } from "./icons.js";

function createSectionChevron() {
  const chevron = document.createElement("span");
  chevron.className = "section-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.append(createIcon("chevron-down", { size: 16 }));
  return chevron;
}

// Object-icon rendering for Git entries uses the shared Material file-type
// vocabulary from `file-type-icons.js`, so the Git tree stays visually
// consistent with the File Browser and File Preview tabs.
const GROUPS = ["staged", "changes", "untracked", "conflicted"];

export class GitPanel {
  constructor({ container, client, openDiff, onDiffRequest, onStatus, fileList } = {}) {
    this.container = container;
    this.client = client;
    this.openDiff = openDiff;
    this.onDiffRequest = onDiffRequest;
    this.onStatus = onStatus;
    this.fileList = fileList;
    this.snapshot = null;
    this.folded = new Set();
    this.selected = new Set();
    this.aiSnapshot = null;
    this.commitMessage = "";
    this.pendingConfirmationToken = null;
    this.commitDialog = null;
    this.aiError = null;
    this.commitInProgress = false;
    this.pendingCommitRequestId = null;
    this.pendingAiRequestId = null;
  }
  setSnapshot(snapshot) {
    this.snapshot = snapshot;
    const valid = new Set(
      (snapshot?.entries || []).flatMap((entry) =>
        this.groupsFor(entry).map(
          (group) => `${snapshot.snapshotId}:${group}:${entry.pathBytesBase64}`,
        ),
      ),
    );
    this.selected = new Set(
      [...this.selected].filter(
        (identity) =>
          snapshot &&
          identity.split(":").slice(0, 2).join(":") === snapshot.snapshotId &&
          valid.has(identity),
      ),
    );
    this.render();
    this.onStatus?.(snapshot);
  }
  async refresh() {
    const id = this.client?.command({ type: "status" });
    if (!id) return null;
    return id;
  }
  async discard(entries = [], contextGroup = null) {
    if (!entries.length) return null;
    const confirmed = await this.confirmDiscard(entries.length);
    if (!confirmed) return null;
    return this.write("discard", entries, contextGroup);
  }
  confirmDiscard(count) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "git-confirm-dialog-overlay";
      overlay.setAttribute("role", "alertdialog");
      overlay.setAttribute("aria-modal", "true");
      const dialog = document.createElement("div");
      dialog.className = "git-confirm-dialog";
      const message = document.createElement("p");
      message.className = "git-confirm-message";
      message.textContent = t("git.discardConfirm", { count });
      dialog.append(message);
      const actions = document.createElement("div");
      actions.className = "git-confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = t("git.cancel");
      cancel.addEventListener("click", () => {
        overlay.remove();
        resolve(false);
      });
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.textContent = t("git.discard");
      confirm.className = "git-confirm-discard";
      confirm.addEventListener("click", () => {
        overlay.remove();
        resolve(true);
      });
      actions.append(cancel, confirm);
      dialog.append(actions);
      overlay.append(dialog);
      overlay.addEventListener("click", () => {
        // Modal: do not close on overlay click. The user must explicitly
        // cancel or confirm.
      });
      document.body.append(overlay);
      confirm.focus();
    });
  }
  requestAiCommitMessage() {
    if (
      !this.snapshot ||
      this.snapshot.counts?.staged === 0 ||
      this.snapshot.counts?.conflicted > 0
    )
      return null;
    this.aiError = null;
    const requestId = this.client?.aiCommitMessage();
    this.pendingAiRequestId = requestId || null;
    return requestId;
  }
  applyAiResult(snapshot, message) {
    this.pendingAiRequestId = null;
    this.aiSnapshot = snapshot || null;
    this.commitMessage = message || "";
    this.aiError = null;
    this.openCommitDialog();
  }
  applyAiFailure(error) {
    this.pendingAiRequestId = null;
    // Spec: AI failure/timeout must still open the commit dialog with an empty
    // message so the user can write one by hand. If no AI snapshot exists yet,
    // fall back to the current status snapshot so the commit can still bind to
    // a snapshotId, HEAD and index tree.
    if (!this.aiSnapshot?.snapshotId && this.snapshot?.snapshotId) {
      this.aiSnapshot = {
        snapshotId: this.snapshot.snapshotId,
        headState: this.snapshot.headState,
        headOid: this.snapshot.headOid,
        indexTreeOid: this.snapshot.indexTreeOid,
      };
    }
    this.commitMessage = this.commitMessage || "";
    this.aiError = error || t("git.aiFailed");
    this.openCommitDialog();
  }
  applyConfirmationToken(token) {
    this.pendingConfirmationToken = token || null;
    // A confirmation-required response means the first commit attempt was
    // accepted-but-pending, not failed. End the in-progress state so the
    // dialog becomes editable and the submit button is re-enabled for the
    // user to explicitly confirm.
    this.commitInProgress = false;
    if (this.commitDialog) {
      // Re-render the dialog so the confirmation notice appears.
      this.openCommitDialog();
    }
  }
  openCommitDialog() {
    if (!this.aiSnapshot?.snapshotId) return;
    this.closeCommitDialog();
    const overlay = document.createElement("div");
    overlay.className = "git-commit-dialog-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "git-commit-dialog-title");
    const dialog = document.createElement("div");
    dialog.className = "git-commit-dialog";
    const title = document.createElement("h3");
    title.id = "git-commit-dialog-title";
    title.textContent = t("git.commit");
    dialog.append(title);
    if (this.aiError) {
      const error = document.createElement("p");
      error.className = "git-commit-error";
      error.textContent = this.aiError;
      dialog.append(error);
    }
    if (this.pendingConfirmationToken) {
      const notice = document.createElement("p");
      notice.className = "git-commit-confirmation";
      notice.textContent = t("git.confirmationRequired");
      dialog.append(notice);
    }
    const textarea = document.createElement("textarea");
    textarea.className = "git-commit-textarea";
    textarea.value = this.commitMessage || "";
    textarea.setAttribute("aria-label", t("git.commitMessageLabel"));
    textarea.rows = 6;
    textarea.addEventListener("input", () => {
      this.commitMessage = textarea.value;
    });
    dialog.append(textarea);
    const actions = document.createElement("div");
    actions.className = "git-commit-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = t("git.cancel");
    cancel.addEventListener("click", () => this.closeCommitDialog());
    const submit = document.createElement("button");
    submit.type = "button";
    submit.textContent = t("git.commit");
    submit.className = "git-commit-submit";
    submit.addEventListener("click", () => {
      this.commitMessage = textarea.value;
      this.commit();
    });
    actions.append(cancel, submit);
    dialog.append(actions);
    overlay.append(dialog);
    overlay.addEventListener("click", () => {
      // Commit dialog is modal: do not close on overlay click. The user
      // must explicitly cancel or submit.
    });
    document.body.append(overlay);
    this.commitDialog = { overlay, textarea, submit };
    textarea.focus();
    this.updateCommitDialogState();
  }
  closeCommitDialog() {
    if (!this.commitDialog) return;
    this.commitDialog.overlay.remove();
    this.commitDialog = null;
  }
  updateCommitDialogState() {
    if (!this.commitDialog) return;
    this.commitDialog.textarea.disabled = this.commitInProgress;
    this.commitDialog.submit.disabled =
      this.commitInProgress || !this.commitDialog.textarea.value.trim();
    this.commitDialog.submit.textContent = this.commitInProgress
      ? t("git.committing")
      : t("git.commit");
  }
  setCommitInProgress(inProgress) {
    this.commitInProgress = Boolean(inProgress);
    if (inProgress) this.updateCommitDialogState();
    else this.closeCommitDialog();
  }
  applyCommitResult(result) {
    const status = result?.status;
    if (status === "succeeded") {
      this.setCommitInProgress(false);
      this.aiSnapshot = null;
      this.commitMessage = "";
      this.pendingConfirmationToken = null;
      this.pendingCommitRequestId = null;
      return;
    }
    // failed / outcomeUnknown: end the spinner but keep the user's message so
    // they can read the error and retry. Do not clear aiSnapshot — the commit
    // may be retried against the same snapshot once the user fixes the cause.
    this.commitInProgress = false;
    this.pendingCommitRequestId = null;
    if (status === "outcomeUnknown") {
      this.aiError = t("git.outcomeUnknown");
    } else {
      this.aiError = result?.error || t("git.aiFailed");
    }
    if (this.commitDialog) this.openCommitDialog();
  }
  applyCommitFailure(error) {
    // A commit failure (stale snapshot, hook rejection, token error) must not
    // leave the dialog permanently disabled. End the in-progress state,
    // surface the error, and keep the user's message so they can retry.
    this.commitInProgress = false;
    this.aiError = error || t("git.aiFailed");
    if (this.commitDialog) this.openCommitDialog();
  }
  commit(message = this.commitMessage, confirmationToken = this.pendingConfirmationToken) {
    if (!this.aiSnapshot?.snapshotId || !message.trim()) return null;
    this.setCommitInProgress(true);
    const requestId = this.client?.commit(this.aiSnapshot.snapshotId, message, confirmationToken);
    this.pendingCommitRequestId = requestId || null;
    return requestId;
  }
  write(operation, entries = [], contextGroup = null) {
    const snapshotId = this.snapshot?.snapshotId;
    // The caller supplies the group context (the group the user clicked in).
    // Do NOT expand a partial-stage entry into all its groups: staging from
    // the Changes group must send group="changes", not also "staged".
    const selected = entries
      .map((entry) => ({
        group: contextGroup || this.groupsFor(entry)[0],
        pathBytesBase64: entry.pathBytesBase64,
        originalPathBytesBase64: entry.originalPathBytesBase64,
      }))
      .filter((entry) => entry.pathBytesBase64);
    const allowedGroups = {
      stage: new Set(["changes", "untracked", "conflicted"]),
      unstage: new Set(["staged"]),
      discard: new Set(["changes"]),
    };
    if (
      !snapshotId ||
      selected.length === 0 ||
      !allowedGroups[operation] ||
      selected.some((entry) => !allowedGroups[operation].has(entry.group))
    )
      return null;
    return this.client?.write(operation, snapshotId, selected);
  }
  destroy() {
    this.container?.replaceChildren();
  }
  render() {
    if (!this.container) return;
    const scrollTop = this.container.scrollTop;
    this.container.replaceChildren();
    const snapshot = this.snapshot;
    if (!snapshot) {
      const empty = document.createElement("p");
      empty.textContent = t("git.noStatus");
      this.container.append(empty);
      return;
    }
    const selectedEntriesFor = (group) =>
      (snapshot.entries || [])
        .filter((entry) => this.groupsFor(entry).includes(group))
        .filter((entry) =>
          this.selected.has(`${snapshot.snapshotId}:${group}:${entry.pathBytesBase64}`),
        );
    for (const group of GROUPS) {
      const entries = (snapshot.entries || []).filter((entry) =>
        this.groupsFor(entry).includes(group),
      );
      const section = document.createElement("section");
      section.className = `git-group git-group-${group}`;
      const heading = document.createElement("div");
      heading.className = `git-group-heading sidebar-section-header${
        this.folded.has(group) ? " collapsed" : ""
      }`;
      const headingId = `git-group-heading-${group}`;
      heading.id = headingId;
      heading.setAttribute("role", "button");
      heading.tabIndex = 0;
      heading.setAttribute("aria-expanded", String(!this.folded.has(group)));
      heading.setAttribute("aria-controls", `git-group-body-${group}`);
      section.setAttribute("role", "region");
      section.setAttribute("aria-labelledby", headingId);
      heading.appendChild(this._createChevron());
      const label = document.createElement("span");
      label.className = "sidebar-section-title";
      label.textContent = t(`git.${group}`);
      const count = document.createElement("span");
      count.className = "sidebar-section-count";
      count.textContent = String(entries.length);
      heading.append(label, count);
      heading.addEventListener("click", () => {
        this.folded.has(group) ? this.folded.delete(group) : this.folded.add(group);
        this.render();
      });
      heading.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        heading.click();
      });
      section.append(heading);
      if (this.folded.has(group)) {
        this.container.append(section);
        continue;
      }
      const body = document.createElement("div");
      body.className = "git-group-body";
      body.id = `git-group-body-${group}`;
      const tree = this.buildTree(entries);
      this.renderTree(tree, body, snapshot, group, "");
      section.append(body);
      if (snapshot.totalEntryCount > snapshot.returnedEntryCount) {
        const hidden = snapshot.totalEntryCount - snapshot.returnedEntryCount;
        const notice = document.createElement("p");
        notice.className = "git-truncation-notice";
        notice.textContent = t("git.truncated", { count: hidden });
        section.append(notice);
      }
      if (entries.length > 0) {
        const selected = selectedEntriesFor(group);
        const actions = document.createElement("div");
        actions.className = "git-group-actions";
        const operations =
          group === "staged"
            ? ["unstage"]
            : group === "changes"
              ? ["stage", "discard"]
              : group === "conflicted"
                ? ["stage"]
                : ["stage"];
        for (const operation of operations) {
          const action = document.createElement("button");
          action.type = "button";
          const targetCount = selected.length > 0 ? selected.length : entries.length;
          action.textContent = `${t(`git.${operation}`)} (${targetCount})`;
          action.addEventListener("click", () => {
            const targets = selected.length > 0 ? selected : entries;
            if (operation === "discard") this.discard(targets, group);
            else this.write(operation, targets, group);
          });
          actions.append(action);
        }
        section.append(actions);
      }
      this.container.append(section);
    }
    const toolbar = document.createElement("header");
    toolbar.className = "git-panel-toolbar";
    const details = document.createElement("div");
    details.className = "git-panel-details";
    const summary = document.createElement("p");
    summary.className = "git-panel-summary";
    const branch = snapshot.branch || snapshot.headState || "";
    const upstream = snapshot.upstream || t("git.noUpstream");
    summary.textContent = t("git.summary", {
      branch,
      upstream,
      ahead: snapshot.ahead || 0,
      behind: snapshot.behind || 0,
    });
    details.append(summary);
    const stats = document.createElement("p");
    stats.className = "git-panel-stats";
    stats.textContent = t("git.stats", {
      staged: snapshot.counts?.staged || 0,
      changes: snapshot.counts?.changes || 0,
      untracked: snapshot.counts?.untracked || 0,
      additions: snapshot.changeStats?.additions || 0,
      deletions: snapshot.changeStats?.deletions || 0,
      untrackedExcluded: snapshot.changeStats?.untrackedExcludedCount || 0,
      binary: snapshot.changeStats?.binaryFileCount || 0,
    });
    details.append(stats);
    toolbar.append(details);
    const actions = document.createElement("div");
    actions.className = "git-panel-toolbar-actions";
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "git-panel-refresh";
    refresh.textContent = t("git.refresh");
    refresh.setAttribute("aria-label", t("git.refresh"));
    refresh.addEventListener("click", () => void this.refresh());
    actions.append(refresh);
    const commit = document.createElement("button");
    commit.type = "button";
    commit.className = "git-panel-commit";
    commit.textContent = t("git.aiCommitMessage");
    commit.disabled = snapshot.counts?.staged === 0 || snapshot.counts?.conflicted > 0;
    commit.addEventListener("click", () => this.requestAiCommitMessage());
    actions.append(commit);
    toolbar.append(actions);
    this.container.prepend(toolbar);
    this.container.scrollTop = scrollTop;
  }
  buildTree(entries) {
    const root = { dirs: new Map(), files: [] };
    for (const entry of entries) {
      const path = entry.displayPath || "";
      const parts = path.split(/[/\\]/).filter(Boolean);
      if (parts.length <= 1) {
        root.files.push(entry);
        continue;
      }
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const segment = parts[i];
        let child = node.dirs.get(segment);
        if (!child) {
          child = {
            dirs: new Map(),
            files: [],
            prefix: parts.slice(0, i + 1).join("/"),
          };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.push(entry);
    }
    return root;
  }
  renderTree(node, container, snapshot, group, prefix) {
    for (const [segment, child] of node.dirs) {
      const dirKey = `dir:${group}:${child.prefix}`;
      const dirSection = document.createElement("div");
      dirSection.className = "git-directory";
      const dirHeading = document.createElement("button");
      dirHeading.type = "button";
      dirHeading.className = "git-directory-heading git-tree-row";
      if (this.folded.has(dirKey)) dirHeading.classList.add("collapsed");
      const fileCount = this.countFiles(child);
      const icon = document.createElement("span");
      icon.className = "git-tree-folder-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.append(
        createFileTypeIcon({
          name: segment,
          isDirectory: true,
          expanded: !this.folded.has(dirKey),
        }),
      );
      const label = document.createElement("span");
      label.className = "git-tree-label";
      label.textContent = `${prefix ? `${prefix}/` : ""}${segment}`;
      const count = document.createElement("span");
      count.className = "git-tree-count";
      count.textContent = String(fileCount);
      dirHeading.append(icon, label, count);
      dirHeading.setAttribute("aria-expanded", String(!this.folded.has(dirKey)));
      dirHeading.addEventListener("click", () => {
        this.folded.has(dirKey) ? this.folded.delete(dirKey) : this.folded.add(dirKey);
        this.render();
      });
      dirSection.append(dirHeading);
      if (!this.folded.has(dirKey)) {
        const dirBody = document.createElement("div");
        dirBody.className = "git-directory-body";
        this.renderTree(child, dirBody, snapshot, group, `${prefix ? `${prefix}/` : ""}${segment}`);
        dirSection.append(dirBody);
      }
      container.append(dirSection);
    }
    for (const entry of node.files) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "git-entry git-tree-row";
      const fileName = entry.displayPath.split(/[/\\]/).pop() || entry.displayPath;
      const icon = document.createElement("span");
      icon.className = "git-tree-file-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.append(createFileTypeIcon({ name: fileName }));
      const label = document.createElement("span");
      label.className = "git-tree-label";
      label.textContent = fileName;
      row.append(icon, label);
      row.setAttribute("aria-label", entry.displayPath);
      row.title = entry.displayPath;
      const identity = `${snapshot.snapshotId}:${group}:${entry.pathBytesBase64}`;
      if (this.selected.has(identity)) {
        row.classList.add("git-entry-selected");
        row.setAttribute("aria-pressed", "true");
      }
      row.addEventListener("click", (event) => {
        if (group === "conflicted") return;
        if (event.shiftKey) {
          this.selected.has(identity)
            ? this.selected.delete(identity)
            : this.selected.add(identity);
          this.render();
          return;
        }
        const comparison =
          group === "staged" ? "staged" : group === "untracked" ? "untracked" : "changes";
        const requestId = this.client?.diff?.(
          snapshot.snapshotId,
          group,
          entry.pathBytesBase64,
          comparison,
        );
        if (requestId) this.onDiffRequest?.(requestId, { ...entry, comparison });
        else this.openDiff?.({ ...entry, comparison });
      });
      container.append(row);
    }
  }
  countFiles(node) {
    let count = node.files.length;
    for (const child of node.dirs.values()) count += this.countFiles(child);
    return count;
  }
  _createChevron() {
    return createSectionChevron();
  }
  groupsFor(entry) {
    if (entry.entryKind === "unmerged") return ["conflicted"];
    if (entry.entryKind === "untracked") return ["untracked"];
    const groups = [];
    if (entry.xy?.[0] && entry.xy[0] !== ".") groups.push("staged");
    if (entry.xy?.[1] && entry.xy[1] !== ".") groups.push("changes");
    return groups.length > 0 ? groups : ["changes"];
  }
  groupFor(entry) {
    return this.groupsFor(entry)[0];
  }
}
