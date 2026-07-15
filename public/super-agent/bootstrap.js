import { getSuperAgentProject } from "./session.js";

function isLiveSuperAgentSession(session) {
  return session?.isRunning === true && Number.isFinite(session?.port);
}

export async function ensureSuperAgentSession({ superAgentPath, projects, transport }) {
  if (!superAgentPath || !transport?.openWorkspace) return false;
  const superAgent = getSuperAgentProject(projects, superAgentPath);
  if (isLiveSuperAgentSession(superAgent?.session)) return false;

  await transport.openWorkspace(superAgentPath, {
    sessionPath: superAgent?.session?.filePath || null,
    forceNewSession: false,
    openWindow: false,
    waitForHealth: true,
    waitForSessions: true,
  });
  return true;
}
