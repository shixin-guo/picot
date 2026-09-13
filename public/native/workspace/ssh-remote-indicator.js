// ABOUTME: Header pill showing that this workspace's tools run on a remote host.
// ABOUTME: Visible state beats a buried setting — click opens its settings tab.

import { onLocaleChange, t } from "../../i18n.js";

/**
 * Where a remote workspace actually runs is not a preference to look up; it
 * changes what every bash call and file edit touches. So it is shown in the
 * header next to the workspace and branch pills, and hidden entirely for an
 * ordinary local workspace.
 *
 * The binding is per-project (`.pi/settings.json` → `sshRemote`), so this
 * re-probes on every workspace switch, exactly like the git-branch pill.
 */

const SETTINGS_ROUTE = "#/settings/ssh-remote";

// Only the newest probe may touch the DOM: switching workspaces twice in quick
// succession must not let the first answer repaint the pill.
let latestProbeSequence = 0;
let currentTarget = null;
let localeListenerRegistered = false;

function applyLabels(buttonEl, target) {
  buttonEl.title = t("remoteWorkspace.indicatorTitle", { target });
  buttonEl.setAttribute("aria-label", t("remoteWorkspace.indicatorTitle", { target }));
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
  try {
    const result = await call?.("get_ssh_remote_config");
    if (result?.ok) resolved = result.data?.resolved ?? result.data?.config ?? null;
  } catch {
    // A workspace whose runtime is not up yet (or a remote browser client with
    // no config channel) simply has no pill to show.
  }
  if (sequence !== latestProbeSequence) return;

  const target = resolved?.enabled ? formatRemoteTarget(resolved) : "";
  if (!target) {
    button.classList.add("hidden");
    currentTarget = null;
    return;
  }
  currentTarget = target;
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

/** Bind the pill's click once at startup; it opens Settings → Remote Workspace. */
export function setupSshRemoteIndicator({ buttonEl } = {}) {
  const button = buttonEl ?? document.getElementById("ssh-remote-indicator");
  if (!button) return;
  button.addEventListener("click", () => {
    // Hash routing is what the settings panel already listens on, so this works
    // without reaching into its internals.
    if (window.location.hash === SETTINGS_ROUTE) window.location.hash = "";
    window.location.hash = SETTINGS_ROUTE;
  });
}
