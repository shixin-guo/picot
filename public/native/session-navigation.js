export function createSessionSelectionHandler({
  switchSession,
  openSessionInProject,
  onError,
} = {}) {
  return function selectSession(session) {
    const sessionId = typeof session === "string" ? session : session?.id;
    if (!sessionId) return;

    const isCurrentWorkspace =
      typeof session === "string" ? true : Boolean(session?.isCurrentWorkspace);
    if (isCurrentWorkspace) {
      Promise.resolve(switchSession?.(sessionId)).catch((error) => onError?.(error));
      return;
    }

    Promise.resolve(openSessionInProject?.(session)).catch((error) => onError?.(error));
  };
}
