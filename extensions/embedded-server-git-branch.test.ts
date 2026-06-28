// @vitest-environment node

import { describe, expect, it } from "vitest";
import { normalizeApiRoutePath, resolveGitBranchCwd } from "./embedded-server.ts";

describe("normalizeApiRoutePath", () => {
  it("strips query params before API route matching", () => {
    expect(normalizeApiRoutePath("/api/git-branch?foregroundPort=47822")).toBe("/api/git-branch");
  });
});

describe("resolveGitBranchCwd", () => {
  it("prefers the foreground port workspace over latest session ctx cwd", () => {
    const cwd = resolveGitBranchCwd({
      foregroundPort: 47822,
      fallbackCwd: "/repo/default",
      instances: [
        { port: 47821, pid: 1001, sessionFile: "/tmp/a.jsonl", cwd: "/repo/release" },
        { port: 47822, pid: 1002, sessionFile: "/tmp/b.jsonl", cwd: "/repo/only-deduplicate" },
      ],
      latestCtx: {
        sessionManager: {
          getEntries: () => [{ type: "session", cwd: "/repo/release" }],
        },
      },
    });

    expect(cwd).toBe("/repo/only-deduplicate");
  });

  it("falls back to latest session ctx cwd when no matching foreground port exists", () => {
    const cwd = resolveGitBranchCwd({
      foregroundPort: 49999,
      fallbackCwd: "/repo/default",
      instances: [{ port: 47821, pid: 1001, sessionFile: "/tmp/a.jsonl", cwd: "/repo/release" }],
      latestCtx: {
        sessionManager: {
          getEntries: () => [{ type: "session", cwd: "/repo/release" }],
        },
      },
    });

    expect(cwd).toBe("/repo/release");
  });
});
