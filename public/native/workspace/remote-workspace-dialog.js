// ABOUTME: "Connect to a remote host" dialog — opens a workspace that lives on
// ABOUTME: another machine, with no local project folder needed up front.

import { applyTranslations, onLocaleChange, t } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import {
  configAvailable,
  deleteSshHost,
  listRemoteDirectories,
  listSshHosts,
  messageFromError,
  saveSshHost,
  testSshConnection,
} from "./ssh-host-registry.js";

/**
 * Why this is the only place remote workspaces are configured, rather than a
 * Settings tab: a remote project usually has no local counterpart, so requiring
 * the user to pick some throwaway local folder first — then flip a per-project
 * setting — inverts the actual mental model ("this project lives on that
 * host"). So everything lives here: saved hosts (add, edit, delete), the
 * password, the remote path browser, and Connect. The anchor directory under
 * ~/.picot/remotes is created by the Rust command `open_remote_workspace` (see
 * src-tauri/src/remote_workspace.rs).
 *
 * The password is never persisted anywhere. It is handed to the Rust command,
 * which parks it in memory for the window that is about to open (see
 * `remote-workspace-password.js`), and it is passed per call to the test and
 * browse ops so a probe of some other host cannot leak into this session.
 */

const MANUAL_HOST_VALUE = "";
const SSH_CONFIG_PREFIX = "ssh-config:";

function resolveInvoke() {
  return globalThis.__TAURI__?.core?.invoke ?? null;
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
      <div class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.savedHost">Saved host</span>
        <div class="remote-workspace-host-row">
          <select class="ui-select" data-field="savedHost"></select>
          <button type="button" class="ui-button ui-button--sm ui-button--ghost hidden" data-action="edit-host"
            data-i18n="sshHosts.edit">Edit</button>
          <button type="button" class="ui-button ui-button--sm ui-button--ghost hidden" data-action="delete-host"
            data-i18n="sshHosts.delete">Delete</button>
        </div>
      </div>
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
      <label class="remote-workspace-field">
        <span class="remote-workspace-label" data-i18n="remoteWorkspace.password">Password</span>
        <input class="ui-input" data-field="password" type="password" autocomplete="new-password" />
        <span class="remote-workspace-help" data-i18n="remoteWorkspace.passwordHelp">
          Only needed when the host has no key set up. Kept in memory for this connection and never saved to disk.
        </span>
      </label>
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
      <button type="button" class="ui-button ui-button--ghost" data-action="save-host"
        data-i18n="sshHosts.save">Save host</button>
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
  if (!buttonEl) return { open() {}, isOpen: () => false };
  if (!invoke) {
    // Remote/browser clients cannot spawn native windows; hide the trigger
    // rather than leave a button that silently does nothing.
    buttonEl.classList.add("hidden");
    return { open() {}, isOpen: () => false };
  }

  let dom = null;
  let unbindEscape = null;
  let savedHosts = {};
  let configHosts = [];
  let browserPath = "";
  // Alias whose Delete is armed; a second click confirms. Avoids a blocking
  // window.confirm() while still refusing to delete on one stray tap.
  let pendingDelete = "";
  // Alias being edited in the manual fields. Renaming would orphan every
  // project bound to the old alias, so the name is fixed once a host exists.
  let editingAlias = "";
  // The entry the manual fields were last filled from. When it carries a
  // `configAlias` and the user has not touched the connection fields since,
  // the connection is still exactly that `~/.ssh/config` block and we let ssh
  // resolve it by name — see `adoptedConfigAlias`.
  let filledFrom = null;

  function fields() {
    return {
      savedHost: dom.dialog.querySelector('[data-field="savedHost"]'),
      host: dom.dialog.querySelector('[data-field="host"]'),
      port: dom.dialog.querySelector('[data-field="port"]'),
      user: dom.dialog.querySelector('[data-field="user"]'),
      identityFile: dom.dialog.querySelector('[data-field="identityFile"]'),
      alias: dom.dialog.querySelector('[data-field="alias"]'),
      password: dom.dialog.querySelector('[data-field="password"]'),
      remotePath: dom.dialog.querySelector('[data-field="remotePath"]'),
    };
  }

  function action(name) {
    return dom.dialog.querySelector(`[data-action="${name}"]`);
  }

  function setStatus(message, tone = "info") {
    const status = dom.dialog.querySelector("[data-status]");
    status.textContent = message || "";
    status.classList.toggle("hidden", !message);
    status.dataset.tone = tone;
  }

  /**
   * The `~/.ssh/config` alias the manual fields still describe verbatim, or ""
   * once the user has edited any of them. Compared on read rather than tracked
   * with input listeners so there is no way for the two to drift apart.
   */
  function adoptedConfigAlias() {
    const alias = filledFrom?.configAlias;
    if (!alias) return "";
    const form = fields();
    const untouched =
      form.host.value.trim() === (filledFrom.host || "") &&
      form.port.value.trim() === String(filledFrom.port ?? "") &&
      form.user.value.trim() === (filledFrom.user || "") &&
      form.identityFile.value.trim() === (filledFrom.identityFile || "");
    return untouched ? alias : "";
  }

  /** The connection as the user has it right now, ready for a config op. */
  function readConnection() {
    const form = fields();
    const hostRef = form.savedHost.value;
    const port = form.port.value.trim();
    if (hostRef) {
      return { hostRef, remotePath: form.remotePath.value.trim() };
    }
    const configAlias = adoptedConfigAlias();
    return {
      host: form.host.value.trim(),
      ...(port ? { port: Number(port) } : {}),
      user: form.user.value.trim(),
      identityFile: form.identityFile.value.trim(),
      remotePath: form.remotePath.value.trim(),
      ...(configAlias ? { configAlias } : {}),
    };
  }

  function password() {
    return fields().password.value;
  }

  function applyManualVisibility() {
    const alias = fields().savedHost.value;
    const usingSaved = Boolean(alias);
    dom.dialog.querySelector("[data-manual-fields]").classList.toggle("hidden", usingSaved);
    // Edit and Delete act on a saved host; Save host writes the manual fields.
    action("edit-host").classList.toggle("hidden", !usingSaved);
    action("delete-host").classList.toggle("hidden", !usingSaved);
    action("save-host").classList.toggle("hidden", usingSaved || !configAvailable());
    if (!usingSaved) return;
    pendingDelete = pendingDelete === alias ? pendingDelete : "";
    renderDeleteButton();
  }

  function renderDeleteButton() {
    const button = action("delete-host");
    const armed = pendingDelete && pendingDelete === fields().savedHost.value;
    button.textContent = armed ? t("sshHosts.confirmDelete") : t("sshHosts.delete");
    button.classList.toggle("ui-button--danger", Boolean(armed));
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
        option.value = `${SSH_CONFIG_PREFIX}${entry.alias}`;
        option.textContent = hostLabel(entry.alias, entry);
        group.append(option);
      }
      if (group.childElementCount > 0) select.append(group);
    }
    select.value = [...select.querySelectorAll("option")].some((o) => o.value === previous)
      ? previous
      : MANUAL_HOST_VALUE;
  }

  /** Copy a host entry into the manual fields (shared by edit and ~/.ssh/config). */
  function fillManualFields(alias, entry) {
    const form = fields();
    filledFrom = entry || null;
    form.savedHost.value = MANUAL_HOST_VALUE;
    form.host.value = entry?.host || "";
    form.port.value = entry?.port ?? "";
    form.user.value = entry?.user || "";
    form.identityFile.value = entry?.identityFile || "";
    form.alias.value = alias || "";
    applyManualVisibility();
  }

  /** An `~/.ssh/config` pick is a suggestion: copy it in, but do not lock the name. */
  function adoptSshConfigHost(alias) {
    editingAlias = "";
    fields().alias.disabled = false;
    fillManualFields(
      alias,
      configHosts.find((candidate) => candidate.alias === alias),
    );
  }

  /** Edit a saved host in place. Its alias is fixed — see `editingAlias`. */
  function editSavedHost() {
    const alias = fields().savedHost.value;
    if (!alias) return;
    editingAlias = alias;
    fillManualFields(alias, savedHosts[alias]);
    fields().alias.disabled = true;
  }

  async function loadHosts() {
    const needsSession = !configAvailable();
    for (const name of ["test", "browse", "save-host"]) action(name).disabled = needsSession;
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
      ({ hosts: savedHosts, sshConfigHosts: configHosts } = await listSshHosts());
    } catch (error) {
      savedHosts = {};
      configHosts = [];
      setStatus(messageFromError(error), "error");
    }
    renderSavedHostOptions();
    applyManualVisibility();
  }

  /** Save (or update) the manual fields as a named host in the global registry. */
  async function saveHost() {
    const form = fields();
    const alias = editingAlias || form.alias.value.trim();
    if (!alias) {
      setStatus(t("sshHosts.aliasRequired"), "error");
      return;
    }
    const connection = readConnection();
    if (!connection.host) {
      setStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    try {
      savedHosts = await saveSshHost(alias, connection);
      editingAlias = "";
      form.alias.disabled = false;
      renderSavedHostOptions();
      form.savedHost.value = alias;
      applyManualVisibility();
      setStatus(t("sshHosts.saved"), "success");
    } catch (error) {
      setStatus(messageFromError(error), "error");
    }
  }

  async function removeHost() {
    const alias = fields().savedHost.value;
    if (!alias) return;
    if (pendingDelete !== alias) {
      pendingDelete = alias;
      renderDeleteButton();
      setStatus(t("sshHosts.deleteWarning", { alias }), "error");
      return;
    }
    pendingDelete = "";
    try {
      savedHosts = await deleteSshHost(alias);
      if (editingAlias === alias) {
        editingAlias = "";
        fields().alias.disabled = false;
      }
      renderSavedHostOptions();
      fields().savedHost.value = MANUAL_HOST_VALUE;
      applyManualVisibility();
      setStatus(t("sshHosts.deleted", { alias }), "success");
    } catch (error) {
      setStatus(messageFromError(error), "error");
    }
  }

  async function browse(path) {
    const connection = readConnection();
    if (!connection.host && !connection.hostRef) {
      setStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    setStatus(t("remoteWorkspace.listing"), "info");
    try {
      const listing = await listRemoteDirectories(connection, path, password());
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
      const result = await testSshConnection(connection, password());
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
    const connectButton = action("connect");
    connectButton.disabled = true;
    setStatus(t("remoteWorkspace.connecting"), "info");
    try {
      // Saving the host is what makes the next project on this machine a
      // two-field operation, so do it before opening the window.
      const alias = editingAlias || form.alias.value.trim();
      if (!connection.hostRef && alias && configAvailable()) {
        savedHosts = await saveSshHost(alias, connection);
        connection.hostRef = alias;
      }
      // The password rides along out-of-band: Rust parks it in memory for the
      // window that is about to open, and nothing writes it to disk.
      await invoke("open_remote_workspace", { connection, password: password() || null });
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
    // The password lives exactly as long as the dialog does.
    if (dom) fields().password.value = "";
    unbindEscape?.();
    unbindEscape = null;
  }

  function ensureDom() {
    if (dom) return;
    dom = createDialogDom();
    dom.overlay.addEventListener("click", close);
    dom.dialog.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      if (button.dataset.action !== "delete-host" && pendingDelete) {
        pendingDelete = "";
        renderDeleteButton();
      }
      switch (button.dataset.action) {
        case "cancel":
          close();
          break;
        case "test":
          void test();
          break;
        case "connect":
          void connect();
          break;
        case "browse":
          void browse(fields().remotePath.value.trim());
          break;
        case "save-host":
          void saveHost();
          break;
        case "edit-host":
          editSavedHost();
          break;
        case "delete-host":
          void removeHost();
          break;
        default:
          break;
      }
    });
    const select = fields().savedHost;
    select.addEventListener("change", () => {
      pendingDelete = "";
      if (select.value.startsWith(SSH_CONFIG_PREFIX)) {
        adoptSshConfigHost(select.value.slice(SSH_CONFIG_PREFIX.length));
        return;
      }
      // Leaving the manual fields drops any in-progress edit of a saved host.
      if (select.value) {
        editingAlias = "";
        fields().alias.disabled = false;
      }
      applyManualVisibility();
    });
    onLocaleChange(() => {
      applyTranslations(dom.dialog);
      renderSavedHostOptions();
      renderDeleteButton();
    });
  }

  /**
   * @param {object} [options]
   * @param {object} [options.prefill] an existing binding to open the dialog on
   *   (the header pill hands over the workspace's current one).
   * @param {string} [options.statusMessage] shown as an error banner once the
   *   dialog is ready, instead of the blank status — used when something
   *   (rather than the user) triggered the reopen, e.g. an auth failure.
   */
  function open({ prefill, statusMessage } = {}) {
    ensureDom();
    dom.overlay.classList.remove("hidden");
    dom.dialog.classList.remove("hidden");
    dom.dialog.querySelector("[data-browser]").classList.add("hidden");
    setStatus("");
    unbindEscape = bindDialogEscape(close, {
      isActive: () => !dom.dialog.classList.contains("hidden"),
    });
    void loadHosts().then(() => {
      if (prefill) applyPrefill(prefill);
      if (statusMessage) setStatus(statusMessage, "error");
      fields().host.focus();
    });
  }

  /** Open on an existing binding rather than an empty form. */
  function applyPrefill(prefill) {
    const form = fields();
    if (prefill.hostRef && savedHosts[prefill.hostRef]) {
      form.savedHost.value = prefill.hostRef;
    } else {
      fillManualFields("", prefill);
    }
    form.remotePath.value = prefill.remotePath || "";
    applyManualVisibility();
  }

  buttonEl.addEventListener("click", () => open());
  return { open, close, isOpen: () => Boolean(dom) && !dom.dialog.classList.contains("hidden") };
}
