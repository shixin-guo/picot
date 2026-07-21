export function findPortForSession(instances, sessionFile, fallbackPort) {
  const match = Array.isArray(instances)
    ? instances.find((instance) => instance?.sessionFile === sessionFile)
    : null;
  return typeof match?.port === "number" ? match.port : fallbackPort;
}

export function getWorkspacePathForPort(instances, port) {
  const match = Array.isArray(instances)
    ? instances.find((instance) => instance?.port === port)
    : null;
  return match?.cwd || "";
}

export function shouldSpawnForCrossWorkspaceSelection(
  instances,
  foregroundPort,
  selectedProjectPath,
) {
  if (!selectedProjectPath) return false;
  const foregroundCwd = getWorkspacePathForPort(instances, foregroundPort);
  return Boolean(foregroundCwd && foregroundCwd !== selectedProjectPath);
}

export function isForegroundMirrorSync(syncPort, foregroundPort) {
  return !(
    typeof syncPort === "number" &&
    typeof foregroundPort === "number" &&
    syncPort !== foregroundPort
  );
}

export function isExpectedMirrorSession(expectedSessionFile, receivedSessionFile) {
  return (
    typeof expectedSessionFile !== "string" ||
    !expectedSessionFile ||
    expectedSessionFile === receivedSessionFile
  );
}

export function applyForegroundMirrorSession({
  syncPort,
  foregroundPort,
  sessionFile,
  expectedSessionFile = null,
  setMirrorActiveSessionFile,
  setSidebarActive,
}) {
  if (
    !isForegroundMirrorSync(syncPort, foregroundPort) ||
    !isExpectedMirrorSession(expectedSessionFile, sessionFile)
  ) {
    return false;
  }

  const activeSessionFile = sessionFile || null;
  setMirrorActiveSessionFile(activeSessionFile);
  if (activeSessionFile) setSidebarActive(activeSessionFile);
  return true;
}

export function deferFileBrowserWorkspace(sessionFile, projectPath, currentWorkspacePath) {
  if (
    typeof sessionFile !== "string" ||
    !sessionFile ||
    typeof projectPath !== "string" ||
    !projectPath ||
    projectPath === currentWorkspacePath
  ) {
    return null;
  }
  return { sessionFile, path: projectPath };
}

export function confirmDeferredFileBrowserWorkspace(pendingWorkspace, sessionFile) {
  if (
    !pendingWorkspace ||
    typeof sessionFile !== "string" ||
    pendingWorkspace.sessionFile !== sessionFile
  ) {
    return null;
  }
  return pendingWorkspace;
}
