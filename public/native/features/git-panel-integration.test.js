// ABOUTME: Regression test for the Git panel integration module.
// ABOUTME: Guards against the silent-failure bug where setWorkspaceGeneration
// ABOUTME: was never called, causing all Git commands to return early.

import { describe, expect, it, vi } from "vitest";

// Minimal stubs — the integration only needs DOM IDs and runtime.git().
function setupDom() {
  document.body.replaceChildren();
  const els = {
    "file-sidebar-files-tab": "button",
    "file-sidebar-git-tab": "button",
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
  };
}

function createRuntime() {
  const sent = [];
  return {
    sent,
    git(message) {
      sent.push(message);
      return Promise.resolve(null);
    },
    subscribe() {
      return () => {};
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

  it("sends a git status command when the Git tab is activated", async () => {
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

    // Switching to the Git tab triggers panel.refresh() → client.command({type:"status"})
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
});
