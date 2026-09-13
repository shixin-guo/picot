// ABOUTME: Connects the Git panel to the native Host runtime transport.
// ABOUTME: Keeps Git commands workspace-bound without restoring the legacy broker client.

import { createDiffTabId } from "../../file-preview-panel-diff.js";
import { GitClient } from "../../git-client.js";
import { GitPanel } from "../../git-panel.js";
import { t } from "../../i18n.js";

export function isGitUnavailableError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const trimmed = message.trim();
  return trimmed === "git_not_found" || trimmed.toLowerCase() === "program not found";
}

export function setupGitPanel({
  runtime,
  getTarget,
  container,
  fileList,
  filePreviewPanel,
  onError,
} = {}) {
  const closeBtn = document.getElementById("file-sidebar-close");
  const path = document.getElementById("file-sidebar-path");
  const up = document.getElementById("file-sidebar-up");
  const filesRefresh = document.getElementById("file-sidebar-refresh");
  const filesToggleHidden = document.getElementById("file-sidebar-toggle-hidden");
  const gitRefresh = document.getElementById("git-panel-refresh");
  const finder = document.getElementById("file-sidebar-finder");
  if (!runtime || !container) return null;

  const client = new GitClient({
    send: (message) => {
      // runtime.git() wraps the payload into { type: "git_command", command }
      // for the backend. Passing the full GitClient message would double-wrap
      // it, so the backend would see /command/type = "git_command" instead of
      // "status" and reject it as "unsupported Git command".
      const payload =
        message.type === "git_ai_commit_message"
          ? { type: "git_ai_commit_message", requestId: message.requestId }
          : { ...message.command, requestId: message.requestId };
      runtime
        .git(payload, getTarget())
        .then((response) => {
          if (response) handleFrame({ ...response, requestId: message.requestId });
        })
        .catch((error) => {
          if (isGitUnavailableError(error)) {
            panel?.setSnapshot(null);
            return;
          }
          onError?.(error);
        });
    },
  });

  // The native Host backend always uses generation 0 (workspace roots are
  // stable per process — there is no workspace-swap lifecycle). Without this
  // call, generation stays null and every command() returns early, so the
  // panel never sends a status request and renders empty.
  client.setWorkspaceGeneration(0);

  const handleFrame = (frame) => {
    if (!frame?.type) return;
    const normalized = { ...frame };
    client.resolveResponse(normalized);
    if (normalized.type === "git_status") panel.setSnapshot(normalized.snapshot);
    else if (normalized.type === "git_diff") filePreviewPanel?.openDiff?.(normalized.diff);
    else if (normalized.type === "git_log") panel.historyPanel?.applyLog(normalized);
    else if (normalized.type === "git_log_detail") panel.historyPanel?.applyLogDetail(normalized);
    else if (normalized.type === "git_commit_diff") {
      const diff = normalized.diff;
      if (diff && normalized.requestId === latestCommitDiffRequest) {
        filePreviewPanel?.openDiff?.({ ...latestCommitDiffDescriptor, ...diff });
      }
    } else if (normalized.type === "git_ai_commit_message") {
      if (normalized.requestId !== panel.pendingAiRequestId) return;
      panel.applyAiResult(normalized.snapshot, normalized.message);
    } else if (normalized.type === "git_ai_commit_message_failed") {
      if (normalized.requestId !== panel.pendingAiRequestId) return;
      panel.applyAiFailure(normalized.error);
    } else if (normalized.type === "git_commit_confirmation_required") {
      if (normalized.requestId !== panel.pendingCommitRequestId) return;
      panel.applyConfirmationToken(normalized.confirmationToken);
    } else if (normalized.type === "git_commit_started") {
      if (normalized.requestId !== panel.pendingCommitRequestId) return;
      panel.setCommitInProgress(true);
    } else if (normalized.type === "git_commit_result") {
      if (normalized.requestId !== panel.pendingCommitRequestId) return;
      panel.applyCommitResult(normalized);
      if (normalized.status === "succeeded") panel.refresh();
    } else if (normalized.type === "git_command_ack") panel.refresh();
    else if (normalized.type === "git_command_failed") {
      client.consumeWriteFailure(normalized);
      panel.historyPanel?.handleFailure(normalized.requestId);
      if (isGitUnavailableError(normalized.error)) {
        panel.setSnapshot(null);
      } else if (
        // A status probe against a non-repository workspace fails with git's
        // "not a git repository" error and never produces a git_status frame,
        // so the panel would otherwise sit on the generic "no status loaded"
        // message. Surface the real reason instead — but only for the current
        // status probe, never for stale or concurrent non-status failures.
        panel.isStatusFailure(normalized.requestId) &&
        typeof normalized.error === "string" &&
        normalized.error.includes("not a git repository")
      ) {
        panel.setNotGitRepo(true);
        // Runtime parity for the startup probe in project-header: once git
        // itself proves the workspace is not a repository, hide the header
        // pill immediately instead of leaving an entry that cannot work.
        document.getElementById("diff-sidebar-toggle")?.classList.add("hidden");
      } else if (
        panel.isStatusFailure(normalized.requestId) ||
        normalized.requestId === panel.pendingCommitRequestId
      ) {
        panel.applyCommitFailure(normalized.error);
      }
    }
  };

  let latestCommitDiffRequest = null;
  let latestCommitDiffDescriptor = null;
  const panel = new GitPanel({
    container,
    fileList,
    client,
    openDiff: (entry) => filePreviewPanel?.openDiff?.(entry),
    onDiffRequest: (_requestId, descriptor) => {
      if (!descriptor?.pathBytesBase64) return;
      filePreviewPanel?.openDiff?.({
        ...descriptor,
        id: createDiffTabId(descriptor.comparison, descriptor.pathBytesBase64),
      });
    },
    onHistoryDiffRequest: (requestId, descriptor) => {
      latestCommitDiffRequest = requestId;
      latestCommitDiffDescriptor = descriptor || null;
    },
  });

  let currentTab = "files";

  const applyChrome = () => {
    const showGit = currentTab === "git";
    if (closeBtn) {
      closeBtn.dataset.i18nAriaLabel = showGit ? "git.closeChanges" : "files.close";
      closeBtn.setAttribute("aria-label", t(closeBtn.dataset.i18nAriaLabel));
    }
  };

  const setTab = (tab) => {
    currentTab = tab === "git" ? "git" : "files";
    const showGit = currentTab === "git";
    container.classList.toggle("hidden", !showGit);
    fileList?.classList.toggle("hidden", showGit);
    path?.classList.toggle("hidden", showGit);
    up?.classList.toggle("hidden", showGit);
    filesRefresh?.classList.toggle("hidden", showGit);
    filesToggleHidden?.classList.toggle("hidden", showGit);
    gitRefresh?.classList.toggle("hidden", !showGit);
    finder?.classList.toggle("hidden", showGit);
    applyChrome();
    if (showGit) panel.refresh();
  };

  // The Git status refresh lives in the sidebar header (shared with the Files
  // controls) instead of inside the panel toolbar.
  gitRefresh?.addEventListener("click", () => void panel.refresh());
  setTab("files");

  const unsubscribe = runtime.subscribe((frame) => {
    if (frame?.type?.startsWith("git_")) handleFrame(frame);
  });

  return {
    panel,
    client,
    setTab,
    getTab() {
      return currentTab;
    },
    destroy() {
      unsubscribe?.();
      panel.historyPanel?.clearSession();
      panel.destroy();
    },
  };
}
