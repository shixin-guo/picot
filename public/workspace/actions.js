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

// Append the broker WS URL to a navigation target so the freshly-loaded
// page (on a *different* origin/port) can reach the shared broker. Without
// this the new page can't recover the broker URL: it isn't in the URL, and
// sessionStorage is per-origin so it isn't shared across the port change.
// The new page then silently falls back to its own per-instance /ws,
// bypassing the broker multiplexer. Mirrors the Rust windowed path
// (open_workspace_window) which already appends ?brokerWs=.
export function withBrokerWs(url, transport) {
  let brokerUrl = "";
  try {
    brokerUrl = transport?.brokerWsUrl?.() || "";
  } catch {
    brokerUrl = "";
  }
  if (!brokerUrl) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}brokerWs=${encodeURIComponent(brokerUrl)}`;
}

export function buildWorkspaceUrl(port, env = globalThis.window || globalThis) {
  const loc = env?.location || globalThis.location;
  const host = loc?.hostname || "localhost";
  return `http://${host}:${port}/`;
}

// True when an in-place `new_session(port)` / `switch_session(port)` RPC
// failed because the target port is no longer backed by a pi process the
// Rust PiManager owns. This happens when `foregroundPort` drifts to a stale
// port — e.g. a dedicated/background session process that has since exited,
// or a leftover port from a previous run. The caller should recover by
// spawning a fresh process rather than surfacing the raw error.
export function isDeadPortError(error) {
  const message = typeof error === "string" ? error : error?.message || String(error || "");
  return /No pi instance on port/i.test(message);
}

function runOnBeforeSwap(onBeforeSwap, label) {
  if (typeof onBeforeSwap !== "function") return () => {};
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
  transport,
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

  const dismissOverlay = runOnBeforeSwap(onBeforeSwap, "Opening workspace…");
  if (!targetPort) {
    try {
      targetPort = await transport.openWorkspace(targetCwd, {
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

  navigate(withBrokerWs(buildWorkspaceUrl(targetPort), transport));
  return { samePort: false, port: targetPort };
}

// "+ New Session" button in the current window's header.
// Spawns a fresh headless pi process for the current cwd, then navigates
// THIS window's WebView to it. The previous pi process keeps running in
// the background — it's not killed, just no longer attached to this
// window. The user can return to it via the running-instances list.
export async function startInWindowNewSession({
  transport,
  getCurrentCwd,
  getCurrentPort,
  fetchInstances,
  navigate,
  onBeforeSwap,
  shouldSpawnParallel,
  onInPlaceSessionCreated,
  onParallelSessionCreated,
  renderError,
}) {
  if (!transport) {
    renderError("New session is only supported with a native host.");
    return false;
  }

  let targetCwd = null;
  if (typeof getCurrentCwd === "function") {
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
    renderError("Failed to start new session: current workspace path is unavailable");
    return false;
  }

  if (typeof navigate !== "function") {
    renderError("Failed to start new session: navigation is unavailable");
    return false;
  }

  const currentPort = typeof getCurrentPort === "function" ? getCurrentPort() : null;
  const wantsParallel =
    typeof shouldSpawnParallel === "function" ? Boolean(shouldSpawnParallel()) : false;
  console.debug("[Session route] newSession:decision", {
    targetCwd,
    currentPort,
    wantsParallel,
    mode: wantsParallel ? "parallel-spawn" : "in-place",
  });
  if (!wantsParallel && typeof currentPort === "number" && Number.isFinite(currentPort)) {
    try {
      await transport.newSession(currentPort);
      if (typeof onInPlaceSessionCreated === "function") {
        onInPlaceSessionCreated();
      }
      return true;
    } catch (e) {
      // If the in-place target port has drifted to a dead/unmanaged process,
      // don't fail — recover by spawning a fresh process for this workspace.
      if (!isDeadPortError(e)) {
        renderError(`Failed to start new session: ${e}`);
        return false;
      }
      console.warn("[Session route] newSession:in-place-dead-port, spawning fresh process", {
        currentPort,
        error: String(e),
      });
    }
  }

  return spawnFreshSession({
    targetCwd,
    transport,
    navigate,
    onBeforeSwap,
    onParallelSessionCreated,
    renderError,
    label: "Starting session…",
    debugTag: "newSession",
  });
}

// Spawn a brand-new headless pi for `targetCwd` and either activate it
// in-place (when `onParallelSessionCreated` is provided) or navigate the
// current window to it. Shared by "+ New Session" (parallel + dead-port
// fallback) and the project-tile "start new chat" flow.
async function spawnFreshSession({
  targetCwd,
  transport,
  navigate,
  onBeforeSwap,
  onParallelSessionCreated,
  renderError,
  label,
  debugTag,
  errorLabel = "Failed to start new session",
}) {
  const dismissOverlay = runOnBeforeSwap(onBeforeSwap, label);
  try {
    // Wait before both in-place activation and full-page navigation. Otherwise
    // remote/mobile clients can land on a not-yet-listening embedded port and
    // get stuck behind the swap overlay.
    const waitForHealth = true;
    const newPort = await transport.openWorkspace(targetCwd, {
      forceNewSession: false,
      openWindow: false,
      waitForHealth,
      waitForSessions: false,
    });
    console.debug(`[Session route] ${debugTag}:parallel-created`, {
      targetCwd,
      newPort,
    });
    if (typeof onParallelSessionCreated === "function") {
      // In-place activation: no full-page navigation happens, so the swap
      // overlay would otherwise stay up forever. Dismiss it ourselves once
      // the new parallel session is wired up.
      try {
        await onParallelSessionCreated(newPort, targetCwd);
      } finally {
        dismissOverlay();
      }
      return true;
    }
    navigate(withBrokerWs(buildWorkspaceUrl(newPort), transport));
    return true;
  } catch (e) {
    dismissOverlay();
    renderError(`${errorLabel}: ${e}`);
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
  transport,
  getCurrentPort,
  getCurrentCwd,
  shouldSpawnParallel,
  onInPlaceSessionCreated,
  onParallelSessionCreated,
  fetchInstances,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  if (!transport) {
    renderError("Project new chat is only supported with a native host.");
    return false;
  }

  const targetCwd = resolveProjectCwd(project);
  if (!targetCwd) {
    renderError("Failed to start new chat: project path is unavailable");
    return false;
  }

  if (typeof navigate !== "function") {
    renderError("Failed to start new chat: navigation is unavailable");
    return false;
  }

  const currentCwd = typeof getCurrentCwd === "function" ? getCurrentCwd() : null;
  const currentPort = typeof getCurrentPort === "function" ? getCurrentPort() : null;
  const sameWorkspace = Boolean(currentCwd && targetCwd && currentCwd === targetCwd);
  const wantsParallel =
    typeof shouldSpawnParallel === "function" ? Boolean(shouldSpawnParallel()) : false;
  console.debug("[Session route] projectNewChat:decision", {
    targetCwd,
    currentCwd,
    currentPort,
    sameWorkspace,
    wantsParallel,
  });

  if (
    sameWorkspace &&
    !wantsParallel &&
    typeof currentPort === "number" &&
    Number.isFinite(currentPort)
  ) {
    try {
      await transport.newSession(currentPort);
      if (typeof onInPlaceSessionCreated === "function") {
        onInPlaceSessionCreated();
      }
      return true;
    } catch (e) {
      // Drifted/dead foreground port: fall through to spawning a fresh
      // process for this workspace instead of surfacing the raw RPC error.
      if (!isDeadPortError(e)) {
        renderError(`Failed to start new chat: ${e}`);
        return false;
      }
      console.warn("[Session route] projectNewChat:in-place-dead-port, spawning fresh process", {
        currentPort,
        error: String(e),
      });
      return spawnFreshSession({
        targetCwd,
        transport,
        navigate,
        onBeforeSwap,
        onParallelSessionCreated,
        renderError,
        label: "Starting new chat…",
        debugTag: "projectNewChat",
        errorLabel: "Failed to start new chat",
      });
    }
  }

  if (!wantsParallel) {
    const result = await attachToWorkspace({
      targetCwd,
      transport,
      fetchInstances,
      getCurrentPort,
      navigate,
      onBeforeSwap,
      renderError,
    });
    return result !== null;
  }

  return spawnFreshSession({
    targetCwd,
    transport,
    navigate,
    onBeforeSwap,
    onParallelSessionCreated,
    renderError,
    label: "Starting new chat…",
    debugTag: "projectNewChat",
    errorLabel: "Failed to start new chat",
  });
}

// Launcher bubble / "Open Folder" entry point. Does NOT spawn a parallel
// pi if one is already running for that cwd — opening a project is about
// *finding* it, not starting a new task. The user can still hit "+ New
// Session" inside the workspace window to fork a parallel agent.
export async function openProjectWorkspace({
  project,
  transport,
  fetchInstances,
  getCurrentPort,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  if (!transport) {
    renderError("Open project is only supported with a native host.");
    return false;
  }

  const targetCwd = resolveProjectCwd(project);
  if (!targetCwd) {
    renderError("Failed to open project: project path is unavailable");
    return false;
  }

  try {
    const result = await attachToWorkspace({
      targetCwd,
      transport,
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
  transport,
  fetchInstances,
  getCurrentPort,
  navigate,
  onBeforeSwap,
  renderError,
}) {
  if (!transport) {
    renderError("Open folder is only supported with a native host.");
    return false;
  }

  try {
    const selectedPath = await transport.pickFolder();
    if (!selectedPath) return false;

    const result = await attachToWorkspace({
      targetCwd: selectedPath,
      transport,
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
