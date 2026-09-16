// ABOUTME: Verifies Git History gating, pagination, stale-response rejection, and diff descriptors.
// ABOUTME: Covers clipboard fallback and empty/detail rendering without framework dependencies.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHistoryPanel } from "./git-history-panel.js";
import { initI18n } from "./i18n.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

beforeEach(async () => {
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/en.json")) {
      return new Response(JSON.stringify(enMessages));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  await initI18n();
});

function makePanel(onDiffRequest = vi.fn()) {
  const container = document.createElement("div");
  let logCount = 0;
  const client = {
    log: vi.fn(() => `log-${++logCount}`),
    logDetail: vi.fn(() => "detail-1"),
    commitDiff: vi.fn(() => "diff-1"),
  };
  const panel = new GitHistoryPanel({ container, client, onDiffRequest });
  document.body.append(container);
  return { container, client, panel, onDiffRequest };
}

describe("GitHistoryPanel", () => {
  it("gates refresh until active and requests only when available", () => {
    const { client, panel } = makePanel();
    panel.refresh();
    expect(client.log).not.toHaveBeenCalled();
    panel.setActive(true);
    panel.setUnavailable(true);
    panel.refresh();
    expect(client.log).not.toHaveBeenCalled();
  });
  it("renders empty state, paginates, and drops stale responses", () => {
    const { client, panel, container } = makePanel();
    panel.setActive(true);
    panel.refresh();
    expect(container.querySelectorAll(".git-history-section")).toHaveLength(2);
    expect(container.querySelector(".git-history-divider")).not.toBeNull();
    expect(container.querySelector(".git-history-divider").getAttribute("role")).toBe("separator");
    expect(container.dataset.detailExpanded).toBe("false");
    expect(client.log).toHaveBeenCalledWith(50, null);
    panel.applyLog({ requestId: "stale", commits: [{ oid: "bad" }] });
    expect(container.querySelectorAll(".git-history-row")).toHaveLength(0);
    panel.applyLog({
      requestId: "log-1",
      commits: [{ oid: "first", subject: "First", authorName: "Lin", authorTime: 1 }],
      hasMore: true,
    });
    expect(container.querySelectorAll(".git-history-row")).toHaveLength(1);
    container.querySelector(".project-sessions-toggle").click();
    expect(client.log).toHaveBeenLastCalledWith(50, "first");
    panel.applyLog({
      requestId: "log-2",
      commits: [{ oid: "second", subject: "Second", authorName: "Lin", authorTime: 1 }],
      hasMore: false,
    });
    expect(container.querySelectorAll(".git-history-row")).toHaveLength(2);
    expect(container.querySelector(".project-sessions-toggle")).toBeNull();
  });
  it("keeps log and detail channels independent and opens commit diff", () => {
    const onDiffRequest = vi.fn();
    const { client, panel, container } = makePanel(onDiffRequest);
    panel.setActive(true);
    panel.refresh();
    panel.selectCommit("abc");
    expect(container.dataset.detailExpanded).toBe("true");
    expect(panel.listSection.style.getPropertyValue("--history-flex")).toBe("0.5");
    expect(panel.detailSection.style.getPropertyValue("--history-flex")).toBe("0.5");
    panel.applyLogDetail({ requestId: "wrong", commit: { oid: "wrong" } });
    expect(panel._oid).toBeNull();
    panel.applyLogDetail({
      requestId: "detail-1",
      commit: {
        oid: "abc",
        fullMessage: "message",
        files: [{ status: "M", path: "a.txt", pathBytesBase64: "YS50eHQ=" }],
      },
    });
    expect(container.textContent).toContain("message");
    expect(container.querySelector(".git-history-oid-short").getAttribute("role")).toBe("button");
    container.querySelector(".git-history-file").click();
    expect(client.commitDiff).toHaveBeenCalledWith("abc", "YS50eHQ=");
    expect(onDiffRequest).toHaveBeenCalledWith(
      "diff-1",
      expect.objectContaining({
        type: "commit_diff",
        comparison: "commit",
        commitOid: "abc",
        displayPath: "a.txt",
      }),
    );
  });
  it("marks backend-truncated messages visibly", () => {
    const { panel, container } = makePanel();
    panel._renderDetail({
      oid: "a".repeat(40),
      fullMessage: "partial…",
      messageTruncated: true,
      files: [],
    });
    expect(container.querySelector(".git-history-message-truncated")?.textContent).toBe(
      enMessages.git.messageTruncated,
    );
  });
  it("marks truncated file lists visibly", () => {
    const { panel, container } = makePanel();
    panel._renderDetail({
      oid: "a".repeat(40),
      fullMessage: "message",
      filesTruncated: true,
      files: [],
    });
    expect(container.querySelector(".git-history-files-truncated")?.textContent).toBe(
      enMessages.git.filesTruncated,
    );
  });
  it("formats older commits with week, month, and year tiers", () => {
    const { panel } = makePanel();
    const relativeTime = vi
      .spyOn(Intl, "RelativeTimeFormat")
      .mockImplementation(() => ({ format: (value, unit) => `${value} ${unit}` }));
    const now = Date.now();
    expect(panel._relativeTime((now - 8 * 24 * 60 * 60 * 1000) / 1000)).toBe("-1 week");
    expect(panel._relativeTime((now - 60 * 24 * 60 * 60 * 1000) / 1000)).toBe("-2 month");
    expect(panel._relativeTime((now - 400 * 24 * 60 * 60 * 1000) / 1000)).toBe("-1 year");
    relativeTime.mockRestore();
  });
  it("keeps fallback labels present in all supported locales", () => {
    for (const lang of ["en", "zh", "ja", "es"]) {
      const messages = JSON.parse(
        readFileSync(join(process.cwd(), `public/locales/${lang}.json`), "utf8"),
      );
      expect(messages.git.messageTruncated).toEqual(expect.any(String));
      expect(messages.git.filesTruncated).toEqual(expect.any(String));
      expect(messages.git.fallback.binary).toEqual(expect.any(String));
    }
  });
  it("copies full hash when clicking hash value", async () => {
    const { panel, container } = makePanel();
    panel._oid = "a".repeat(40);
    panel._renderDetail({ oid: panel._oid, fullMessage: "message", files: [] });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    container.querySelector(".git-history-oid-short").click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("a".repeat(40));
  });
  it("copies full hash through legacy fallback", async () => {
    const { panel } = makePanel();
    panel._oid = "a".repeat(40);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await panel.copyHash();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});
