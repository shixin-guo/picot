// ABOUTME: Connects the Git panel to the native Host runtime transport.
// ABOUTME: Keeps Git commands workspace-bound without restoring the legacy broker client.

import { createDiffTabId } from "../../file-preview-panel-diff.js";
import { GitClient } from "../../git-client.js";
import { GitPanel } from "../../git-panel.js";

export function setupGitPanel({
  runtime,
  getTarget,
  container,
  fileList,
  filePreviewPanel,
  onError,
} = {}) {
  const filesTab = document.getElementById("file-sidebar-files-tab");
  const gitTab = document.getElementById("file-sidebar-git-tab");
  const path = document.getElementById("file-sidebar-path");
  const up = document.getElementById("file-sidebar-up");
  const finder = document.getElementById("file-sidebar-finder");
  if (!runtime || !container || !filesTab || !gitTab) return null;

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
        .catch((error) => onError?.(error));
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
    else if (normalized.type === "git_ai_commit_message")
      panel.applyAiResult(normalized.snapshot, normalized.message);
    else if (normalized.type === "git_ai_commit_message_failed")
      panel.applyAiFailure(normalized.error);
    else if (normalized.type === "git_commit_confirmation_required")
      panel.applyConfirmationToken(normalized.confirmationToken);
    else if (normalized.type === "git_commit_started") panel.setCommitInProgress(true);
    else if (normalized.type === "git_commit_result") {
      panel.applyCommitResult(normalized);
      if (normalized.status === "succeeded") panel.refresh();
    } else if (normalized.type === "git_command_ack") panel.refresh();
    else if (normalized.type === "git_command_failed") {
      client.consumeWriteFailure(normalized);
      panel.applyCommitFailure(normalized.error);
    }
  };

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
  });

  const setTab = (tab) => {
    const showGit = tab === "git";
    filesTab.classList.toggle("active", !showGit);
    filesTab.setAttribute("aria-selected", String(!showGit));
    gitTab.classList.toggle("active", showGit);
    gitTab.setAttribute("aria-selected", String(showGit));
    container.classList.toggle("hidden", !showGit);
    fileList?.classList.toggle("hidden", showGit);
    path?.classList.toggle("hidden", showGit);
    up?.classList.toggle("hidden", showGit);
    finder?.classList.toggle("hidden", showGit);
    if (showGit) panel.refresh();
  };

  filesTab.addEventListener("click", () => setTab("files"));
  gitTab.addEventListener("click", () => setTab("git"));
  setTab("files");

  const unsubscribe = runtime.subscribe((frame) => {
    if (frame?.type?.startsWith("git_")) handleFrame(frame);
  });

  return {
    panel,
    client,
    setTab,
    destroy() {
      unsubscribe?.();
      panel.destroy();
    },
  };
}
