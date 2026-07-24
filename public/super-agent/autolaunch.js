import { isSuperAgentProjectPath } from "./session.js";

export function selectSuperAgentSessionToLaunch({
  alreadyLaunched = false,
  enabled = false,
  sessions = [],
  currentSessionId = "",
} = {}) {
  if (alreadyLaunched || !enabled) return null;

  const currentSession = sessions.find((session) => session.id === currentSessionId);
  if (currentSession && isSuperAgentSession(currentSession)) return null;

  const superAgentSessions = sessions.filter((session) => isSuperAgentSession(session));
  if (superAgentSessions.length === 0) return null;

  return superAgentSessions.reduce((a, b) => ((a.timestamp ?? 0) >= (b.timestamp ?? 0) ? a : b));
}

function isSuperAgentSession(session) {
  return session?.kind === "super-agent" || isSuperAgentProjectPath(session?.projectPath);
}
