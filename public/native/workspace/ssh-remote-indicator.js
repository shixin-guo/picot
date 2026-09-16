// ABOUTME: Header pill showing that this workspace's tools run on a remote host.
// ABOUTME: Visible state beats a buried setting — click reopens the connect dialog.

import { onLocaleChange, t } from "../../i18n.js";

/**
 * Where a remote workspace actually runs is not a preference to look up; it
 * changes what every bash call and file edit touches. So it is shown in the
 * header next to the workspace and branch pills, and hidden entirely for an
 * ordinary local workspace.
 *
 * The binding is per-project (`.pi/settings.json` → `sshRemote`), so this
 * re-probes on every workspace switch, exactly like the git-branch pill.
 *
 * Clicking it reopens the connect dialog on this binding: that dialog is the
 * only place remote workspaces are configured, so there is nowhere else to send
 * the user.
 */

// Only the newest probe may touch the DOM: switching workspaces twice in quick
// succession must not let the first answer repaint the pill.
let latestProbeSequence = 0;
let currentTarget = null;
let currentBinding = null;
let localeListenerRegistered = false;

function applyLabels(buttonEl, target) {
  buttonEl.title = t("remoteWorkspace.indicatorTitle", { target });
  buttonEl.setAttribute("aria-label", t("remoteWorkspace.indicatorTitle", { target }));
}

/**
 * Whether the active workspace is currently bound to (and enabled for) a
 * remote SSH host — reflects the same probe the header pill renders from, so
 * it can lag the workspace switch by one `refreshSshRemoteIndicator` round
 * trip. Used to gate features that only make sense against a local checkout,
 * like delegating to a local ACP subagent CLI via `#claude`.
 */
export function isSshRemoteActive() {
  return Boolean(currentTarget);
}

/** `user@host:/remote/path`, trimmed to what a header pill can carry. */
export function formatRemoteTarget(settings) {
  if (!settings?.host) return "";
  const host = settings.user ? `${settings.user}@${settings.host}` : settings.host;
  const withPort = settings.port ? `${host}:${settings.port}` : host;
  return settings.remotePath ? `${withPort} ${settings.remotePath}` : withPort;
}

/**
 * Probe the active workspace's remote binding and update the header pill.
 *
 * @param {object} options
 * @param {(op: string, params?: object) => Promise<{ok: boolean, data?: object}>} options.call
 *   config-gateway call, normally `window.__picotConfigCall`
 * @param {HTMLElement|null} [options.buttonEl]
 */
export async function refreshSshRemoteIndicator({ call, buttonEl } = {}) {
  const button = buttonEl ?? document.getElementById("ssh-remote-indicator");
  if (!button) return;
  const sequence = ++latestProbeSequence;

  let resolved = null;
  // The raw binding, not the resolved one: it is what the connect dialog wants
  // back (a `hostRef` must stay an alias, not be flattened into host fields).
  let binding = null;
  try {
    const result = await call?.("get_ssh_remote_config");
    if (result?.ok) {
      resolved = result.data?.resolved ?? result.data?.config ?? null;
      binding = result.data?.config ?? resolved;
    }
  } catch {
    // A workspace whose runtime is not up yet (or a remote browser client with
    // no config channel) simply has no pill to show.
  }
  if (sequence !== latestProbeSequence) return;

  const target = resolved?.enabled ? formatRemoteTarget(resolved) : "";
  if (!target) {
    button.classList.add("hidden");
    currentTarget = null;
    currentBinding = null;
    return;
  }
  currentTarget = target;
  currentBinding = binding;
  const label = button.querySelector("[data-ssh-remote-label]");
  if (label) label.textContent = target;
  applyLabels(button, target);
  button.classList.remove("hidden");

  if (!localeListenerRegistered) {
    localeListenerRegistered = true;
    onLocaleChange(() => {
      const element = document.getElementById("ssh-remote-indicator");
      if (element && currentTarget) applyLabels(element, currentTarget);
    });
  }
}

/**
 * Bind the pill's click once at startup.
 *
 * @param {object} options
 * @param {HTMLElement|null} [options.buttonEl]
 * @param {(binding: object|null) => void} [options.onEdit] normally the connect
 *   dialog's `open`, handed this workspace's current binding to prefill.
 */
export function setupSshRemoteIndicator({ buttonEl, onEdit } = {}) {
  const button = buttonEl ?? document.getElementById("ssh-remote-indicator");
  if (!button) return;
  button.addEventListener("click", () => onEdit?.(currentBinding));
}
