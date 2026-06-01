// Multi-task model
// ──────────────────
// A `pi --mode rpc` process can only drive ONE active session at a time.
// `new_session` / `switch_session` / fork inside an existing process just
// *replace* the active session — the previous session's .jsonl stays on
// disk and can be reloaded later, but it stops being the live, running
// session in that process. So any concurrently-running session structurally
// needs its own pi process.
//
// "Start a new session" entry points (header "+ New Session" and sidebar
// project tile "start new chat") both use the same pattern: spawn a fresh
// HEADLESS pi for the target cwd and navigate THIS window's WebView to
// the new port. The previously-attached pi process keeps running in the
// background (PiManager retains it) and is reachable via the
// running-instances list / launcher / sidebar. Net effect: no new OS
// window, no interruption of any previously-running session.
//
// "Open project" / "Open folder" entry points still attach to an existing
// pi instance for the same cwd when one exists — those actions are about
// *finding* the project, not starting a new task.
//
// Swap overlay
// ──────────────
// All entry points that end in `navigate(url)` (a full-page WebView
// reload) optionally take an `onBeforeSwap` callback. The host (app.js)
// uses it to raise a full-screen overlay so the user sees a continuous
// spinner instead of a 1–2 second freeze (while pi spawns) followed by a
// white flash (while the WebView reloads). The overlay is persisted
// across the navigation boundary via sessionStorage; the new page boots
// straight into it (see index.html bootstrap script).

function runOnBeforeSwap(onBeforeSwap, label) {
  if (typeof onBeforeSwap !== 'function') return () => {};
  try {
    return onBeforeSwap(label) || (() => {});
  } catch {
    return () => {};
  }
}

// "Attach to workspace" flow used by Open Project / Open Folder. Reuses an
// existing pi instance for the same cwd when present, otherwise spawns a
// windowless pi and navigates the *current* window to it.
async function attachToWorkspace({
  targetCwd,
  tauriNative,
  fetchInstances,
  getCurrentPort,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  const instances = await fetchInstances();
  const currentPort = getCurrentPort();
  const current = instances.find((i) => i.port === currentPort);

  if (current && current.cwd === targetCwd) {
    return { samePort: true, port: currentPort };
  }

  const existing = instances.find((i) => i.cwd === targetCwd);
  let targetPort = existing?.port;

  const dismissOverlay = runOnBeforeSwap(onBeforeSwap, 'Opening workspace…');
  if (!targetPort) {
    try {
      targetPort = await tauriNative.openWorkspace(targetCwd, {
        forceNewSession: false,
        openWindow: false,
        waitForSessions: false,
      });
    } catch (e) {
      dismissOverlay();
      if (renderError) renderError(`Failed to attach to workspace: ${e}`);
      return null;
    }
  }

  navigate(`http://localhost:${targetPort}/`);
  return { samePort: false, port: targetPort };
}

// "+ New Session" button in the current window's header.
// Spawns a fresh headless pi process for the current cwd, then navigates
// THIS window's WebView to it. The previous pi process keeps running in
// the background — it's not killed, just no longer attached to this
// window. The user can return to it via the running-instances list.
export async function startInWindowNewSession({
  tauriNative,
  getCurrentCwd,
  getCurrentPort,
  fetchInstances,
  navigate,
  onBeforeSwap,
  shouldSpawnParallel,
  onInPlaceSessionCreated,
  renderError,
}) {
  if (!tauriNative) {
    renderError('New session is only supported in Tauri mode.');
    return false;
  }

  let targetCwd = null;
  if (typeof getCurrentCwd === 'function') {
    try {
      targetCwd = getCurrentCwd();
    } catch {
      targetCwd = null;
    }
  }

  if (!targetCwd && fetchInstances && getCurrentPort) {
    try {
      const instances = await fetchInstances();
      const port = getCurrentPort();
      targetCwd = instances.find((i) => i.port === port)?.cwd || null;
    } catch {
      targetCwd = null;
    }
  }

  if (!targetCwd) {
    renderError('Failed to start new session: current workspace path is unavailable');
    return false;
  }

  if (typeof navigate !== 'function') {
    renderError('Failed to start new session: navigation is unavailable');
    return false;
  }

  const currentPort = typeof getCurrentPort === 'function' ? getCurrentPort() : null;
  const wantsParallel = typeof shouldSpawnParallel === 'function' ? Boolean(shouldSpawnParallel()) : false;
  if (!wantsParallel && typeof currentPort === 'number' && Number.isFinite(currentPort)) {
    try {
      await tauriNative.newSession(currentPort);
      if (typeof onInPlaceSessionCreated === 'function') {
        onInPlaceSessionCreated();
      }
      return true;
    } catch (e) {
      renderError(`Failed to start new session: ${e}`);
      return false;
    }
  }

  const dismissOverlay = runOnBeforeSwap(onBeforeSwap, 'Starting session…');
  try {
    const newPort = await tauriNative.openWorkspace(targetCwd, {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    navigate(`http://localhost:${newPort}/`);
    return true;
  } catch (e) {
    dismissOverlay();
    renderError(`Failed to start new session: ${e}`);
    return false;
  }
}

function resolveProjectCwd(project) {
  return project?.sessions?.find((session) => session?.cwd)?.cwd || project?.path;
}

// Sidebar "start new chat" entry point (project tile in the open
// workspace window). Spawns a fresh headless pi for the project's cwd
// and navigates THIS window to it. The previously-attached pi process
// stays alive in the background (PiManager retains it; reachable via
// the running-instances list). No new OS window is opened, and no
// running session is interrupted — same model as in-window "+ New
// Session", just sourced from a project tile instead of the header.
export async function startNewProjectChat({
  project,
  tauriNative,
  getCurrentPort,
  getCurrentCwd,
  shouldSpawnParallel,
  onInPlaceSessionCreated,
  fetchInstances,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  if (!tauriNative) {
    renderError('Project new chat is only supported in Tauri mode.');
    return false;
  }

  const targetCwd = resolveProjectCwd(project);
  if (!targetCwd) {
    renderError('Failed to start new chat: project path is unavailable');
    return false;
  }

  if (typeof navigate !== 'function') {
    renderError('Failed to start new chat: navigation is unavailable');
    return false;
  }

  const currentCwd = typeof getCurrentCwd === 'function' ? getCurrentCwd() : null;
  const currentPort = typeof getCurrentPort === 'function' ? getCurrentPort() : null;
  const sameWorkspace = Boolean(currentCwd && targetCwd && currentCwd === targetCwd);
  const wantsParallel = typeof shouldSpawnParallel === 'function' ? Boolean(shouldSpawnParallel()) : false;

  if (sameWorkspace && !wantsParallel && typeof currentPort === 'number' && Number.isFinite(currentPort)) {
    try {
      await tauriNative.newSession(currentPort);
      if (typeof onInPlaceSessionCreated === 'function') {
        onInPlaceSessionCreated();
      }
      return true;
    } catch (e) {
      renderError(`Failed to start new chat: ${e}`);
      return false;
    }
  }

  if (!wantsParallel) {
    const result = await attachToWorkspace({
      targetCwd,
      tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate,
      onBeforeSwap,
      renderError,
    });
    return result !== null;
  }

  const dismissOverlay = runOnBeforeSwap(onBeforeSwap, 'Starting new chat…');
  try {
    const newPort = await tauriNative.openWorkspace(targetCwd, {
      forceNewSession: false,
      openWindow: false,
      waitForSessions: false,
    });
    navigate(`http://localhost:${newPort}/`);
    return true;
  } catch (e) {
    dismissOverlay();
    renderError(`Failed to start new chat: ${e}`);
    return false;
  }
}

// Launcher bubble / "Open Folder" entry point. Does NOT spawn a parallel
// pi if one is already running for that cwd — opening a project is about
// *finding* it, not starting a new task. The user can still hit "+ New
// Session" inside the workspace window to fork a parallel agent.
export async function openProjectWorkspace({
  project,
  tauriNative,
  fetchInstances,
  getCurrentPort,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  if (!tauriNative) {
    renderError('Open project is only supported in Tauri mode.');
    return false;
  }

  const targetCwd = resolveProjectCwd(project);
  if (!targetCwd) {
    renderError('Failed to open project: project path is unavailable');
    return false;
  }

  try {
    const result = await attachToWorkspace({
      targetCwd,
      tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate,
      onBeforeSwap,
      renderError,
    });
    return result !== null;
  } catch (e) {
    renderError(`Failed to open project: ${e}`);
    return false;
  }
}

export async function openFolderAsWorkspace({
  tauriNative,
  fetchInstances,
  getCurrentPort,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  if (!tauriNative) {
    renderError('Open folder is only supported in Tauri mode.');
    return false;
  }

  try {
    const selectedPath = await tauriNative.pickFolder();
    if (!selectedPath) return false;

    const result = await attachToWorkspace({
      targetCwd: selectedPath,
      tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate,
      onBeforeSwap,
      renderError,
    });
    return result !== null;
  } catch (e) {
    renderError(`Failed to open folder: ${e}`);
    return false;
  }
}
