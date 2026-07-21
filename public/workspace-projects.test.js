// ABOUTME: Verifies workspace identity, history/instance merging, and Pin grouping.
// ABOUTME: Keeps zero-session projects and reconciliation deterministic.
import { expect, test } from "vitest";
import {
  mergeWorkspaceProjects,
  normalizeWorkspacePath,
  resolvePinnedWorkspaceGroups,
  workspaceModelSignature,
} from "./workspace-projects.js";

test("normalizes conservative absolute paths", () => {
  expect(normalizeWorkspacePath("/Users//lin/Work/../Work/picot/")).toBe("/Users/lin/Work/picot");
  expect(normalizeWorkspacePath("relative/path")).toBe("");
  expect(normalizeWorkspacePath("/Users/lin/Picot")).not.toBe(
    normalizeWorkspacePath("/Users/lin/picot"),
  );
});
test("merges live zero-session workspaces and orders by activity", () => {
  const result = mergeWorkspaceProjects(
    [
      {
        path: "/work/history",
        dirName: "--work-history",
        sessions: [{ filePath: "/sessions/a.jsonl", timestamp: "2026-07-13T10:00:00Z" }],
      },
    ],
    [{ cwd: "/work/new", startedAt: "2026-07-14T10:00:00Z" }],
    [],
  );
  expect(result.projects.map((p) => p.workspaceId)).toEqual([
    "path:/work/new",
    "history:--work-history",
  ]);
  expect(result.projects[0].sessions).toEqual([]);
});
test("aggregates activity without spreading a large session list", () => {
  const sessions = Array.from({ length: 150_000 }, (_, index) => ({
    filePath: `/sessions/${index}.jsonl`,
    ctime: index,
  }));
  const result = mergeWorkspaceProjects(
    [{ path: "/work/large", dirName: "large", sessions }],
    [],
    [],
  );
  expect(result.projects[0].activityAt).toBe(149_999);
});
test("reconciles provisional identity without duplicate", () => {
  const result = mergeWorkspaceProjects(
    [
      {
        path: "/work/picot",
        dirName: "--work-picot",
        sessions: [{ filePath: "/sessions/new.jsonl" }],
      },
    ],
    [{ cwd: "/work/picot", startedAt: "2026-07-14T10:00:00Z" }],
    [{ workspaceId: "path:/work/picot", path: "/work/picot", isProvisional: true }],
  );
  expect(result.projects).toHaveLength(1);
  expect(result.reconciliations).toEqual([
    { fromId: "path:/work/picot", toId: "history:--work-picot", path: "/work/picot" },
  ]);
});
test("resolves workspace and session-only Pin groups", () => {
  const projects = [
    {
      workspaceId: "history:a",
      path: "/work/a",
      sessions: [{ filePath: "/s/a" }, { filePath: "/s/old" }],
    },
  ];
  expect(
    resolvePinnedWorkspaceGroups({
      pinState: { workspaces: [{ id: "history:a", path: "/work/a" }], sessions: ["/s/a"] },
      projects,
      archivedPaths: ["/s/old"],
    })[0].sessions,
  ).toHaveLength(1);
});
test("signature is stable for equivalent logical models", () => {
  const a = [
    { workspaceId: "history:a", path: "/a", activityAt: 1, sessions: [], runningInstances: [] },
  ];
  expect(workspaceModelSignature(a)).toBe(workspaceModelSignature(structuredClone(a)));
});
