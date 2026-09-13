import { onLocaleChange, t } from "../i18n.js";

/**
 * <ssh-hosts-manager> Web Component
 *
 * The global SSH host registry (`~/.pi/agent/settings.json` → `sshHosts`),
 * shared by every project on this machine. A host belongs to a machine, not to
 * a checkout, so this is the one genuinely global part of remote workspaces —
 * and the part that belongs in Settings. Which host a *project* runs on lives
 * with that project (see <ssh-remote-settings-panel>).
 *
 * Emits `ssh-hosts-changed` after any write so a project binding editor showing
 * these aliases can refresh.
 */

const FIELDS = ["alias", "host", "port", "user", "identityFile"];

class SshHostsManager extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this._hosts = {};
    // Alias whose delete button is armed; a second click confirms. Avoids a
    // blocking window.confirm() while still refusing to delete on one stray tap.
    this._pendingDelete = "";
    this._editing = null;

    this.innerHTML = `
      <ul class="ssh-hosts-list" data-list></ul>
      <p class="settings-help hidden" data-empty data-i18n="sshHosts.empty">
        No saved hosts yet. Add one here, or save it while connecting to a remote host.
      </p>
      <div class="ssh-hosts-editor hidden" data-editor>
        <div class="ssh-remote-form">
          <label class="ssh-remote-field ssh-remote-field--sm">
            <span class="settings-label-sub" data-i18n="sshHosts.alias">Name</span>
            <input class="ui-input" data-field="alias" type="text" autocomplete="off" spellcheck="false"
              placeholder="gpu-box" data-i18n-ph="sshHosts.aliasPlaceholder" />
          </label>
          <label class="ssh-remote-field ssh-remote-field--sm">
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
            <span class="settings-label-sub" data-i18n="sshRemote.identityFileLabel">Identity file</span>
            <input class="ui-input" data-field="identityFile" type="text" autocomplete="off" spellcheck="false"
              placeholder="~/.ssh/id_ed25519" data-i18n-ph="sshRemote.identityFilePlaceholder" />
          </label>
        </div>
        <div class="ssh-remote-actions">
          <button type="button" class="ui-button ui-button--primary" data-action="save-host"
            data-i18n="sshHosts.save">Save host</button>
          <button type="button" class="ui-button ui-button--secondary" data-action="test-host"
            data-i18n="sshRemote.testConnection">Test Connection</button>
          <button type="button" class="ui-button ui-button--ghost" data-action="cancel-host"
            data-i18n="sshHosts.cancel">Cancel</button>
        </div>
      </div>
      <div class="ssh-remote-actions">
        <button type="button" class="ui-button ui-button--secondary" data-action="add-host"
          data-i18n="sshHosts.add">Add host…</button>
      </div>
      <div class="settings-save-status hidden" data-hosts-status aria-live="polite" role="status"></div>
    `;

    this._listEl = this.querySelector("[data-list]");
    this._emptyEl = this.querySelector("[data-empty]");
    this._editorEl = this.querySelector("[data-editor]");
    this._statusEl = this.querySelector("[data-hosts-status]");
    this._fields = Object.fromEntries(
      FIELDS.map((name) => [name, this.querySelector(`[data-field="${name}"]`)]),
    );

    this.addEventListener("click", (event) => {
      const button = event.target.closest("[data-action]");
      if (!button) return;
      const { action, alias } = button.dataset;
      if (action !== "delete-host") this._pendingDelete = "";
      if (action === "add-host") this._openEditor(null);
      if (action === "edit-host") this._openEditor(alias);
      if (action === "cancel-host") this._closeEditor();
      if (action === "save-host") void this._saveHost();
      if (action === "test-host") void this._testHost();
      if (action === "delete-host") void this._deleteHost(alias);
      if (action !== "delete-host") this._renderList();
    });

    this._unsubscribeLocale = onLocaleChange(() => this._renderList());
    void this.load();
  }

  disconnectedCallback() {
    this._unsubscribeLocale?.();
  }

  async load() {
    try {
      const { hosts } = await callPicotConfig("get_ssh_hosts");
      this._hosts = hosts || {};
      this._clearStatus();
    } catch (error) {
      this._hosts = {};
      this._showStatus(messageFromError(error), "error");
    }
    this._renderList();
  }

  _renderList() {
    this._listEl.replaceChildren();
    const aliases = Object.keys(this._hosts).sort((a, b) => a.localeCompare(b));
    this._emptyEl.classList.toggle("hidden", aliases.length > 0);
    for (const alias of aliases) {
      const entry = this._hosts[alias];
      const item = document.createElement("li");
      item.className = "ssh-hosts-row";

      const text = document.createElement("div");
      text.className = "ssh-hosts-row-text";
      const name = document.createElement("strong");
      name.textContent = alias;
      const detail = document.createElement("span");
      detail.className = "ssh-hosts-row-detail";
      detail.textContent = describeHost(entry);
      text.append(name, detail);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "ui-button ui-button--sm ui-button--ghost";
      edit.dataset.action = "edit-host";
      edit.dataset.alias = alias;
      edit.textContent = t("sshHosts.edit");

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ui-button ui-button--sm ui-button--ghost";
      remove.dataset.action = "delete-host";
      remove.dataset.alias = alias;
      const armed = this._pendingDelete === alias;
      remove.textContent = armed ? t("sshHosts.confirmDelete") : t("sshHosts.delete");
      remove.classList.toggle("ui-button--danger", armed);

      item.append(text, edit, remove);
      this._listEl.append(item);
    }
  }

  _openEditor(alias) {
    this._editing = alias || null;
    const entry = alias ? this._hosts[alias] : null;
    this._fields.alias.value = alias || "";
    // Renaming would orphan every project bound to the old alias, so the name
    // is fixed once the host exists.
    this._fields.alias.disabled = Boolean(alias);
    this._fields.host.value = entry?.host || "";
    this._fields.port.value = entry?.port ?? "";
    this._fields.user.value = entry?.user || "";
    this._fields.identityFile.value = entry?.identityFile || "";
    this._editorEl.classList.remove("hidden");
    this._clearStatus();
  }

  _closeEditor() {
    this._editing = null;
    this._editorEl.classList.add("hidden");
  }

  _readEditor() {
    const port = this._fields.port.value.trim();
    return {
      alias: this._fields.alias.value.trim(),
      config: {
        host: this._fields.host.value.trim(),
        ...(port ? { port: Number(port) } : {}),
        user: this._fields.user.value.trim(),
        identityFile: this._fields.identityFile.value.trim(),
      },
    };
  }

  async _saveHost() {
    const { alias, config } = this._readEditor();
    if (!alias) {
      this._showStatus(t("sshHosts.aliasRequired"), "error");
      return;
    }
    if (!config.host) {
      this._showStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    try {
      const data = await callPicotConfig("set_ssh_host", { alias, config });
      this._hosts = data.hosts || this._hosts;
      this._closeEditor();
      this._showStatus(t("sshHosts.saved"), "success");
      this._announceChange();
    } catch (error) {
      this._showStatus(messageFromError(error), "error");
    }
    this._renderList();
  }

  async _testHost() {
    const { config } = this._readEditor();
    if (!config.host) {
      this._showStatus(t("sshRemote.hostRequired"), "error");
      return;
    }
    this._showStatus(t("sshRemote.testing"), "info");
    try {
      const result = await callPicotConfig("test_ssh_remote_config", { config });
      this._showStatus(
        result.ok
          ? t("sshRemote.testOk", { path: result.remotePath || "" })
          : t("sshRemote.testFailed", { message: result.message || "" }),
        result.ok ? "success" : "error",
      );
    } catch (error) {
      this._showStatus(t("sshRemote.testFailed", { message: messageFromError(error) }), "error");
    }
  }

  async _deleteHost(alias) {
    if (this._pendingDelete !== alias) {
      this._pendingDelete = alias;
      this._showStatus(t("sshHosts.deleteWarning", { alias }), "error");
      this._renderList();
      return;
    }
    this._pendingDelete = "";
    try {
      const data = await callPicotConfig("delete_ssh_host", { alias });
      this._hosts = data.hosts || {};
      if (this._editing === alias) this._closeEditor();
      this._showStatus(t("sshHosts.deleted", { alias }), "success");
      this._announceChange();
    } catch (error) {
      this._showStatus(messageFromError(error), "error");
    }
    this._renderList();
  }

  _announceChange() {
    this.dispatchEvent(
      new CustomEvent("ssh-hosts-changed", { bubbles: true, detail: { hosts: this._hosts } }),
    );
  }

  _showStatus(message, tone) {
    this._statusEl.textContent = message;
    this._statusEl.dataset.tone = tone;
    this._statusEl.classList.remove("hidden");
  }

  _clearStatus() {
    this._statusEl.classList.add("hidden");
  }
}

function describeHost(entry) {
  const target = entry?.user ? `${entry.user}@${entry.host}` : entry?.host || "";
  const withPort = entry?.port ? `${target}:${entry.port}` : target;
  return entry?.identityFile ? `${withPort} · ${entry.identityFile}` : withPort;
}

async function callPicotConfig(op, params = {}) {
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

customElements.define("ssh-hosts-manager", SshHostsManager);
