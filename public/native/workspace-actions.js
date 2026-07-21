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
  const { workspaceId: wid, sessionId: sid } = target;
  if (!wid || !sid) throw new Error("Server returned an invalid session target");
  window.location.href = `/app/workspaces/${encodeURIComponent(wid)}/sessions/${encodeURIComponent(sid)}`;
}

/**
 * Wire the "+ New Session" button to open a fresh session in the current
 * workspace. On native Tauri it calls `open_new_session_in_workspace`; on
 * LAN/remote clients it falls back to the host HTTP API (`POST /v2/new-session`).
 *
 * @param {object} options
 * @param {import('./data-gateway.js').HostDataGateway} options.data
 * @param {string} options.workspaceId
 * @param {(error: Error) => void} [options.onError]
 * @returns {boolean}
 */
export function setupNewSessionButton({ data, workspaceId, onError } = {}) {
  const button = document.getElementById("new-session-btn");
  if (!button) return false;

  const invoke = resolveInvoke();

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      if (invoke) {
        const response = await data.workspaceInfo(workspaceId);
        const path = response?.info?.path;
        if (!path) throw new Error("Workspace path is unavailable");
        await invoke("open_new_session_in_workspace", { projectPath: path });
      } else {
        await createSessionViaHost(workspaceId);
      }
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
