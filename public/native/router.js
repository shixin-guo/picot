// Workspace ids are v4 UUIDs and session ids are v7 UUIDs, both of which may
// start with a digit (e.g. "29e2ccd0-…", "019f80bd-…"). Allow a leading
// alphanumeric so those routes parse; "." and "/" stay disallowed so the value
// can never encode a path-traversal segment.
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function validId(value) {
  return typeof value === "string" && OPAQUE_ID.test(value);
}

export function parseAppRoute(pathname) {
  if (pathname === "/app/settings") return { name: "settings" };
  const segments = pathname.split("/");
  if (
    segments.length === 5 &&
    segments[1] === "app" &&
    segments[2] === "workspaces" &&
    validId(segments[3]) &&
    segments[4] === "launcher"
  ) {
    return { name: "launcher", workspaceId: segments[3] };
  }
  if (
    segments.length === 6 &&
    segments[1] === "app" &&
    segments[2] === "workspaces" &&
    validId(segments[3]) &&
    segments[4] === "sessions" &&
    validId(segments[5])
  ) {
    return { name: "session", workspaceId: segments[3], sessionId: segments[5] };
  }
  return { name: "not_found" };
}

export function appRoutePath(route) {
  switch (route.name) {
    case "launcher":
      if (!validId(route.workspaceId)) throw new Error("Invalid workspaceId");
      return `/app/workspaces/${route.workspaceId}/launcher`;
    case "session":
      if (!validId(route.workspaceId) || !validId(route.sessionId)) {
        throw new Error("Invalid workspaceId or sessionId");
      }
      return `/app/workspaces/${route.workspaceId}/sessions/${route.sessionId}`;
    case "settings":
      return "/app/settings";
    default:
      throw new Error(`Cannot build unknown app route: ${route.name}`);
  }
}

export function replaceTemporarySessionRoute(
  history,
  workspaceId,
  temporarySessionId,
  formalSessionId,
) {
  if (!validId(temporarySessionId)) throw new Error("Invalid temporary sessionId");
  const path = appRoutePath({ name: "session", workspaceId, sessionId: formalSessionId });
  history.replaceState(null, "", path);
}
