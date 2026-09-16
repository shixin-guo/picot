// ABOUTME: Detects an ssh-remote auth-failure notify and reopens the connect dialog on it.
// ABOUTME: Otherwise a workspace whose cached password died just fails silently until someone finds the header pill.

/**
 * Mirrors `SSH_AUTH_REQUIRED_MARKER` in extensions/ssh-remote.ts. There is no
 * module shared between the extension host and the webview, so this is kept
 * in sync by hand — both sides are small and rarely touched.
 *
 * Why a marker instead of matching the English text: `session_start` reports
 * "no password was given and no usable key was found" or "the password was
 * rejected by the host" as a plain `ctx.ui.notify(..., "error")`, and that
 * prose should stay free to change for humans without silently breaking the
 * one thing here that has to match on it exactly.
 */
export const SSH_AUTH_REQUIRED_MARKER = "[picot:ssh-auth-required]";

export function isSshAuthFailureMessage(message) {
  return typeof message === "string" && message.includes(SSH_AUTH_REQUIRED_MARKER);
}

/**
 * Build a `notify` handler that reopens the remote-workspace connect dialog
 * when a workspace's ssh-remote binding fails to authenticate — the case
 * this exists for is: the password Rust parked in memory for this project
 * (see src-tauri/src/remote_workspace.rs) is gone (an app restart), the SSH
 * ControlPersist master has expired, and no key is set up, so every remote
 * tool call now fails outright with no way for the user to notice short of
 * clicking the small host pill in the header themselves.
 *
 * Call the returned function with every `notify` request; it returns `true`
 * when it handled the notification (an ssh-remote auth failure) so the
 * caller can skip rendering the raw system message — the dialog's own status
 * banner explains the failure without the marker text leaking into chat.
 *
 * @param {object} options
 * @param {(op: string, params?: object) => Promise<{ok: boolean, data?: object}>} options.call
 *   config-gateway call, used to confirm the active project is still bound to
 *   a host (and to fetch that binding to prefill) before touching the UI —
 *   the marker alone only says auth failed, not what to reconnect to.
 * @param {{ open: (opts?: object) => void, isOpen?: () => boolean }} options.dialog
 *   normally the object `setupRemoteWorkspaceDialog` returns.
 * @param {() => string} [options.reauthMessage] returns the status banner
 *   text, evaluated lazily so it can go through i18n's `t()` at call time.
 * @param {number} [options.cooldownMs] minimum gap between auto-reopens, so a
 *   burst of failing tool calls from one dead connection cannot reopen the
 *   dialog out from under someone who is already retyping the password.
 */
export function createSshAuthFailureHandler({
  call,
  dialog,
  reauthMessage,
  cooldownMs = 4000,
} = {}) {
  let cooldownUntil = 0;

  return function handleNotify(request) {
    if (request?.notifyType !== "error") return false;
    if (!isSshAuthFailureMessage(request.message)) return false;
    if (dialog?.isOpen?.()) return true;
    const now = Date.now();
    if (now < cooldownUntil) return true;
    cooldownUntil = now + cooldownMs;
    void reopenOnCurrentBinding({ call, dialog, reauthMessage });
    return true;
  };
}

async function reopenOnCurrentBinding({ call, dialog, reauthMessage }) {
  try {
    const result = await call?.("get_ssh_remote_config");
    const binding = result?.data?.config ?? result?.data?.resolved;
    if (!result?.ok || !binding?.enabled) return;
    dialog?.open({ prefill: binding, statusMessage: reauthMessage?.() });
  } catch {
    // Best effort — if this project's binding can't even be read back, there
    // is nothing to prefill the dialog with beyond what the user can already
    // reach through the header pill.
  }
}
