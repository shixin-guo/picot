import { describe, expect, test } from "vitest";
import * as sessionRouting from "./routing.js";

describe("session routing helpers", () => {
  const instances = [
    { port: 47821, sessionFile: "/tmp/session-a.jsonl", cwd: "/tmp/a" },
    { port: 47822, sessionFile: "/tmp/session-b.jsonl", cwd: "/tmp/b" },
  ];

  test("resolves the active pi process by selected session file", () => {
    expect(sessionRouting.findPortForSession(instances, "/tmp/session-b.jsonl", 47821)).toBe(47822);
  });

  test("resolves workspace path from the active pi process port", () => {
    expect(sessionRouting.getWorkspacePathForPort(instances, 47822)).toBe("/tmp/b");
  });

  test("spawns instead of switching when selected project differs from foreground workspace", () => {
    expect(sessionRouting.shouldSpawnForCrossWorkspaceSelection(instances, 47822, "/tmp/a")).toBe(
      true,
    );
    expect(sessionRouting.shouldSpawnForCrossWorkspaceSelection(instances, 47822, "/tmp/b")).toBe(
      false,
    );
  });
});

test("recognizes only a different numeric source port as a background mirror sync", () => {
  expect(sessionRouting.isForegroundMirrorSync(3001, 3001)).toBe(true);
  expect(sessionRouting.isForegroundMirrorSync(3002, 3001)).toBe(false);
  expect(sessionRouting.isForegroundMirrorSync(null, 3001)).toBe(true);
  expect(sessionRouting.isForegroundMirrorSync(3002, null)).toBe(true);
});

test("applies a foreground mirror session to both active-session owners", () => {
  let mirrorSessionFile = null;
  let sidebarSessionFile = null;

  const applied = sessionRouting.applyForegroundMirrorSession?.({
    syncPort: 3001,
    foregroundPort: 3001,
    sessionFile: "/tmp/session-a.jsonl",
    setMirrorActiveSessionFile: (filePath) => {
      mirrorSessionFile = filePath;
    },
    setSidebarActive: (filePath) => {
      sidebarSessionFile = filePath;
    },
  });

  expect(applied).toBe(true);
  expect(mirrorSessionFile).toBe("/tmp/session-a.jsonl");
  expect(sidebarSessionFile).toBe("/tmp/session-a.jsonl");
});

test("does not apply a background mirror session", () => {
  let mirrorSessionFile = "/tmp/current.jsonl";
  let sidebarSessionFile = "/tmp/current.jsonl";

  const applied = sessionRouting.applyForegroundMirrorSession?.({
    syncPort: 3002,
    foregroundPort: 3001,
    sessionFile: "/tmp/background.jsonl",
    setMirrorActiveSessionFile: (filePath) => {
      mirrorSessionFile = filePath;
    },
    setSidebarActive: (filePath) => {
      sidebarSessionFile = filePath;
    },
  });

  expect(applied).toBe(false);
  expect(mirrorSessionFile).toBe("/tmp/current.jsonl");
  expect(sidebarSessionFile).toBe("/tmp/current.jsonl");
});

test("rejects a same-port mirror snapshot until it confirms the selected session", () => {
  expect(
    sessionRouting.isExpectedMirrorSession("/history/selected.jsonl", "/history/previous.jsonl"),
  ).toBe(false);
  expect(
    sessionRouting.isExpectedMirrorSession("/history/selected.jsonl", "/history/selected.jsonl"),
  ).toBe(true);
  expect(sessionRouting.isExpectedMirrorSession(null, "/history/previous.jsonl")).toBe(true);
});

test("does not replace active-session owners with a stale same-port snapshot", () => {
  let mirrorSessionFile = "/history/selected.jsonl";
  let sidebarSessionFile = "/history/selected.jsonl";

  const applied = sessionRouting.applyForegroundMirrorSession({
    syncPort: 3001,
    foregroundPort: 3001,
    expectedSessionFile: "/history/selected.jsonl",
    sessionFile: "/history/previous.jsonl",
    setMirrorActiveSessionFile: (filePath) => {
      mirrorSessionFile = filePath;
    },
    setSidebarActive: (filePath) => {
      sidebarSessionFile = filePath;
    },
  });

  expect(applied).toBe(false);
  expect(mirrorSessionFile).toBe("/history/selected.jsonl");
  expect(sidebarSessionFile).toBe("/history/selected.jsonl");
});

test("defers a cross-workspace file tree load until the selected session is confirmed", () => {
  const pending = sessionRouting.deferFileBrowserWorkspace(
    "/history/new.jsonl",
    "/work/new",
    "/work/old",
  );

  expect(pending).toEqual({ sessionFile: "/history/new.jsonl", path: "/work/new" });
  expect(
    sessionRouting.confirmDeferredFileBrowserWorkspace(pending, "/history/old.jsonl"),
  ).toBeNull();
  expect(sessionRouting.confirmDeferredFileBrowserWorkspace(pending, "/history/new.jsonl")).toEqual(
    pending,
  );
});

test("does not defer an already-loaded workspace or one without a project path", () => {
  expect(
    sessionRouting.deferFileBrowserWorkspace(
      "/history/current.jsonl",
      "/work/current",
      "/work/current",
    ),
  ).toBeNull();
  expect(
    sessionRouting.deferFileBrowserWorkspace("/history/new.jsonl", "", "/work/old"),
  ).toBeNull();
});

test("defers a new-session activation with no sessionFile yet", () => {
  // A brand-new session's .jsonl isn't assigned until pi's first session_start,
  // so activateNewParallelSession defers with a null sessionFile. Confirmation
  // then matches any foreground mirror_sync (the caller gates on foreground port).
  const pending = sessionRouting.deferFileBrowserWorkspace(null, "/work/new", "/work/old");
  expect(pending).toEqual({ sessionFile: null, path: "/work/new" });
  expect(
    sessionRouting.confirmDeferredFileBrowserWorkspace(pending, "/work/new-session.jsonl"),
  ).toBe(pending);
});

test("suppresses file browser loads while a cross-workspace switch is pending", () => {
  const pending = sessionRouting.deferFileBrowserWorkspace(
    "/history/new.jsonl",
    "/work/new",
    "/work/old",
  );
  expect(sessionRouting.shouldSuppressFileBrowserLoad(pending)).toBe(true);
});

test("suppresses file browser loads during a new-session activation", () => {
  const pending = sessionRouting.deferFileBrowserWorkspace(null, "/work/new", "/work/old");
  expect(sessionRouting.shouldSuppressFileBrowserLoad(pending)).toBe(true);
});

test("does not suppress file browser loads without a pending switch", () => {
  expect(sessionRouting.shouldSuppressFileBrowserLoad(null)).toBe(false);
  // Same-workspace select produces no pending token — loads proceed normally.
  const sameWorkspace = sessionRouting.deferFileBrowserWorkspace(
    "/history/current.jsonl",
    "/work/current",
    "/work/current",
  );
  expect(sessionRouting.shouldSuppressFileBrowserLoad(sameWorkspace)).toBe(false);
});
