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
