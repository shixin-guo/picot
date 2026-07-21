// ABOUTME: Builds stable workspace identities and merges Pi history with live instances.
// ABOUTME: Resolves ordered workspace groups for workspace and session Pins.

export function normalizeWorkspacePath(value) {
  if (typeof value !== "string" || !value.startsWith("/")) return "";
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}
export function historyWorkspaceId(project) {
  return typeof project?.dirName === "string" && project.dirName
    ? `history:${project.dirName}`
    : "";
}
export function provisionalWorkspaceId(path) {
  const normalized = normalizeWorkspacePath(path);
  return normalized ? `path:${normalized}` : "";
}
const time = (value) => {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
};
const sessionTime = (s) => Math.max(time(s?.timestamp), Number(s?.ctime) || 0);
function latestActivity(sessions, instances) {
  let latest = 0;
  for (const session of sessions) latest = Math.max(latest, sessionTime(session));
  for (const instance of instances) latest = Math.max(latest, time(instance?.startedAt));
  return latest;
}
function folderName(path) {
  const parts = String(path || "")
    .split("/")
    .filter(Boolean);
  return parts.at(-1) || String(path || "");
}

export function mergeWorkspaceProjects(
  historyProjects = [],
  runningInstances = [],
  previousProjects = [],
) {
  const byPath = new Map();
  const liveByPath = new Map();
  for (const instance of Array.isArray(runningInstances) ? runningInstances : []) {
    const path = normalizeWorkspacePath(instance?.cwd);
    if (!path) continue;
    const list = liveByPath.get(path) || [];
    list.push(instance);
    liveByPath.set(path, list);
  }
  for (const project of Array.isArray(historyProjects) ? historyProjects : []) {
    const path = normalizeWorkspacePath(project?.path);
    const workspaceId = historyWorkspaceId(project);
    if (!path || !workspaceId) continue;
    const sessions = Array.isArray(project.sessions) ? project.sessions : [];
    const instances = liveByPath.get(path) || [];
    const activityAt = latestActivity(sessions, instances);
    byPath.set(path, {
      workspaceId,
      path: project.path,
      folderName: folderName(project.path),
      dirName: project.dirName,
      sessions,
      runningInstances: instances,
      isProvisional: false,
      source: "history",
      activityAt,
      lastActivityAt: activityAt,
    });
  }
  for (const [path, instances] of liveByPath) {
    if (byPath.has(path)) continue;
    const activityAt = latestActivity([], instances);
    byPath.set(path, {
      workspaceId: provisionalWorkspaceId(path),
      path,
      folderName: folderName(path),
      dirName: "",
      sessions: [],
      runningInstances: instances,
      isProvisional: true,
      source: "live",
      activityAt,
      lastActivityAt: activityAt,
    });
  }
  const projects = [...byPath.values()].sort(
    (a, b) => b.activityAt - a.activityAt || a.workspaceId.localeCompare(b.workspaceId),
  );
  const previous = new Map(
    (Array.isArray(previousProjects) ? previousProjects : []).map((project) => [
      normalizeWorkspacePath(project.path),
      project,
    ]),
  );
  const reconciliations = [];
  for (const project of projects) {
    const old = previous.get(normalizeWorkspacePath(project.path));
    if (old?.isProvisional && !project.isProvisional && old.workspaceId !== project.workspaceId)
      reconciliations.push({
        fromId: old.workspaceId,
        toId: project.workspaceId,
        path: project.path,
      });
  }
  if (reconciliations.length) {
    const indexes = new Map(projects.map((p, i) => [p.workspaceId, i]));
    for (const reconciliation of reconciliations) {
      const old = previous.get(normalizeWorkspacePath(reconciliation.path));
      const targetIndex = indexes.get(reconciliation.toId);
      const priorIndex = [...(previousProjects || [])].findIndex(
        (p) => p.workspaceId === old.workspaceId,
      );
      if (targetIndex >= 0 && priorIndex >= 0) {
        const [row] = projects.splice(targetIndex, 1);
        projects.splice(Math.min(priorIndex, projects.length), 0, row);
      }
    }
  }
  return { projects, reconciliations };
}

export function workspaceModelSignature(projects = []) {
  return JSON.stringify(
    projects
      .map((p) => ({
        id: p.workspaceId,
        path: p.path,
        activityAt: p.activityAt,
        sessions: (p.sessions || []).map((s) => [s.filePath, s.name, s.timestamp]),
        instances: (p.runningInstances || []).map((i) => [i.port, i.sessionFile, i.startedAt]),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function resolvePinnedWorkspaceGroups({
  pinState = {},
  projects = [],
  archivedPaths = [],
} = {}) {
  const byId = new Map(projects.map((p) => [p.workspaceId, p]));
  const byPath = new Map(projects.map((p) => [normalizeWorkspacePath(p.path), p]));
  const bySession = new Map();
  for (const project of projects)
    for (const session of project.sessions || [])
      bySession.set(session.filePath, { session, project });
  const archived = new Set(archivedPaths);
  const groups = [];
  const owned = new Set();
  for (const pin of Array.isArray(pinState.workspaces) ? pinState.workspaces : []) {
    const project = byId.get(pin.id) || byPath.get(normalizeWorkspacePath(pin.path));
    if (!project) {
      groups.push({
        workspace: { workspaceId: pin.id, path: pin.path, sessions: [], unavailable: true },
        workspacePin: true,
        sessions: [],
        unavailable: true,
      });
      continue;
    }
    owned.add(project.workspaceId);
    groups.push({
      workspace: project,
      workspacePin: true,
      sessions: (project.sessions || []).filter((s) => !archived.has(s.filePath)),
      unavailable: false,
    });
  }
  const sessionGroups = new Map();
  for (const filePath of Array.isArray(pinState.sessions) ? pinState.sessions : []) {
    if (archived.has(filePath)) continue;
    const resolved = bySession.get(filePath);
    if (!resolved) {
      groups.push({
        workspace: null,
        workspacePin: false,
        sessions: [{ filePath, unavailable: true }],
        unavailable: true,
      });
      continue;
    }
    if (owned.has(resolved.project.workspaceId)) continue;
    if (!sessionGroups.has(resolved.project.workspaceId))
      sessionGroups.set(resolved.project.workspaceId, {
        workspace: resolved.project,
        workspacePin: false,
        sessions: [],
        unavailable: false,
      });
    sessionGroups.get(resolved.project.workspaceId).sessions.push(resolved.session);
  }
  return [...groups, ...sessionGroups.values()];
}
