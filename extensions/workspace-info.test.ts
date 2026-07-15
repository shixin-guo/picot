// @vitest-environment node
// ABOUTME: Verifies restricted workspace lookup and bounded Git metadata inspection.
// ABOUTME: Protects remote parsing, repository classification, and detached-head handling.
import { describe, expect, it } from "vitest";
import {
  inspectWorkspaceGit,
  observeWorkspaceInfoAbort,
  parseRepositoryName,
  resolveWorkspaceInfoPath,
} from "./workspace-info.ts";

describe("workspace info", () => {
  it("resolves only known IDs", () => {
    expect(resolveWorkspaceInfoPath("history:a", [{ dirName: "a", path: "/work/a" }], [])).toBe(
      "/work/a",
    );
    expect(resolveWorkspaceInfoPath("path:/work/live", [], [{ cwd: "/work/live" }])).toBe(
      "/work/live",
    );
    expect(resolveWorkspaceInfoPath("/etc", [], [])).toBeNull();
  });
  it("parses supported remotes", () => {
    expect(parseRepositoryName("https://github.com/owner/repo.git", "/work/repo")).toBe(
      "owner/repo",
    );
    expect(parseRepositoryName("ssh://git@github.com/owner/repo.git", "/work/repo")).toBe(
      "owner/repo",
    );
    expect(parseRepositoryName("git@github.com:owner/repo.git", "/work/repo")).toBe("owner/repo");
  });
  it("returns bounded structured Git data from injected runner", async () => {
    const runGit = async (args: string[]) => {
      const command = args.join(" ");
      const stdout = command.includes("show-toplevel")
        ? "/work/repo\n"
        : command.includes("git-dir")
          ? ".git\n"
          : command.includes("git-common-dir")
            ? ".git\n"
            : command.includes("symbolic-ref")
              ? "main\n"
              : command.includes("remote get-url")
                ? "https://github.com/owner/repo.git\n"
                : command === "remote"
                  ? "origin\n"
                  : "abc123\n";
      return { stdout };
    };
    const info = await inspectWorkspaceGit("/work/repo", { runGit });
    expect(info).toMatchObject({
      isGit: true,
      repository: "owner/repo",
      kind: "repository",
      branch: "main",
    });
  });
  it("observes Fetch request cancellation without Node event methods", () => {
    const request = new AbortController();
    const operation = new AbortController();
    const cleanup = observeWorkspaceInfoAbort(operation, { signal: request.signal }, {});

    request.abort();

    expect(operation.signal.aborted).toBe(true);
    cleanup();
  });

  it("aborts immediately when a Fetch request is already cancelled", () => {
    const request = new AbortController();
    request.abort();
    const operation = new AbortController();

    const cleanup = observeWorkspaceInfoAbort(operation, { signal: request.signal }, {});

    expect(operation.signal.aborted).toBe(true);
    cleanup();
  });
});
