/**
 * Workspace actions — bridge UI controls to native Tauri commands that manage
 * workspace windows. Currently wires the "Open folder as workspace" button to
 * the native folder picker, which spawns a dedicated window + pi runtime for
 * the chosen directory.
 */

/**
 * Resolve the Tauri `invoke` function exposed via `withGlobalTauri`.
 * Returns null when running outside the native Tauri shell (e.g. a remote
 * browser client), so callers can degrade gracefully.
 */
function resolveInvoke() {
  return globalThis.__TAURI__?.core?.invoke ?? null;
}

/**
 * Create a new session via the host HTTP API (used by LAN/remote clients that
 * cannot invoke Tauri native commands). Spawns a fresh temporary runtime on
 * the server and navigates the current page to the new session URL.
 *
 * @param {string} workspaceId
 * @returns {Promise<void>}
 */
export async function createSessionViaHost(workspaceId) {
  const response = await fetch("/v2/new-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error ?? `Server error ${response.status}`);
  }
  const target = await response.json();
  const { workspaceId: wid, sessionId: sid, instanceId: iid } = target;
  if (!wid || !sid) throw new Error("Server returned an invalid session target");
  // SPA navigation: emit an event so app.js can adoptTarget without reloading
  window.dispatchEvent(
    new CustomEvent("picot:session-created", {
      detail: { workspaceId: wid, sessionId: sid, instanceId: iid },
    }),
  );
}

/**
 * Spawn a fresh headless runtime for `workspaceId` via the host HTTP API and
 * return its runtime target WITHOUT navigating the page. Unlike
 * `createSessionViaHost`, this is used for background dispatch (Agent Inbox):
 * the caller keeps the returned target and drives it over `/v2/ws` while the
 * current window stays on its own session.
 *
 * @param {string} workspaceId
 * @returns {Promise<{workspaceId: string, sessionId: string, instanceId: string}>}
 */
export async function spawnSessionViaHost(workspaceId) {
  const response = await fetch("/v2/new-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error ?? `Server error ${response.status}`);
  }
  const target = await response.json();
  if (!target?.workspaceId || !target?.sessionId || !target?.instanceId) {
    throw new Error("Server returned an invalid session target");
  }
  return target;
}

/**
 * Resolve a project path to its stable workspace id via the host HTTP API
 * (`POST /v2/resolve-workspace`), registering the workspace on the server so
 * `/v2/bootstrap` can lazily resume its sessions. Used by LAN/remote clients
 * that cannot invoke Tauri native commands.
 *
 * @param {string} projectPath
 * @returns {Promise<string>} the resolved workspace id
 */
export async function resolveWorkspaceViaHost(projectPath) {
  const response = await fetch("/v2/resolve-workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectPath }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error ?? `Server error ${response.status}`);
  }
  const { workspaceId } = await response.json();
  if (!workspaceId) throw new Error("Server returned an invalid workspace id");
  return workspaceId;
}

/**
 * Open an existing session that belongs to a different project via the host
 * HTTP API. Resolves the target project's workspace id, then navigates the
 * current page to that session's route (the page re-bootstraps). Used by
 * LAN/mobile clients switching across projects without a Tauri window.
 *
 * @param {{ projectPath: string, id: string, workspaceId?: string }} session
 * @returns {Promise<void>}
 */
export async function openSessionInProjectViaHost(session) {
  const workspaceId = session.workspaceId || (await resolveWorkspaceViaHost(session.projectPath));
  // SPA navigation: emit an event so app.js can adoptTarget without reloading
  window.dispatchEvent(
    new CustomEvent("picot:session-created", {
      detail: { workspaceId, sessionId: session.id },
    }),
  );
}

/**
 * Wire the "+ New Session" button to open a fresh session in the current
 * workspace. On native Tauri it calls `open_new_session_in_workspace`; on
 * LAN/remote clients it falls back to the host HTTP API (`POST /v2/new-session`).
 *
 * @param {object} options
 * @param {string} options.workspaceId
 * @param {(error: Error) => void} [options.onError]
 * @returns {boolean}
 */
export function setupNewSessionButton({ workspaceId, onError } = {}) {
  const button = document.getElementById("new-session-btn");
  if (!button) return false;

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      // SPA navigation: always use the HTTP API so the page never reloads.
      // The Tauri command `open_new_session_in_workspace` causes a full
      // window.navigate() which flickers the entire UI.
      await createSessionViaHost(workspaceId);
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      button.disabled = false;
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!isNewSessionShortcut(event)) return;
    event.preventDefault();
    if (!button.disabled) button.click();
  });
  return true;
}

function isNewSessionShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return false;
  if (isTypingTarget(event.target)) return false;
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "n") return false;
  return event.metaKey || event.ctrlKey;
}

function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  return target.closest('[contenteditable="true"]') !== null;
}

export function setupOpenFolderButton({ onError } = {}) {
  const button = document.getElementById("open-folder-btn");
  if (!button) return false;

  const invoke = resolveInvoke();
  if (!invoke) {
    // Remote/browser clients cannot open native windows; hide the control
    // rather than leave a button that silently does nothing.
    button.style.setProperty("display", "none");
    return false;
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await invoke("open_folder_as_workspace");
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      button.disabled = false;
    }
  });
  return true;
}
