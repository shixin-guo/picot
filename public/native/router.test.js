import { describe, expect, it } from "vitest";
import { appRoutePath, parseAppRoute, replaceTemporarySessionRoute } from "./router.js";

describe("app router", () => {
  it("round-trips opaque launcher and session routes", () => {
    const launcher = { name: "launcher", workspaceId: "workspace_A-1" };
    expect(parseAppRoute(appRoutePath(launcher))).toEqual(launcher);
    const session = {
      name: "session",
      workspaceId: "workspace_A-1",
      sessionId: "session_B-2",
    };
    expect(parseAppRoute(appRoutePath(session))).toEqual(session);
    expect(parseAppRoute("/app/settings")).toEqual({ name: "settings" });
  });

  it("rejects paths, ports, malformed IDs, and unknown routes", () => {
    for (const path of [
      "/app/workspaces//launcher",
      "/app/workspaces/3001/sessions//tmp/session.jsonl",
      "/app/workspaces/workspace%2Fescape/launcher",
      "/api/rpc",
    ]) {
      expect(parseAppRoute(path)).toEqual({ name: "not_found" });
    }
  });

  it("atomically replaces a temporary session route", () => {
    const calls = [];
    const history = { replaceState: (...args) => calls.push(args) };
    replaceTemporarySessionRoute(history, "workspace-a", "temporary-1", "session-formal");
    expect(calls).toEqual([[null, "", "/app/workspaces/workspace-a/sessions/session-formal"]]);
  });
});
