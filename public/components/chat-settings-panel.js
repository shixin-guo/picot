/**
 * <chat-settings-panel> Web Component
 *
 * The "Agent Inbox" tab inside Settings. The normal Telegram setup flow only asks
 * for a bot token; Picot validates the bot, waits for the user's first DM, and
 * writes the full internal ~/.pi/agent/chat/config.json automatically.
 */

import { applyI18n, onLocaleChange, t } from "../i18n/index.js";

class ChatSettingsPanel extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this.innerHTML = `
      <div class="settings-body">
        <div class="settings-section">
          <div class="settings-section-title" data-i18n="chat.agentInbox">Agent Inbox</div>
          <div class="settings-row" id="setting-super-agent">
            <span class="settings-label settings-label-stack">
              <span class="settings-label-main" data-i18n="chat.startAutomatically">Start automatically</span>
              <span class="settings-label-sub" data-i18n="chat.startAutomaticallySub">Launch Agent Inbox when Picot opens</span>
            </span>
            <button class="settings-toggle" id="toggle-super-agent"></button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title" data-i18n="chat.telegram">Telegram</div>
          <p class="settings-help" data-i18n="chat.telegramHelp">
            Paste a Telegram bot token from <code>@BotFather</code>. Picot will detect your
            Telegram DM automatically after you send <code>/start</code> to the bot.
          </p>
          <p class="settings-help telegram-safety-note" data-i18n="chat.telegramSafety">
            Telegram messages enter Agent Inbox first. Picot keeps project-agent dispatch
            behind local approval.
          </p>
          <div class="telegram-setup-card">
            <label class="telegram-token-label" for="telegram-bot-token" data-i18n="chat.botToken">Bot token</label>
            <div class="telegram-token-row">
              <input id="telegram-bot-token" class="ui-input telegram-token-input"
                data-token-input type="password" autocomplete="off" spellcheck="false"
                placeholder="123456:ABCDEF…" data-i18n-placeholder="chat.botTokenPlaceholder" />
              <button class="ui-button ui-button--primary" data-action="connect-telegram" data-i18n="chat.connectTelegram">Connect Telegram</button>
              <button class="ui-button ui-button--secondary" data-action="cancel-telegram" data-i18n="chat.cancel" hidden>Cancel</button>
            </div>
            <div class="settings-save-status hidden" data-status aria-live="polite" role="status"></div>
            <div class="telegram-bind-instructions hidden" data-bind-instructions></div>
          </div>
          <div class="telegram-doctor-card" data-telegram-doctor>
            <div class="chat-account-header">
              <span class="chat-account-name" data-i18n="chat.telegramDoctor">Telegram Doctor</span>
              <button class="ui-button ui-button--secondary" data-action="run-telegram-doctor" data-i18n="chat.runDoctor">Run Doctor</button>
            </div>
            <div class="settings-help" data-telegram-doctor-summary data-i18n="chat.notCheckedYet">Not checked yet.</div>
            <div class="telegram-doctor-checks" data-telegram-doctor-checks></div>
          </div>
          <div class="chat-accounts-list" data-accounts-list></div>
        </div>

        <details class="settings-section chat-advanced-config" hidden>
          <summary class="settings-section-title" data-i18n="chat.advancedRawConfig">Advanced Raw Config</summary>
          <p class="settings-help" data-i18n="chat.advancedHelp">
            Internal config stored in <code>~/.pi/agent/chat/config.json</code>. You normally do not
            need to edit this manually.
          </p>
          <textarea class="ui-textarea config-editor-textarea settings-config-textarea"
            data-textarea spellcheck="false" autocomplete="off"
            autocorrect="off" autocapitalize="off" placeholder="Loading…" data-i18n-placeholder="chat.loading"></textarea>
          <div class="settings-config-actions">
            <div class="settings-config-button-group">
              <button class="ui-button ui-button--primary" data-action="save" data-i18n="chat.saveRawConfig">Save Raw Config</button>
            </div>
          </div>
        </details>
      </div>
    `;

    this._textarea = this.querySelector("[data-textarea]");
    this._statusEl = this.querySelector("[data-status]");
    this._accountsEl = this.querySelector("[data-accounts-list]");
    this._tokenInput = this.querySelector("[data-token-input]");
    this._bindInstructionsEl = this.querySelector("[data-bind-instructions]");
    this._doctorSummaryEl = this.querySelector("[data-telegram-doctor-summary]");
    this._doctorChecksEl = this.querySelector("[data-telegram-doctor-checks]");
    this._lastDoctorReport = null;
    this._lastRawContent = "{}";
    this._lastBindBot = null;

    this.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "save") this._save();
      if (action === "connect-telegram") this._connectTelegram();
      if (action === "cancel-telegram") this._cancelTelegram();
      if (action === "disconnect-telegram") this._disconnectTelegram();
      if (action === "run-telegram-doctor") this._loadTelegramDoctor();
    });

    this._tokenInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this._connectTelegram();
      }
    });

    document.querySelectorAll(".settings-nav-item").forEach((btn) => {
      if (btn.dataset.settingsTab === "chat") {
        btn.addEventListener("click", () => this._load());
      }
    });

    applyI18n(this);
    this._unsubLocale = onLocaleChange(() => this._refreshLocale());
    this._load();
  }

  disconnectedCallback() {
    if (this._unsubLocale) {
      this._unsubLocale();
      this._unsubLocale = null;
    }
  }

  _refreshLocale() {
    applyI18n(this);
    if (this._lastRawContent != null) this._renderAccounts(this._lastRawContent);
    if (this._lastDoctorReport) this._renderTelegramDoctor(this._lastDoctorReport);
    if (this._lastBindBot && !this._bindInstructionsEl.classList.contains("hidden")) {
      this._renderBindInstructions(this._lastBindBot);
    }
  }

  // ── API ───────────────────────────────────────────────────────────────────

  async _load() {
    try {
      const res = await fetch("/api/chat-config");
      if (!res.ok) return;
      const { content } = await res.json();
      this._setRawContent(content || "{}");
      this._renderAccounts(content);
      await this._loadTelegramDoctor();
    } catch {}
  }

  async _save() {
    const content = this._textarea.value;
    try {
      JSON.parse(content);
    } catch {
      this._showError(t("chat.invalidJson"));
      return;
    }
    this._clearStatus();
    const saveBtn = this.querySelector('[data-action="save"]');
    saveBtn.disabled = true;
    try {
      const res = await fetch("/api/chat-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t("chat.saveFailed"));
      this._renderAccounts(content);
      this._showSuccess(t("chat.savedRawConfig"));
      await this._loadTelegramDoctor();
    } catch (e) {
      this._showError(messageFromError(e));
    } finally {
      saveBtn.disabled = false;
    }
  }

  async _connectTelegram() {
    const botToken = this._tokenInput.value.trim();
    if (!botToken) {
      this._showError(t("chat.pasteTokenFirst"));
      this._tokenInput.focus();
      return;
    }

    this._cancelTelegram();
    const controller = new AbortController();
    this._telegramSetupAbort = controller;
    this._setTelegramBusy(true);
    this._clearBindInstructions();

    try {
      this._showInfo(t("chat.validatingToken"));
      const validated = await postJson(
        "/api/chat-telegram/validate",
        { botToken },
        { signal: controller.signal },
      );
      const bot = validated.bot || {};
      this._renderBindInstructions(bot);
      this._showInfo(t("chat.botConnected"));

      const bound = await postJson(
        "/api/chat-telegram/bind",
        { botToken, afterUpdateId: validated.afterUpdateId },
        { signal: controller.signal },
      );
      this._setRawContent(bound.content || "{}");
      this._renderAccounts(bound.content);
      this._tokenInput.value = "";
      this._showSuccess(t("chat.telegramConnected"));
      this._clearBindInstructions();
      await this._loadTelegramDoctor();
      window.dispatchEvent(new CustomEvent("picot-chat-config-updated"));
    } catch (e) {
      if (controller.signal.aborted) {
        this._showInfo(t("chat.setupCanceled"));
      } else {
        this._showError(messageFromError(e));
      }
    } finally {
      if (this._telegramSetupAbort === controller) this._telegramSetupAbort = null;
      this._setTelegramBusy(false);
    }
  }

  _cancelTelegram() {
    if (this._telegramSetupAbort) {
      this._telegramSetupAbort.abort();
      this._telegramSetupAbort = null;
    }
  }

  async _disconnectTelegram() {
    if (!window.confirm(t("chat.disconnectConfirm"))) return;
    try {
      const config = JSON.parse(this._textarea.value || "{}");
      const accounts = Object.entries(config.accounts || {}).filter(
        ([, account]) => account?.service !== "telegram",
      );
      config.accounts = Object.fromEntries(accounts);
      const content = `${JSON.stringify(config, null, "\t")}\n`;
      const res = await fetch("/api/chat-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || t("chat.disconnectFailed"));
      this._setRawContent(content);
      this._renderAccounts(content);
      this._showSuccess(t("chat.telegramDisconnected"));
      await this._loadTelegramDoctor();
      window.dispatchEvent(new CustomEvent("picot-chat-config-updated"));
    } catch (e) {
      this._showError(messageFromError(e));
    }
  }

  async _loadTelegramDoctor() {
    const runBtn = this.querySelector('[data-action="run-telegram-doctor"]');
    runBtn.disabled = true;
    this._doctorSummaryEl.textContent = t("chat.checkingTelegram");
    this._doctorChecksEl.innerHTML = "";
    try {
      const res = await fetch("/api/chat-telegram/doctor");
      const data = await res.json();
      if (!res.ok || data.success === false)
        throw new Error(data.error || t("chat.doctorFailed"));
      this._renderTelegramDoctor(data.report);
    } catch (e) {
      this._lastDoctorReport = null;
      this._doctorSummaryEl.textContent = messageFromError(e);
      this._doctorChecksEl.innerHTML = "";
    } finally {
      runBtn.disabled = false;
    }
  }

  _renderTelegramDoctor(report) {
    this._lastDoctorReport = report;
    const summary = report?.summary || "error";
    const label =
      summary === "ready"
        ? t("chat.doctorReady")
        : summary === "warning"
          ? t("chat.doctorWarning")
          : t("chat.doctorNotReady");
    this._doctorSummaryEl.textContent = label;
    this._doctorChecksEl.innerHTML = (report?.checks || [])
      .map(
        (check) => `
          <div class="telegram-doctor-check ${doctorStatusClass(check.status)}">
            <span class="telegram-doctor-label">${esc(check.label)}</span>
            <span class="telegram-doctor-message">${esc(check.message)}</span>
          </div>
        `,
      )
      .join("");
  }

  // ── Render accounts list ──────────────────────────────────────────────────

  _renderAccounts(rawContent) {
    this._lastRawContent = rawContent || "{}";
    try {
      const config = JSON.parse(rawContent || "{}");
      const accountEntry = Object.entries(config.accounts || {}).find(
        ([, account]) => account?.service === "telegram",
      );
      if (!accountEntry) {
        this._accountsEl.innerHTML = `<p class="settings-help">${esc(t("chat.notConnected"))}</p>`;
        this._tokenInput.placeholder = t("chat.botTokenPlaceholder");
        this.querySelector('[data-action="connect-telegram"]').textContent =
          t("chat.connectTelegram");
        return;
      }

      const [id, account] = accountEntry;
      const dm = Object.values(account.channels || {}).find((channel) => channel?.dm === true);
      const botName = account.botUsername ? `@${account.botUsername}` : account.name || id;
      const authorizedUser =
        dm?.name || dm?.access?.allowedUserIds?.[0] || dm?.id || t("chat.detectedDm");
      this._tokenInput.placeholder = t("chat.reconnectPlaceholder");
      this.querySelector('[data-action="connect-telegram"]').textContent =
        t("chat.reconnectTelegram");
      this._accountsEl.innerHTML = `
        <div class="chat-account-card">
          <div class="chat-account-header">
            <span class="chat-account-name">${esc(botName)}</span>
          </div>
          <div class="chat-account-detail">${esc(t("chat.authorizedDm", { user: authorizedUser }))}</div>
          <div class="chat-account-detail">${esc(t("chat.internalId"))} <code>${esc(id)}</code></div>
          <div class="chat-account-actions">
            <button class="ui-button ui-button--danger" data-action="disconnect-telegram">${esc(t("chat.disconnect"))}</button>
          </div>
        </div>
      `;
    } catch {
      this._accountsEl.innerHTML = "";
    }
  }

  _renderBindInstructions(bot) {
    this._lastBindBot = bot;
    const username = bot.username;
    const link = bot.webUrl || (username ? `https://web.telegram.org/k/#@${username}` : "");
    const step1 = username
      ? t("chat.bindStep1User", { username })
      : t("chat.bindStep1Bot");
    this._bindInstructionsEl.innerHTML = `
      <div class="telegram-bind-title">${esc(t("chat.waitingDm"))}</div>
      <ol class="telegram-bind-steps">
        <li>${esc(step1)}</li>
        <li>${esc(t("chat.bindStep2"))}</li>
      </ol>
      ${
        link
          ? `<a class="ui-button ui-button--secondary telegram-open-link" href="${escAttr(link)}" target="_blank" rel="noreferrer">${esc(t("chat.openTelegram"))}</a>`
          : ""
      }
    `;
    this._bindInstructionsEl.classList.remove("hidden");
  }

  _clearBindInstructions() {
    this._lastBindBot = null;
    this._bindInstructionsEl.classList.add("hidden");
    this._bindInstructionsEl.innerHTML = "";
  }

  _setRawContent(content) {
    this._textarea.value = content || "{}";
    this._lastRawContent = content || "{}";
  }

  _setTelegramBusy(isBusy) {
    this._tokenInput.disabled = isBusy;
    this.querySelector('[data-action="connect-telegram"]').disabled = isBusy;
    this.querySelector('[data-action="cancel-telegram"]').hidden = !isBusy;
  }

  // ── Status helpers ────────────────────────────────────────────────────────

  _showError(msg) {
    this._statusEl.textContent = msg;
    this._statusEl.style.color = "";
    this._statusEl.classList.remove("hidden");
  }

  _showInfo(msg) {
    this._statusEl.textContent = msg;
    this._statusEl.style.color = "var(--text-dim)";
    this._statusEl.classList.remove("hidden");
  }

  _showSuccess(msg) {
    this._statusEl.textContent = msg;
    this._statusEl.style.color = "var(--color-success, #4ade80)";
    this._statusEl.classList.remove("hidden");
  }

  _clearStatus() {
    this._statusEl.classList.add("hidden");
  }
}

async function postJson(url, payload, options = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.error || t("chat.requestFailed"));
  return data;
}

function messageFromError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escAttr(str) {
  return esc(str).replace(/'/g, "&#39;");
}

function doctorStatusClass(status) {
  if (status === "ok") return "ok";
  if (status === "warning") return "warning";
  return "error";
}

customElements.define("chat-settings-panel", ChatSettingsPanel);
