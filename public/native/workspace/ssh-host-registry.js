// ABOUTME: Config-channel calls for saved SSH hosts, connection tests and
// ABOUTME: remote directory listings — the data side of the connect dialog.

import { t } from "../../i18n.js";

/**
 * Every one of these runs inside pi (the config channel), so they need a live
 * session. The launcher window has none — and that is exactly where a user with
 * no local project starts — so callers check {@link configAvailable} first and
 * degrade to plain manual entry rather than showing broken controls.
 *
 * Passwords are passed per call instead of being stashed in the session: the
 * dialog may be testing some *other* host than the one this workspace runs on,
 * and a session-wide password would leak across the two.
 */
export function configAvailable() {
  return typeof window.__picotConfigCall === "function";
}

export async function callConfig(op, params = {}) {
  if (!configAvailable()) throw new Error(t("remoteWorkspace.channelUnavailable"));
  const result = await window.__picotConfigCall(op, params);
  if (!result?.ok) throw new Error(result?.error || `${op} failed`);
  return result.data || {};
}

/** `{ hosts, sshConfigHosts }` — the saved registry plus `~/.ssh/config` suggestions. */
export async function listSshHosts() {
  const data = await callConfig("get_ssh_hosts");
  return { hosts: data.hosts || {}, sshConfigHosts: data.sshConfigHosts || [] };
}

/** Create or update a saved host. Returns the registry as it now stands. */
export async function saveSshHost(alias, config) {
  const data = await callConfig("set_ssh_host", { alias, config });
  return data.hosts || {};
}

export async function deleteSshHost(alias) {
  const data = await callConfig("delete_ssh_host", { alias });
  return data.hosts || {};
}

export function testSshConnection(config, password) {
  return callConfig("test_ssh_remote_config", { config, password });
}

export function listRemoteDirectories(config, path, password) {
  return callConfig("list_ssh_remote_dir", { config, path, password });
}

export function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}
