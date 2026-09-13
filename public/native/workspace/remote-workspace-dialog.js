// ABOUTME: "Connect to a remote host" dialog — opens a workspace that lives on
// ABOUTME: another machine, with no local project folder needed up front.

import { applyTranslations, onLocaleChange, t } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";

/**
 * Why this exists at the *open a workspace* level rather than in Settings: a
 * remote project usually has no local counterpart, so requiring the user to
 * pick some throwaway local folder first — then flip a per-project setting —
 * inverts the actual mental model ("this project lives on that host"). The
 * anchor directory under ~/.picot/remotes is created by the Rust command
 * `open_remote_workspace` (see src-tauri/src/remote_workspace.rs).
 */

const MANUAL_HOST_VALUE = "";

function resolveInvoke() {
  return globalThis.__TAURI__?.core?.invoke ?? null;
}

/**
 * Saved hosts, connection tests and remote browsing all run inside pi (the
 * config channel), so they need a live session. The launcher window has none —
 * and that is exactly where a user with no local project starts — so the dialog
 * degrades to plain manual entry there instead of refusing to open. `Connect`
 * itself is a Tauri command and works either way.
 */
function configAvailable() {
  return typeof window.__picotConfigCall === "function";
}

async function callConfig(op, params = {}) {
  if (typeof window.__picotConfigCall !== "function") {
    throw new Error(t("remoteWorkspace.channelUnavailable"));
  }
  const result = await window.__picotConfigCall(op, params);
  if (!result?.ok) throw new Error(result?.error || `${op} failed`);
  return result.data || {};
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

function hostLabel(alias, entry) {
  const target = entry.user ? `${entry.user}@${entry.host}` : entry.host;
  return entry.port ? `${alias} · ${target}:${entry.port}` : `${alias} · ${target}`;
}

/**
 * Build the dialog DOM once. Markup lives here (not index.html) so the feature
 * owns its own template, per the module rules in AGENTS.md.
 */
function createDialogDom() {
  const overlay = document.createElement("div");
  overlay.className = "ui-overlay remote-workspace-overlay hidden";

  const dialog = document.createElement("div");
  dialog.className = "ui-dialog remote-workspace-dialog hidden";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.innerHTML = `
    <header class="remote-workspace-header">
      <strong data-i18n="remoteWorkspace.dialogTitle">Connect to a remote host</strong>
      <p class="remote-workspace-help" data-i18n="remoteWorkspace.dialogHelp">
        Picot opens the project where it lives. Read, write, edit and bash run on the remote host over SSH — no local copy is required.
      </p>
    </header>
    <div class="remote-workspace-body">
      <label class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.savedHost">Saved host</span>
        <select class="ui-select" data-field="savedHost"></select>
      </label>
      <div class="remote-workspace-grid" data-manual-fields>
        <label class="remote-workspace-field">
          <span class="remote-workspace-label" data-i18n="sshRemote.hostLabel">Host</span>
          <input class="ui-input" data-field="host" type="text" autocomplete="off" spellcheck="false"
            placeholder="192.168.1.50 or my-server.example.com" data-i18n-ph="sshRemote.hostPlaceholder" />
        </label>
        <label class="remote-workspace-field remote-workspace-field--sm">
          <span class="remote-workspace-label" data-i18n="sshRemote.portLabel">Port</span>
          <input class="ui-input" data-field="port" type="number" min="1" max="65535" autocomplete="off"
            placeholder="22" data-i18n-ph="sshRemote.portPlaceholder" />
        </label>
        <label class="remote-workspace-field remote-workspace-field--sm">
          <span class="remote-workspace-label" data-i18n="sshRemote.userLabel">Username</span>
          <input class="ui-input" data-field="user" type="text" autocomplete="off" spellcheck="false"
            placeholder="ubuntu" data-i18n-ph="sshRemote.userPlaceholder" />
        </label>
        <label class="remote-workspace-field">
          <span class="remote-workspace-label" data-i18n="sshRemote.identityFileLabel">Identity file</span>
          <input class="ui-input" data-field="identityFile" type="text" autocomplete="off" spellcheck="false"
            placeholder="~/.ssh/id_ed25519" data-i18n-ph="sshRemote.identityFilePlaceholder" />
        </label>
        <label class="remote-workspace-field">
          <span class="remote-workspace-label" data-i18n="remoteWorkspace.saveAs">Remember this host as</span>
          <input class="ui-input" data-field="alias" type="text" autocomplete="off" spellcheck="false"
            placeholder="gpu-box" data-i18n-ph="remoteWorkspace.saveAsPlaceholder" />
        </label>
      </div>
      <div class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.remotePath">Remote project path</span>
        <div class="remote-workspace-path-row">
          <input class="ui-input" data-field="remotePath" type="text" autocomplete="off" spellcheck="false"
            placeholder="/home/ubuntu/my-project" data-i18n-ph="remoteWorkspace.remotePathPlaceholder" />
          <button type="button" class="ui-button ui-button--secondary" data-action="browse"
            data-i18n="remoteWorkspace.browse">Browse…</button>
        </div>
      </div>
      <div class="remote-workspace-browser hidden" data-browser>
        <div class="remote-workspace-browser-path" data-browser-path></div>
        <ul class="remote-workspace-browser-list" data-browser-list></ul>
      </div>
      <p class="remote-workspace-status hidden" data-status aria-live="polite" role="status"></p>
    </div>
    <footer class="remote-workspace-actions">
      <button type="button" class="ui-button ui-button--ghost" data-action="test"
        data-i18n="sshRemote.testConnection">Test Connection</button>
      <span class="remote-workspace-spacer"></span>
      <button type="button" class="ui-button ui-button--secondary" data-action="cancel"
        data-i18n="remoteWorkspace.cancel">Cancel</button>
      <button type="button" class="ui-button ui-button--primary" data-action="connect"
        data-i18n="remoteWorkspace.connect">Connect</button>
    </footer>
  `;
  document.body.append(overlay, dialog);
  // The document-wide i18n pass ran at startup; this subtree is newer.
  applyTranslations(dialog);
  return { overlay, dialog };
}

/**
 * Wire the "connect to a remote host" entry point.
 *
 * @param {object} options
 * @param {HTMLElement|null} [options.buttonEl] trigger (hidden outside Tauri)
 * @param {(error: Error) => void} [options.onError]
 */
export function setupRemoteWorkspaceDialog({ buttonEl, onError } = {}) {
  const invoke = resolveInvoke();
  if (!buttonEl) return { open() {} };
  if (!invoke) {
    // Remote/browser clients cannot spawn native windows; hide the trigger
    // rather than leave a button that silently does nothing.
    buttonEl.classList.add("hidden");
    return { open() {} };
  }

  let dom = null;
  let unbindEscape = null;
  let savedHosts = {};
  let configHosts = [];
  let browserPath = "";

  function fields() {
    return {
      savedHost: dom.dialog.querySelector('[data-field="savedHost"]'),
      host: dom.dialog.querySelector('[data-field="host"]'),
      port: dom.dialog.querySelector('[data-field="port"]'),
      user: dom.dialog.querySelector('[data-field="user"]'),
      identityFile: dom.dialog.querySelector('[data-field="identityFile"]'),
      alias: dom.dialog.querySelector('[data-field="alias"]'),
      remotePath: dom.dialog.querySelector('[data-field="remotePath"]'),
    };
  }

  function setStatus(message, tone = "info") {
    const status = dom.dialog.querySelector("[data-status]");
    status.textContent = message || "";
    status.classList.toggle("hidden", !message);
    status.dataset.tone = tone;
  }

  /** The connection as the user has it right now, ready for a config op. */
  function readConnection() {
    const form = fields();
    const hostRef = form.savedHost.value;
    const port = form.port.value.trim();
    if (hostRef) {
      return { hostRef, remotePath: form.remotePath.value.trim() };
    }
    return {
      host: form.host.value.trim(),
      ...(port ? { port: Number(port) } : {}),
      user: form.user.value.trim(),
      identityFile: form.identityFile.value.trim(),
      remotePath: form.remotePath.value.trim(),
    };
  }

  function applyManualVisibility() {
    const usingSaved = Boolean(fields().savedHost.value);
    dom.dialog.querySelector("[data-manual-fields]").classList.toggle("hidden", usingSaved);
  }

  function renderSavedHostOptions() {
    const select = fields().savedHost;
    const previous = select.value;
    select.replaceChildren();
    const manual = document.createElement("option");
    manual.value = MANUAL_HOST_VALUE;
    manual.textContent = t("remoteWorkspace.enterManually");
    select.append(manual);
    for (const [alias, entry] of Object.entries(savedHosts)) {
      const option = document.createElement("option");
      option.value = alias;
      option.textContent = hostLabel(alias, entry);
      select.append(option);
    }
    if (configHosts.length > 0) {
      const group = document.createElement("optgroup");
      group.label = t("remoteWorkspace.fromSshConfig");
      for (const entry of configHosts) {
        if (savedHosts[entry.alias]) continue;
        const option = document.createElement("option");
        // Prefixed so it cannot collide with a saved alias; selecting it fills
        // the manual fields instead of binding to the registry.
        option.value = `ssh-config:${entry.alias}`;
        option.textContent = hostLabel(entry.alias, entry);
        group.append(option);
      }
      if (group.childElementCount > 0) select.append(group);
    }
    select.value = [...select.querySelectorAll("option")].some((o) => o.value === previous)
      ? previous
      : MANUAL_HOST_VALUE;
  }

  /** An `~/.ssh/config` pick is a suggestion: copy it into the manual fields. */
  function adoptSshConfigHost(alias) {
    const entry = configHosts.find((candidate) => candidate.alias === alias);
    const form = fields();
    form.savedHost.value = MANUAL_HOST_VALUE;
    if (entry) {
      form.host.value = entry.host || "";
      form.port.value = entry.port ?? "";
      form.user.value = entry.user || "";
      form.identityFile.value = entry.identityFile || "";
      form.alias.value = entry.alias;
    }
    applyManualVisibility();
  }

  async function loadHosts() {
    const needsSession = !configAvailable();
    for (const selector of ['[data-action="test"]', '[data-action="browse"]']) {
      dom.dialog.querySelector(selector).disabled = needsSession;
    }
    fields().savedHost.disabled = needsSession;
    if (needsSession) {
      savedHosts = {};
      configHosts = [];
      renderSavedHostOptions();
      applyManualVisibility();
      setStatus(t("remoteWorkspace.needsSession"), "info");
      return;
    }
    try {
      const data = await callConfig("get_ssh_hosts");
      savedHosts = data.hosts || {};
      configHosts = data.sshConfigHosts || [];
    } catch (error) {
      savedHosts = {};
      configHosts = [];
      setStatus(messageFromError(error), "error");
    }
    renderSavedHostOptions();
    applyManualVisibility();
  }

  async function browse(path) {
    const connection = readConnection();
    if (!connection.host && !connection.hostRef) {
      setStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    setStatus(t("remoteWorkspace.listing"), "info");
    try {
      const listing = await callConfig("list_ssh_remote_dir", { config: connection, path });
      browserPath = listing.path || "";
      renderBrowser(listing.directories || []);
      setStatus("");
    } catch (error) {
      setStatus(messageFromError(error), "error");
    }
  }

  function renderBrowser(directories) {
    const browser = dom.dialog.querySelector("[data-browser]");
    browser.classList.remove("hidden");
    dom.dialog.querySelector("[data-browser-path]").textContent = browserPath;
    const list = dom.dialog.querySelector("[data-browser-list]");
    list.replaceChildren();
    const addRow = (label, onClick) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "remote-workspace-browser-item";
      button.textContent = label;
      button.addEventListener("click", onClick);
      item.append(button);
      list.append(item);
    };
    if (browserPath && browserPath !== "/") {
      const parent = browserPath.slice(0, browserPath.lastIndexOf("/")) || "/";
      addRow(t("remoteWorkspace.parentDirectory"), () => void browse(parent));
    }
    for (const name of directories) {
      const child = browserPath.endsWith("/") ? `${browserPath}${name}` : `${browserPath}/${name}`;
      addRow(name, () => {
        fields().remotePath.value = child;
        void browse(child);
      });
    }
    fields().remotePath.value = browserPath;
  }

  async function test() {
    const connection = readConnection();
    if (!connection.host && !connection.hostRef) {
      setStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    setStatus(t("sshRemote.testing"), "info");
    try {
      const result = await callConfig("test_ssh_remote_config", { config: connection });
      setStatus(
        result.ok
          ? t("sshRemote.testOk", { path: result.remotePath || "" })
          : t("sshRemote.testFailed", { message: result.message || "" }),
        result.ok ? "success" : "error",
      );
    } catch (error) {
      setStatus(t("sshRemote.testFailed", { message: messageFromError(error) }), "error");
    }
  }

  async function connect() {
    const form = fields();
    const connection = readConnection();
    if (!connection.host && !connection.hostRef) {
      setStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    if (!connection.remotePath) {
      setStatus(t("remoteWorkspace.remotePathRequired"), "error");
      return;
    }
    const connectButton = dom.dialog.querySelector('[data-action="connect"]');
    connectButton.disabled = true;
    setStatus(t("remoteWorkspace.connecting"), "info");
    try {
      // Saving the host is what makes the next project on this machine a
      // two-field operation, so do it before opening the window.
      const alias = form.alias.value.trim();
      if (!connection.hostRef && alias) {
        await callConfig("set_ssh_host", { alias, config: connection });
        connection.hostRef = alias;
      }
      await invoke("open_remote_workspace", { connection });
      close();
    } catch (error) {
      setStatus(messageFromError(error), "error");
      onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      connectButton.disabled = false;
    }
  }

  function close() {
    dom?.overlay.classList.add("hidden");
    dom?.dialog.classList.add("hidden");
    unbindEscape?.();
    unbindEscape = null;
  }

  function ensureDom() {
    if (dom) return;
    dom = createDialogDom();
    dom.overlay.addEventListener("click", close);
    dom.dialog.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      if (action === "cancel") close();
      if (action === "test") void test();
      if (action === "connect") void connect();
      if (action === "browse") void browse(fields().remotePath.value.trim());
    });
    const select = fields().savedHost;
    select.addEventListener("change", () => {
      if (select.value.startsWith("ssh-config:")) {
        adoptSshConfigHost(select.value.slice("ssh-config:".length));
        return;
      }
      applyManualVisibility();
    });
    onLocaleChange(() => {
      applyTranslations(dom.dialog);
      renderSavedHostOptions();
    });
  }

  function open() {
    ensureDom();
    dom.overlay.classList.remove("hidden");
    dom.dialog.classList.remove("hidden");
    dom.dialog.querySelector("[data-browser]").classList.add("hidden");
    setStatus("");
    unbindEscape = bindDialogEscape(close, {
      isActive: () => !dom.dialog.classList.contains("hidden"),
    });
    void loadHosts().then(() => fields().host.focus());
  }

  buttonEl.addEventListener("click", open);
  return { open, close };
}
