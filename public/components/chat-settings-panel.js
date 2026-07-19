/**
 * <chat-settings-panel> Web Component
 *
 * The "Agent Inbox" tab inside Settings. The normal Telegram setup flow only asks
 * for a bot token; Picot validates the bot, waits for the user's first DM, and
 * writes the full internal ~/.pi/agent/chat/config.json automatically.
 */

class ChatSettingsPanel extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this.innerHTML = `
      <div class="settings-body">
        <div class="settings-section">
          <div class="settings-section-title">Agent Inbox</div>
          <div class="settings-row" id="setting-super-agent">
            <span class="settings-label settings-label-stack">
              <span class="settings-label-main">Start automatically</span>
              <span class="settings-label-sub">Launch Agent Inbox when Picot opens</span>
            </span>
            <button class="settings-toggle" id="toggle-super-agent"></button>
          </div>
        </div>

        <div class="settings-section">
          <div class="settings-section-title">Telegram</div>
          <p class="settings-help">
            Paste a Telegram bot token from <code>@BotFather</code>. Picot will detect your
            Telegram DM automatically after you send <code>/start</code> to the bot.
          </p>
          <p class="settings-help telegram-safety-note">
            Telegram messages enter Agent Inbox first. Picot keeps project-agent dispatch
            behind local approval.
          </p>
          <div class="telegram-setup-card">
            <label class="telegram-token-label" for="telegram-bot-token">Bot token</label>
            <div class="telegram-token-row">
              <input id="telegram-bot-token" class="ui-input telegram-token-input"
                data-token-input type="password" autocomplete="off" spellcheck="false"
                placeholder="123456:ABCDEF…" />
              <button class="ui-button ui-button--primary" data-action="connect-telegram">Connect Telegram</button>
              <button class="ui-button ui-button--secondary" data-action="cancel-telegram" hidden>Cancel</button>
            </div>
            <div class="settings-save-status hidden" data-status aria-live="polite" role="status"></div>
            <div class="telegram-bind-instructions hidden" data-bind-instructions></div>
          </div>
          <div class="telegram-doctor-card" data-telegram-doctor>
            <div class="chat-account-header">
              <span class="chat-account-name">Telegram Doctor</span>
              <button class="ui-button ui-button--secondary" data-action="run-telegram-doctor">Run Doctor</button>
            </div>
            <div class="settings-help" data-telegram-doctor-summary>Not checked yet.</div>
            <div class="telegram-doctor-checks" data-telegram-doctor-checks></div>
          </div>
          <div class="chat-accounts-list" data-accounts-list></div>
        </div>

        <details class="settings-section chat-advanced-config" hidden>
          <summary class="settings-section-title">Advanced Raw Config</summary>
          <p class="settings-help">
            Internal config stored in <code>~/.pi/agent/chat/config.json</code>. You normally do not
            need to edit this manually.
          </p>
          <textarea class="ui-textarea config-editor-textarea settings-config-textarea"
            data-textarea spellcheck="false" autocomplete="off"
            autocorrect="off" autocapitalize="off" placeholder="Loading…"></textarea>
          <div class="settings-config-actions">
            <div class="settings-config-button-group">
              <button class="ui-button ui-button--primary" data-action="save">Save Raw Config</button>
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

    this._load();
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
      this._showError("Invalid JSON");
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
      if (!data.success) throw new Error(data.error || "Save failed");
      this._renderAccounts(content);
      this._showSuccess("Saved raw config.");
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
      this._showError("Paste your Telegram bot token first.");
      this._tokenInput.focus();
      return;
    }

    this._cancelTelegram();
    const controller = new AbortController();
    this._telegramSetupAbort = controller;
    this._setTelegramBusy(true);
    this._clearBindInstructions();

    try {
      this._showInfo("Validating Telegram bot token…");
      const validated = await postJson(
        "/api/chat-telegram/validate",
        { botToken },
        { signal: controller.signal },
      );
      const bot = validated.bot || {};
      this._renderBindInstructions(bot);
      this._showInfo("Bot connected. Send /start to the bot in Telegram to finish setup.");

      const bound = await postJson(
        "/api/chat-telegram/bind",
        { botToken, afterUpdateId: validated.afterUpdateId },
        { signal: controller.signal },
      );
      this._setRawContent(bound.content || "{}");
      this._renderAccounts(bound.content);
      this._tokenInput.value = "";
      this._showSuccess("Telegram connected. Only the detected DM user is authorized.");
      this._clearBindInstructions();
      await this._loadTelegramDoctor();
      window.dispatchEvent(new CustomEvent("picot-chat-config-updated"));
    } catch (e) {
      if (controller.signal.aborted) {
        this._showInfo("Telegram setup canceled.");
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
    if (!window.confirm("Disconnect Telegram from Picot?")) return;
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
      if (!data.success) throw new Error(data.error || "Disconnect failed");
      this._setRawContent(content);
      this._renderAccounts(content);
      this._showSuccess("Telegram disconnected.");
      await this._loadTelegramDoctor();
      window.dispatchEvent(new CustomEvent("picot-chat-config-updated"));
    } catch (e) {
      this._showError(messageFromError(e));
    }
  }

  async _loadTelegramDoctor() {
    const runBtn = this.querySelector('[data-action="run-telegram-doctor"]');
    runBtn.disabled = true;
    this._doctorSummaryEl.textContent = "Checking Telegram…";
    this._doctorChecksEl.innerHTML = "";
    try {
      const res = await fetch("/api/chat-telegram/doctor");
      const data = await res.json();
      if (!res.ok || data.success === false)
        throw new Error(data.error || "Telegram doctor failed");
      this._renderTelegramDoctor(data.report);
    } catch (e) {
      this._doctorSummaryEl.textContent = messageFromError(e);
      this._doctorChecksEl.innerHTML = "";
    } finally {
      runBtn.disabled = false;
    }
  }

  _renderTelegramDoctor(report) {
    const summary = report?.summary || "error";
    const label =
      summary === "ready" ? "Ready" : summary === "warning" ? "Needs attention" : "Not ready";
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
    try {
      const config = JSON.parse(rawContent || "{}");
      const accountEntry = Object.entries(config.accounts || {}).find(
        ([, account]) => account?.service === "telegram",
      );
      if (!accountEntry) {
        this._accountsEl.innerHTML = `<p class="settings-help">Telegram is not connected.</p>`;
        this._tokenInput.placeholder = "123456:ABCDEF...";
        this.querySelector('[data-action="connect-telegram"]').textContent = "Connect Telegram";
        return;
      }

      const [id, account] = accountEntry;
      const dm = Object.values(account.channels || {}).find((channel) => channel?.dm === true);
      const botName = account.botUsername ? `@${account.botUsername}` : account.name || id;
      const authorizedUser = dm?.name || dm?.access?.allowedUserIds?.[0] || dm?.id || "Detected DM";
      this._tokenInput.placeholder = "Paste a new token to reconnect";
      this.querySelector('[data-action="connect-telegram"]').textContent = "Reconnect Telegram";
      this._accountsEl.innerHTML = `
        <div class="chat-account-card">
          <div class="chat-account-header">
            <span class="chat-account-name">${esc(botName)}</span>
          </div>
          <div class="chat-account-detail">Authorized DM: ${esc(authorizedUser)}</div>
          <div class="chat-account-detail">Internal ID: <code>${esc(id)}</code></div>
          <div class="chat-account-actions">
            <button class="ui-button ui-button--danger" data-action="disconnect-telegram">Disconnect</button>
          </div>
        </div>
      `;
    } catch {
      this._accountsEl.innerHTML = "";
    }
  }

  _renderBindInstructions(bot) {
    const username = bot.username;
    const link = bot.webUrl || (username ? `https://web.telegram.org/k/#@${username}` : "");
    this._bindInstructionsEl.innerHTML = `
      <div class="telegram-bind-title">Waiting for your Telegram DM…</div>
      <ol class="telegram-bind-steps">
        <li>Open ${username ? `<code>@${esc(username)}</code>` : "the bot"} in Telegram.</li>
        <li>Send <code>/start</code> in the private chat.</li>
      </ol>
      ${
        link
          ? `<a class="ui-button ui-button--secondary telegram-open-link" href="${escAttr(link)}" target="_blank" rel="noreferrer">Open Telegram</a>`
          : ""
      }
    `;
    this._bindInstructionsEl.classList.remove("hidden");
  }

  _clearBindInstructions() {
    this._bindInstructionsEl.classList.add("hidden");
    this._bindInstructionsEl.innerHTML = "";
  }

  _setRawContent(content) {
    this._textarea.value = content || "{}";
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
  if (!res.ok || data.success === false) throw new Error(data.error || "Request failed");
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
