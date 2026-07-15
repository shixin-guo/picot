export function resolveNewSessionLiveFile({
  event = null,
  liveInstances = [],
  foregroundPort = null,
  mirrorActiveSessionFile = null,
  excludedSessionFile = null,
} = {}) {
  const candidates = [
    event?.__broker?.sessionId,
    mirrorActiveSessionFile,
    liveInstances.find((i) => i?.port === foregroundPort)?.sessionFile,
  ];

  for (const file of candidates) {
    if (!file || file === excludedSessionFile) continue;
    return file;
  }

  return null;
}
