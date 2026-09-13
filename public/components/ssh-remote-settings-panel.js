import { applyTranslations, onLocaleChange, t } from "../i18n.js";
import "./ssh-hosts-manager.js";

/**
 * <ssh-remote-settings-panel> Web Component — the "Remote Workspace" tab.
 *
 * Two clearly separated scopes, because conflating them is what made this
 * feature read as a global switch:
 *
 *  1. SSH hosts (global, `~/.pi/agent/settings.json` → `sshHosts`) — delegated
 *     to <ssh-hosts-manager>. A host belongs to this machine and is shared by
 *     every project.
 *  2. This project (`<cwd>/.pi/settings.json` → `sshRemote`) — which host THIS
 *     project runs on, shown as a one-line summary. The editor stays collapsed
 *     until asked for: a remote workspace is normally created from the
 *     sidebar's "Connect to a remote host" dialog, and re-pointing an existing
 *     one is the rare case.
 */

class SshRemoteSettingsPanel extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this._config = null;
    this._hosts = {};
    this.innerHTML = `
      <div class="settings-body">
        <div class="settings-section">
          <div class="settings-section-title" data-i18n="sshHosts.title">SSH hosts</div>
          <p class="settings-help" data-i18n="sshHosts.description">
            Hosts saved on this machine. Every project can bind to one of them, so a username and key path are entered once rather than once per project.
          </p>
          <ssh-hosts-manager></ssh-hosts-manager>
        </div>

        <div class="settings-section">
          <div class="settings-section-title" data-i18n="sshRemote.projectTitle">This project</div>
          <div class="ssh-remote-notice" data-scope-note>
            <span data-i18n="sshRemote.scopeNote">Applies to this project:</span>
            <code data-settings-path></code>
          </div>
          <div class="ssh-remote-notice hidden" data-untrusted-notice data-i18n="sshRemote.untrustedNotice">
            Trust this project to change where it runs.
          </div>
          <p class="ssh-remote-summary" data-binding-summary></p>
          <div class="ssh-remote-actions" data-project-actions>
            <button type="button" class="ui-button ui-button--secondary" data-action="edit"
              data-i18n="sshRemote.change">Change…</button>
            <button type="button" class="ui-button ui-button--ghost hidden" data-action="disable"
              data-i18n="sshRemote.switchToLocal">Run locally again</button>
          </div>
          <div class="ssh-remote-binding hidden" data-binding-form>
            <div class="ssh-remote-form">
              <label class="ssh-remote-field">
                <span class="settings-label-sub" data-i18n="sshRemote.savedHostLabel">Saved host</span>
                <select class="ui-select" data-field="hostRef"></select>
              </label>
              <label class="ssh-remote-field">
                <span class="settings-label-sub" data-i18n="sshRemote.hostLabel">Host</span>
                <input class="ui-input" data-field="host" type="text" autocomplete="off" spellcheck="false"
                  placeholder="192.168.1.50 or my-server.example.com" data-i18n-ph="sshRemote.hostPlaceholder" />
              </label>
              <label class="ssh-remote-field ssh-remote-field--sm">
                <span class="settings-label-sub" data-i18n="sshRemote.portLabel">Port</span>
                <input class="ui-input" data-field="port" type="number" min="1" max="65535" autocomplete="off"
                  placeholder="22" data-i18n-ph="sshRemote.portPlaceholder" />
              </label>
              <label class="ssh-remote-field ssh-remote-field--sm">
                <span class="settings-label-sub" data-i18n="sshRemote.userLabel">Username</span>
                <input class="ui-input" data-field="user" type="text" autocomplete="off" spellcheck="false"
                  placeholder="ubuntu" data-i18n-ph="sshRemote.userPlaceholder" />
              </label>
              <label class="ssh-remote-field">
                <span class="settings-label-sub" data-i18n="sshRemote.remotePathLabel">Remote path</span>
                <input class="ui-input" data-field="remotePath" type="text" autocomplete="off" spellcheck="false"
                  placeholder="Detected automatically if left blank" data-i18n-ph="sshRemote.remotePathPlaceholder" />
              </label>
              <label class="ssh-remote-field">
                <span class="settings-label-sub" data-i18n="sshRemote.identityFileLabel">Identity file</span>
                <input class="ui-input" data-field="identityFile" type="text" autocomplete="off" spellcheck="false"
                  placeholder="~/.ssh/id_ed25519" data-i18n-ph="sshRemote.identityFilePlaceholder" />
              </label>
            </div>
            <p class="settings-help" data-i18n="sshRemote.requirementsNote">
              Requires key-based SSH authentication (no password prompts) and bash on the remote host.
            </p>
            <div class="ssh-remote-actions">
              <button class="ui-button ui-button--primary" data-action="save" data-i18n="sshRemote.save">Save</button>
              <button class="ui-button ui-button--secondary" data-action="test" data-i18n="sshRemote.testConnection">Test Connection</button>
            </div>
          </div>
          <div class="settings-save-status hidden" data-status aria-live="polite" role="status"></div>
        </div>
      </div>
    `;

    this._untrustedNoticeEl = this.querySelector("[data-untrusted-notice]");
    this._statusEl = this.querySelector("[data-status]");
    this._settingsPathEl = this.querySelector("[data-settings-path]");
    this._summaryEl = this.querySelector("[data-binding-summary]");
    this._formEl = this.querySelector("[data-binding-form]");
    this._hostsManagerEl = this.querySelector("ssh-hosts-manager");
    // Scoped to the binding form: <ssh-hosts-manager> renders inputs with the
    // same data-field names, and it sits earlier in the DOM.
    const field = (name) => this._formEl.querySelector(`[data-field="${name}"]`);
    this._fields = {
      hostRef: field("hostRef"),
      host: field("host"),
      port: field("port"),
      user: field("user"),
      remotePath: field("remotePath"),
      identityFile: field("identityFile"),
    };

    this._fields.hostRef.addEventListener("change", () => this._applyHostRefState());

    this.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button || this._hostsManagerEl.contains(button)) return;
      if (button.dataset.action === "edit") this._openForm();
      if (button.dataset.action === "disable") this._disable();
      if (button.dataset.action === "save") this._save();
      if (button.dataset.action === "test") this._test();
    });

    // A host added or removed in the registry changes what this project can
    // bind to, so keep the alias list in step.
    this.addEventListener("ssh-hosts-changed", (event) => {
      this._hosts = event.detail?.hosts || {};
      this._renderHostOptions(this._hosts, this._config?.hostRef || "");
      this._renderSummary();
    });

    document.querySelectorAll(".settings-nav-item").forEach((button) => {
      if (button.dataset.settingsTab === "ssh-remote") {
        button.addEventListener("click", () => this._load());
      }
    });

    this._handleConfigGatewayReady = () => this._load();
    window.addEventListener("picot-config-gateway-ready", this._handleConfigGatewayReady);
    this._unsubscribeLocale = onLocaleChange(() => {
      applyTranslations(this);
      this._renderSummary();
      if (this._lastTestResult) this._renderTestResult(this._lastTestResult);
    });
    this._load();
  }

  disconnectedCallback() {
    if (this._handleConfigGatewayReady) {
      window.removeEventListener("picot-config-gateway-ready", this._handleConfigGatewayReady);
    }
    this._unsubscribeLocale?.();
  }

  /** One line answering "where does this project run?" — the whole point of the tab. */
  _renderSummary() {
    const config = this._config;
    const resolved = this._resolvedBinding();
    const remote = Boolean(config?.enabled && (resolved.host || config.hostRef));
    this._summaryEl.textContent = remote
      ? t("sshRemote.summaryRemote", { target: describeTarget(resolved, config) })
      : t("sshRemote.summaryLocal");
    this._action("disable").classList.toggle("hidden", !remote);
  }

  /** The binding with its referenced host applied, for display only. */
  _resolvedBinding() {
    const config = this._config || {};
    const entry = config.hostRef ? this._hosts[config.hostRef] : null;
    return {
      host: config.host || entry?.host || "",
      port: config.port ?? entry?.port,
      user: config.user || entry?.user || "",
      remotePath: config.remotePath || "",
    };
  }

  _openForm() {
    this._formEl.classList.remove("hidden");
    this._clearStatus();
  }

  _setFormDisabled(disabled) {
    for (const input of Object.values(this._fields)) input.disabled = disabled;
    for (const action of ["save", "test", "edit", "disable"]) {
      this._action(action).disabled = disabled;
    }
    if (!disabled) this._applyHostRefState();
  }

  /** Project-scoped action button (the hosts manager renders its own set). */
  _action(name) {
    return (
      this._formEl.querySelector(`[data-action="${name}"]`) ??
      this.querySelector(`[data-project-actions] [data-action="${name}"]`)
    );
  }

  /**
   * A saved host owns the connection fields, so they are hidden while one is
   * selected (the registry above, not this project, is where they are edited) —
   * the remote path stays editable because it is what differs per project.
   */
  _applyHostRefState() {
    const usingSaved = Boolean(this._fields.hostRef.value);
    for (const key of ["host", "port", "user", "identityFile"]) {
      const input = this._fields[key];
      input.closest(".ssh-remote-field")?.classList.toggle("hidden", usingSaved);
    }
  }

  _renderHostOptions(hosts, selected) {
    const select = this._fields.hostRef;
    select.replaceChildren();
    const inline = document.createElement("option");
    inline.value = "";
    inline.textContent = t("sshRemote.hostRefInline");
    select.append(inline);
    for (const [alias, entry] of Object.entries(hosts || {})) {
      const option = document.createElement("option");
      option.value = alias;
      const target = entry.user ? `${entry.user}@${entry.host}` : entry.host;
      option.textContent = `${alias} · ${target}`;
      select.append(option);
    }
    // A binding whose alias has since been deleted from the registry must stay
    // visible rather than silently reading as an inline host.
    if (selected && !hosts?.[selected]) {
      const missing = document.createElement("option");
      missing.value = selected;
      missing.textContent = t("sshRemote.hostRefMissing", { alias: selected });
      select.append(missing);
    }
    select.value = selected || "";
    this._applyHostRefState();
  }

  _fillForm(config, hosts) {
    this._renderHostOptions(hosts, config?.hostRef || "");
    this._fields.host.value = config?.host || "";
    this._fields.port.value = config?.port ?? "";
    this._fields.user.value = config?.user || "";
    this._fields.remotePath.value = config?.remotePath || "";
    this._fields.identityFile.value = config?.identityFile || "";
  }

  _readForm({ enabled = true } = {}) {
    const port = this._fields.port.value.trim();
    const hostRef = this._fields.hostRef.value;
    if (hostRef) {
      return { enabled, hostRef, remotePath: this._fields.remotePath.value.trim() };
    }
    return {
      enabled,
      host: this._fields.host.value.trim(),
      ...(port ? { port: Number(port) } : {}),
      user: this._fields.user.value.trim(),
      remotePath: this._fields.remotePath.value.trim(),
      identityFile: this._fields.identityFile.value.trim(),
    };
  }

  async _load() {
    this._clearStatus();
    try {
      const { config, hosts, trusted, path } = await callPicotConfig("get_ssh_remote_config");
      this._config = config || null;
      this._hosts = hosts || {};
      this._fillForm(config, this._hosts);
      this._renderSummary();
      if (this._settingsPathEl) this._settingsPathEl.textContent = path || "";
      this._untrustedNoticeEl.classList.toggle("hidden", Boolean(trusted));
      this._setFormDisabled(!trusted);
    } catch (e) {
      this._showError(messageFromError(e) || t("sshRemote.loadFailed"));
    }
  }

  async _save() {
    this._clearStatus();
    const config = this._readForm();
    if (!config.host && !config.hostRef) {
      this._showError(t("sshRemote.hostRequired"));
      return;
    }
    await this._persist(config, t("sshRemote.saved"));
  }

  /** Switch the project back to local execution, keeping the binding to flip back. */
  async _disable() {
    this._clearStatus();
    await this._persist(this._readForm({ enabled: false }), t("sshRemote.switchedToLocal"));
  }

  async _persist(config, successMessage) {
    const saveButton = this._action("save");
    saveButton.disabled = true;
    try {
      await callPicotConfig("set_ssh_remote_config", { config });
      this._config = config;
      this._renderSummary();
      this._showSuccess(successMessage);
    } catch (e) {
      this._showError(t("sshRemote.saveFailed", { message: messageFromError(e) }));
    } finally {
      saveButton.disabled = false;
    }
  }

  async _test() {
    this._clearStatus();
    const config = this._readForm();
    if (!config.host && !config.hostRef) {
      this._showError(t("sshRemote.hostRequired"));
      return;
    }
    const testButton = this._action("test");
    testButton.disabled = true;
    this._showInfo(t("sshRemote.testing"));
    try {
      const result = await callPicotConfig("test_ssh_remote_config", { config });
      this._lastTestResult = result;
      this._renderTestResult(result);
    } catch (e) {
      this._lastTestResult = { ok: false, message: messageFromError(e) };
      this._renderTestResult(this._lastTestResult);
    } finally {
      testButton.disabled = false;
    }
  }

  _renderTestResult(result) {
    if (result.ok) {
      this._showSuccess(t("sshRemote.testOk", { path: result.remotePath || "" }));
    } else {
      this._showError(t("sshRemote.testFailed", { message: result.message || "" }));
    }
  }

  _showError(message) {
    this._statusEl.textContent = message;
    this._statusEl.style.color = "";
    this._statusEl.classList.remove("hidden");
  }

  _showInfo(message) {
    this._statusEl.textContent = message;
    this._statusEl.style.color = "var(--text-secondary)";
    this._statusEl.classList.remove("hidden");
  }

  _showSuccess(message) {
    this._statusEl.textContent = message;
    this._statusEl.style.color = "var(--success)";
    this._statusEl.classList.remove("hidden");
  }

  _clearStatus() {
    this._statusEl.classList.add("hidden");
  }
}

/** `gpu-box · ubuntu@10.0.0.5:2222 /srv/app` — alias first when there is one. */
function describeTarget(resolved, config) {
  const host = resolved.user ? `${resolved.user}@${resolved.host}` : resolved.host;
  const withPort = resolved.port ? `${host}:${resolved.port}` : host;
  const named = config?.hostRef ? `${config.hostRef} · ${withPort}` : withPort;
  return resolved.remotePath ? `${named} ${resolved.remotePath}` : named;
}

async function callPicotConfig(op, params = {}) {
  if (typeof window.__picotConfigCall !== "function") {
    throw new Error("Configuration channel is unavailable");
  }
  const result = await window.__picotConfigCall(op, params);
  if (!result?.ok) throw new Error(result?.error || `${op} failed`);
  return result.data || {};
}

function messageFromError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

customElements.define("ssh-remote-settings-panel", SshRemoteSettingsPanel);
