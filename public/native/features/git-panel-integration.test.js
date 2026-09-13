// ABOUTME: Regression test for the Git panel integration module.
// ABOUTME: Guards against the silent-failure bug where setWorkspaceGeneration
// ABOUTME: was never called, causing all Git commands to return early.

import { describe, expect, it, vi } from "vitest";

// Minimal stubs — the integration only needs DOM IDs and runtime.git().
function setupDom() {
  document.body.replaceChildren();
  const els = {
    "file-sidebar-close": "button",
    "file-sidebar-path": "div",
    "file-sidebar-up": "button",
    "file-sidebar-refresh": "button",
    "file-sidebar-toggle-hidden": "button",
    "git-panel-refresh": "button",
    "file-sidebar-finder": "button",
    "git-panel": "div",
    "file-list": "div",
  };
  for (const [id, tag] of Object.entries(els)) {
    const el = document.createElement(tag);
    el.id = id;
    document.body.append(el);
  }
  return {
    container: document.getElementById("git-panel"),
    fileList: document.getElementById("file-list"),
    closeBtn: document.getElementById("file-sidebar-close"),
    up: document.getElementById("file-sidebar-up"),
    finder: document.getElementById("file-sidebar-finder"),
    path: document.getElementById("file-sidebar-path"),
  };
}

function createRuntime() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    git(message) {
      sent.push(message);
      return Promise.resolve(null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(frame) {
      for (const listener of listeners) listener(frame);
    },
  };
}

describe("setupGitPanel integration", () => {
  it("initialises the client generation so commands are sent (regression: previously generation stayed null)", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const runtime = createRuntime();

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    expect(result).not.toBeNull();
    // The client must have a non-null generation — without setWorkspaceGeneration(0)
    // every command() silently returns null and the panel renders empty.
    expect(result.client.generation).toBe(0);
  });

  it("sends a git status command when the Git view is activated", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const runtime = createRuntime();

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    // Switching to the Git view triggers panel.refresh() → client.command({type:"status"})
    result.setTab("git");

    // Allow the microtask queue to flush (send is called synchronously inside command)
    await Promise.resolve();

    // After the unwrap fix, the integration passes the inner command payload
    // ({type:"status"}) to runtime.git(), not the wrapped GitClient message.
    const statusCommand = runtime.sent.find((m) => m.type === "status");
    expect(statusCommand).toBeDefined();
    expect(statusCommand.requestId).toMatch(/^git-\d+$/);
  });

  it("toggles sidebar header controls with the Files/Git tab", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const runtime = createRuntime();

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    const refresh = document.getElementById("file-sidebar-refresh");
    const toggleHidden = document.getElementById("file-sidebar-toggle-hidden");
    const gitRefresh = document.getElementById("git-panel-refresh");
    // Files tab: file controls visible, git refresh hidden.
    expect(refresh.classList.contains("hidden")).toBe(false);
    expect(toggleHidden.classList.contains("hidden")).toBe(false);
    expect(gitRefresh.classList.contains("hidden")).toBe(true);

    result.setTab("git");
    expect(refresh.classList.contains("hidden")).toBe(true);
    expect(toggleHidden.classList.contains("hidden")).toBe(true);
    expect(gitRefresh.classList.contains("hidden")).toBe(false);

    result.setTab("files");
    expect(refresh.classList.contains("hidden")).toBe(false);
    expect(gitRefresh.classList.contains("hidden")).toBe(true);
  });

  it("marks the panel not-a-repo when the status probe fails with git's not-a-repository error", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const runtime = createRuntime();
    runtime.git = vi.fn(async () => ({
      type: "git_command_failed",
      error: "fatal: not a git repository (or any of the parent directories): .git",
    }));

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    result.setTab("git");
    await vi.waitFor(() => expect(result.panel.notGitRepo).toBe(true));
    // The commit-failure path must NOT run for a status-probe failure.
    expect(result.panel.aiError).toBeNull();
  });

  it("hides the header git pill once a status probe proves the workspace is not a repository", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    // The header pill lives outside the panel fixture (app header chrome).
    const pill = document.createElement("button");
    pill.id = "diff-sidebar-toggle";
    document.body.append(pill);
    const runtime = createRuntime();
    runtime.git = vi.fn(async () => ({
      type: "git_command_failed",
      error: "fatal: not a git repository (or any of the parent directories): .git",
    }));

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    result.setTab("git");
    await vi.waitFor(() => {
      expect(result.panel.notGitRepo).toBe(true);
      expect(pill.classList.contains("hidden")).toBe(true);
    });
  });

  it("routes non-repository status failures to commit failure handling, not not-a-repo", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const runtime = createRuntime();
    runtime.git = vi.fn(async () => ({
      type: "git_command_failed",
      error: "git binary not found",
    }));

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    result.setTab("git");
    await vi.waitFor(() => expect(result.panel.aiError).toBe("git binary not found"));
    expect(result.panel.notGitRepo).toBe(false);
  });

  it("hides file-browser chrome for the Git view without a Files/Git title", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList, closeBtn, up, finder, path } = setupDom();
    const result = setupGitPanel({
      runtime: createRuntime(),
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
    });

    result.setTab("git");
    expect(result.getTab()).toBe("git");
    expect(closeBtn.getAttribute("aria-label")).toBe("git.closeChanges");
    expect(document.getElementById("file-sidebar-title")).toBeNull();
    expect(container.classList.contains("hidden")).toBe(false);
    expect(fileList.classList.contains("hidden")).toBe(true);
    expect(path.classList.contains("hidden")).toBe(true);
    expect(up.classList.contains("hidden")).toBe(true);
    expect(finder.classList.contains("hidden")).toBe(true);

    result.setTab("files");
    expect(result.getTab()).toBe("files");
    expect(closeBtn.getAttribute("aria-label")).toBe("files.close");
    expect(container.classList.contains("hidden")).toBe(true);
    expect(fileList.classList.contains("hidden")).toBe(false);
    expect(up.classList.contains("hidden")).toBe(false);
  });

  it("ignores stale AI and commit responses", async () => {
    const { setupGitPanel } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const runtime = createRuntime();
    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError: vi.fn(),
    });

    result.panel.setSnapshot({
      snapshotId: "snap",
      entries: [],
      counts: { staged: 1, conflicted: 0 },
    });
    result.panel.requestAiCommitMessage();
    result.panel.requestAiCommitMessage();
    const aiRequestId = result.panel.pendingAiRequestId;
    runtime.emit({
      type: "git_ai_commit_message",
      requestId: "git-1",
      snapshot: { snapshotId: "stale" },
      message: "stale",
    });
    expect(result.panel.commitDialog).toBeNull();

    runtime.emit({
      type: "git_ai_commit_message",
      requestId: aiRequestId,
      snapshot: { snapshotId: "current" },
      message: "current",
    });
    expect(result.panel.commitMessage).toBe("current");
    result.panel.closeCommitDialog();

    result.panel.aiSnapshot = { snapshotId: "commit-snap" };
    result.panel.commitMessage = "commit";
    const oldCommitRequestId = result.panel.commit();
    const commitRequestId = result.panel.commit();
    expect(oldCommitRequestId).not.toBe(commitRequestId);
    runtime.emit({
      type: "git_commit_confirmation_required",
      requestId: oldCommitRequestId,
      confirmationToken: "stale-token",
    });
    expect(result.panel.pendingConfirmationToken).toBeNull();
    runtime.emit({
      type: "git_commit_result",
      requestId: oldCommitRequestId,
      status: "succeeded",
    });
    expect(result.panel.pendingCommitRequestId).toBe(commitRequestId);
    expect(result.panel.aiSnapshot).toEqual({ snapshotId: "commit-snap" });
  });

  it("does not surface a missing git binary as a host error", async () => {
    const { setupGitPanel, isGitUnavailableError } = await import("./git-panel-integration.js");
    const { container, fileList } = setupDom();
    const onError = vi.fn();
    const runtime = {
      sent: [],
      git() {
        return Promise.reject(new Error("program not found"));
      },
      subscribe() {
        return () => {};
      },
    };

    const result = setupGitPanel({
      runtime,
      getTarget: () => ({ workspaceId: "ws-1" }),
      container,
      fileList,
      filePreviewPanel: { openDiff: vi.fn() },
      onError,
    });

    result.setTab("git");
    await vi.waitFor(() => expect(container.querySelector("p")).not.toBeNull());
    expect(onError).not.toHaveBeenCalled();
    expect(isGitUnavailableError(new Error("program not found"))).toBe(true);
    expect(isGitUnavailableError(new Error("hook says no"))).toBe(false);
  });
});
