// ABOUTME: Verifies Git panel rendering, grouping, and safe text handling.
// ABOUTME: Covers the panel's explicit four-group projection without filesystem side effects.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitPanel } from "./git-panel.js";
import { initI18n } from "./i18n.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

beforeEach(async () => {
  document.body.replaceChildren();
  const panel = document.createElement("div");
  panel.id = "panel";
  document.body.append(panel);
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/en.json")) {
      return new Response(JSON.stringify(enMessages));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  await initI18n();
});

describe("GitPanel", () => {
  it("renders four groups and repository paths as text", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        { entryKind: "ordinary", xy: "M.", displayPath: "<unsafe>.js" },
        { entryKind: "ordinary", xy: ".M", displayPath: "changed.js" },
        { entryKind: "untracked", displayPath: "new.js" },
        { entryKind: "unmerged", displayPath: "conflict.js" },
      ],
    });
    expect(panel.container.textContent).toContain("<unsafe>.js");
    expect(panel.container.querySelectorAll("section")).toHaveLength(4);
    expect(panel.container.querySelector("script")).toBeNull();
  });

  it("renders a compact status toolbar with primary commit and secondary refresh actions", () => {
    const command = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command },
    });
    panel.setSnapshot({
      branch: "feature/panel",
      upstream: "origin/feature/panel",
      ahead: 2,
      behind: 1,
      counts: { staged: 1, changes: 2, untracked: 3 },
      changeStats: { additions: 5, deletions: 4 },
      entries: [],
    });

    const toolbar = panel.container.querySelector(".git-panel-toolbar");
    expect(toolbar?.querySelector(".git-panel-summary")?.textContent).toContain("feature/panel");
    expect(toolbar?.querySelector(".git-panel-refresh")).not.toBeNull();
    expect(panel.container.querySelector(".git-panel-commit")).not.toBeNull();
    expect(panel.container.querySelector(".git-panel-stats")).not.toBeNull();
  });

  it("renders group headers as session-list style section headers with a disclosure chevron", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        { entryKind: "ordinary", xy: ".M", displayPath: "src/app.js", pathBytesBase64: "YQ==" },
      ],
    });

    const header = panel.container.querySelector(".git-group-heading");
    expect(header.classList.contains("sidebar-section-header")).toBe(true);
    expect(header.getAttribute("role")).toBe("button");
    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.querySelector(".section-chevron")).not.toBeNull();
    expect(header.querySelector("svg")).not.toBeNull();
    expect(header.querySelector(".sidebar-section-title")?.textContent).toBe("Staged");
    expect(header.querySelector(".sidebar-section-count")?.textContent).toBe("0");
  });

  it("renders directories and files as distinct tree rows", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        { entryKind: "ordinary", xy: ".M", displayPath: "src/app.js", pathBytesBase64: "YQ==" },
      ],
    });

    expect(
      panel.container.querySelector(".git-directory-heading")?.classList.contains("git-tree-row"),
    ).toBe(true);
    expect(panel.container.querySelector(".git-entry")?.classList.contains("git-tree-row")).toBe(
      true,
    );
    // Directory rows render a Material folder icon (open when expanded) from
    // the shared file-type vocabulary, matching File Browser's icon set.
    expect(
      panel.container.querySelector(".git-directory-heading .git-tree-folder-icon svg"),
    ).not.toBeNull();
    expect(panel.container.querySelector(".git-directory-heading.collapsed")).toBeNull();
  });

  it("shows a mixed index/worktree entry in both actionable groups", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      entries: [
        {
          entryKind: "ordinary",
          xy: "MM",
          displayPath: "mixed.js",
          pathBytesBase64: "bWl4ZWQuanM=",
        },
      ],
    });
    expect(panel.container.querySelectorAll(".git-entry")).toHaveLength(2);
  });

  it("requests only the allowed write operation for each group", () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const staged = {
      entryKind: "ordinary",
      xy: "M.",
      displayPath: "staged.js",
      pathBytesBase64: "c3RhZ2VkLmpz",
    };
    const changed = {
      entryKind: "ordinary",
      xy: ".M",
      displayPath: "changed.js",
      pathBytesBase64: "Y2hhbmdlZC5qcw==",
    };
    panel.setSnapshot({ snapshotId: "snapshot", entries: [staged, changed] });
    expect(panel.write("stage", [staged])).toBeNull();
    panel.write("unstage", [staged]);
    panel.write("discard", [changed]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("re-enables the submit button after a confirmation-required token arrives", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitMessage = "feat: x";
    panel.openCommitDialog();
    // Simulate the first commit attempt putting the dialog in-progress.
    panel.setCommitInProgress(true);
    expect(document.body.querySelector(".git-commit-submit").disabled).toBe(true);
    // The confirmation-required response must end in-progress and re-enable submit.
    panel.applyConfirmationToken("token-123");
    expect(panel.commitInProgress).toBe(false);
    expect(document.body.querySelector(".git-commit-submit").disabled).toBe(false);
    expect(panel.pendingConfirmationToken).toBe("token-123");
    panel.closeCommitDialog();
  });

  it("keeps the dialog open with the error when commit result is failed", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitMessage = "my message";
    panel.openCommitDialog();
    panel.setCommitInProgress(true);
    // Simulate a hook-rejection failure.
    panel.applyCommitResult({ status: "failed", error: "hook says no" });
    expect(panel.commitInProgress).toBe(false);
    // The user's message must be preserved for retry.
    expect(panel.commitMessage).toBe("my message");
    // The dialog must still be open with the error shown.
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    expect(document.body.querySelector(".git-commit-error").textContent).toContain("hook says no");
    panel.closeCommitDialog();
  });

  it("stages a partial-stage file from the changes group with group=changes", () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const partial = {
      entryKind: "ordinary",
      xy: "MM",
      displayPath: "partial.js",
      pathBytesBase64: "cGFydGlhbC5qcw==",
    };
    panel.setSnapshot({ snapshotId: "snapshot", entries: [partial] });
    // Staging from the Changes group must send only group="changes", not also
    // "staged" (which would make the allowedGroups check reject it).
    panel.write("stage", [partial], "changes");
    expect(write).toHaveBeenCalledTimes(1);
    const sent = write.mock.calls[0][2];
    expect(sent).toHaveLength(1);
    expect(sent[0].group).toBe("changes");
  });

  it("passes the clicked entry alongside a correlated diff request", () => {
    const openDiff = vi.fn();
    const onDiffRequest = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      openDiff,
      onDiffRequest,
      client: { diff: vi.fn(() => "git-diff-1") },
    });
    const entry = {
      entryKind: "untracked",
      displayPath: "new.js",
      pathBytesBase64: "bmV3Lmpz",
    };
    panel.setSnapshot({ snapshotId: "snapshot", entries: [entry] });
    [...panel.container.querySelectorAll(".git-entry")][0].click();
    expect(onDiffRequest).toHaveBeenCalledWith("git-diff-1", {
      ...entry,
      comparison: "untracked",
    });
    expect(openDiff).not.toHaveBeenCalled();
  });

  it("prefills the commit dialog when AI succeeds", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.applyAiResult({ snapshotId: "ai-snap" }, "feat: add thing");
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    expect(document.body.querySelector(".git-commit-textarea").value).toBe("feat: add thing");
    panel.closeCommitDialog();
  });

  it("opens the commit dialog with an error and empty message when AI fails", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.applyAiFailure("timeout");
    expect(document.body.querySelector(".git-commit-error").textContent).toBe("timeout");
    expect(document.body.querySelector(".git-commit-textarea").value).toBe("");
    panel.closeCommitDialog();
  });

  it("falls back to the status snapshot when AI fails before any AI snapshot exists", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), commit: vi.fn() },
    });
    panel.setSnapshot({ snapshotId: "status-snap", entries: [] });
    expect(panel.aiSnapshot).toBeNull();
    panel.applyAiFailure("timeout");
    expect(document.body.querySelector(".git-commit-dialog")).not.toBeNull();
    expect(panel.aiSnapshot.snapshotId).toBe("status-snap");
    panel.closeCommitDialog();
  });

  it("renders nested directory tree and truncation notice", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.setSnapshot({
      snapshotId: "snap",
      totalEntryCount: 1500,
      returnedEntryCount: 1200,
      entries: [
        {
          entryKind: "ordinary",
          xy: ".M",
          displayPath: "src/a.js",
          pathBytesBase64: "c3JjL2EuanM=",
        },
        {
          entryKind: "ordinary",
          xy: ".M",
          displayPath: "src/b.js",
          pathBytesBase64: "c3JjL2IuanM=",
        },
      ],
    });
    expect(panel.container.querySelectorAll(".git-directory-heading")).toHaveLength(1);
    expect(panel.container.querySelectorAll(".git-entry")).toHaveLength(2);
    const notice = panel.container.querySelector(".git-truncation-notice");
    expect(notice).not.toBeNull();
    // With locales seeded, the notice must show the hidden count.
    expect(notice.textContent).toContain("300");
  });

  it("accumulates shift-selection and batch-stages only selected", () => {
    const write = vi.fn();
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), write },
    });
    const e1 = {
      entryKind: "ordinary",
      xy: ".M",
      displayPath: "a.js",
      pathBytesBase64: "YWE=",
    };
    const e2 = {
      entryKind: "ordinary",
      xy: ".M",
      displayPath: "b.js",
      pathBytesBase64: "YmI=",
    };
    panel.setSnapshot({ snapshotId: "snap", entries: [e1, e2] });
    const rows = panel.container.querySelectorAll(".git-entry");
    const shiftClick = new MouseEvent("click", { bubbles: true, shiftKey: true });
    rows[0].dispatchEvent(shiftClick);
    rows[1].dispatchEvent(shiftClick);
    const stageBtn = [...panel.container.querySelectorAll(".git-group-actions button")].find((b) =>
      b.textContent.toLowerCase().includes("stage"),
    );
    stageBtn.click();
    expect(write).toHaveBeenCalledTimes(1);
    const batch = write.mock.calls[0][2];
    expect(batch).toHaveLength(2);
  });

  it("tracks pendingAiRequestId so requestAiCommitMessage records it", () => {
    const aiCommitMessage = vi.fn(() => "ai-req-1");
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn(), aiCommitMessage },
    });
    panel.setSnapshot({ snapshotId: "snap", entries: [], counts: { staged: 1, conflicted: 0 } });
    const returned = panel.requestAiCommitMessage();
    expect(returned).toBe("ai-req-1");
    expect(panel.pendingAiRequestId).toBe("ai-req-1");
  });

  it("clears pendingAiRequestId on applyAiResult so a stale later response cannot match", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.pendingAiRequestId = "ai-req-1";
    panel.applyAiResult({ snapshotId: "ai-snap" }, "msg");
    expect(panel.pendingAiRequestId).toBeNull();
    panel.closeCommitDialog();
  });

  it("clears pendingAiRequestId on applyAiFailure so a stale later failure cannot match", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.pendingAiRequestId = "ai-req-1";
    panel.applyAiFailure("err");
    expect(panel.pendingAiRequestId).toBeNull();
    panel.closeCommitDialog();
  });

  it("clears pendingCommitRequestId when applyCommitResult succeeds", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitInProgress = true;
    panel.pendingCommitRequestId = "commit-B";
    panel.applyCommitResult({ status: "succeeded", requestId: "commit-B" });
    expect(panel.commitInProgress).toBe(false);
    expect(panel.aiSnapshot).toBeNull();
    expect(panel.pendingCommitRequestId).toBeNull();
  });

  it("clears pendingCommitRequestId when applyCommitResult fails", () => {
    const panel = new GitPanel({
      container: document.querySelector("#panel"),
      client: { command: vi.fn() },
    });
    panel.aiSnapshot = { snapshotId: "ai-snap" };
    panel.commitMessage = "my msg";
    panel.pendingCommitRequestId = "commit-B";
    panel.applyCommitResult({ status: "failed", requestId: "commit-B", error: "hook" });
    expect(panel.pendingCommitRequestId).toBeNull();
    expect(panel.aiError).toContain("hook");
    panel.closeCommitDialog();
  });
});
