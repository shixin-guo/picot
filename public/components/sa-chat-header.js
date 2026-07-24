/**
 * <sa-chat-header> Web Component
 *
 * Chat header shown when Super Agent workspace is active.
 * Mirrors the layout of the regular .header (header-left / header-right)
 * so it looks visually consistent with the rest of the app.
 *
 * Buttons call window.__saOpenSettings().
 */

class SAChatHeader extends HTMLElement {
  connectedCallback() {
    this.classList.add("header", "super-agent-chat-header");
    this.innerHTML = `
      <div class="header-left">
        <button class="sidebar-toggle sa-sidebar-delegate" title="Toggle sidebar" aria-label="Toggle sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <button class="icon-btn lan-qr-btn hidden" data-action="lan-qr" title="Show mobile QR code" aria-label="Show mobile QR code">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
            <line x1="12" y1="18" x2="12.01" y2="18"/>
          </svg>
        </button>
        <div class="status">
          <span class="status-indicator connected" id="sa-status-indicator"></span>
          <span class="status-text" id="sa-status-text">Listening</span>
        </div>
      </div>
      <div class="header-right">
        <button class="pill sa-service-pill" data-action="telegram" disabled aria-disabled="true" title="Telegram is not configured">
          <span class="sa-service-dot sa-dot-telegram"></span>Telegram
        </button>
        <button class="icon-btn sa-runtime-toggle" data-action="runtime" title="Task board" aria-label="Toggle task board">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2"/>
            <path d="M9 4v16"/>
            <path d="M15 8h3"/>
            <path d="M15 12h3"/>
            <path d="M15 16h3"/>
          </svg>
        </button>
      </div>
    `;

    // Delegate sidebar toggle to the real button in .header (which has the listener)
    this.querySelector(".sa-sidebar-delegate").addEventListener("click", () => {
      document.getElementById("sidebar-toggle")?.click();
    });

    this.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.disabled) return;
      const action = btn.dataset.action;
      if (action === "lan-qr") document.getElementById("lan-qr-btn")?.click();
      if (action === "telegram") window.__saOpenSettings?.(action);
      if (action === "runtime") this._toggleRuntime(btn);
    });

    this._syncLanQrButton();
    this._handleChatConfigUpdated = () => this._loadServiceStatus();
    this._handleConfigGatewayReady = () => this._loadServiceStatus();
    window.addEventListener("picot-chat-config-updated", this._handleChatConfigUpdated);
    window.addEventListener("picot-config-gateway-ready", this._handleConfigGatewayReady);
    this._loadServiceStatus();
  }

  disconnectedCallback() {
    this._lanQrObserver?.disconnect();
    if (this._handleChatConfigUpdated) {
      window.removeEventListener("picot-chat-config-updated", this._handleChatConfigUpdated);
    }
    if (this._handleConfigGatewayReady) {
      window.removeEventListener("picot-config-gateway-ready", this._handleConfigGatewayReady);
    }
  }

  _syncLanQrButton() {
    const source = document.getElementById("lan-qr-btn");
    const target = this.querySelector('[data-action="lan-qr"]');
    if (!source || !target) return;

    const sync = () => target.classList.toggle("hidden", source.classList.contains("hidden"));
    sync();

    this._lanQrObserver?.disconnect();
    this._lanQrObserver = new MutationObserver(sync);
    this._lanQrObserver.observe(source, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  async _loadServiceStatus() {
    const generation = (this._serviceStatusLoadGeneration ?? 0) + 1;
    this._serviceStatusLoadGeneration = generation;
    const connectedServices = new Set();

    try {
      const data = await readChatConfig();
      const config = JSON.parse(data?.content || "{}");
      for (const account of Object.values(config.accounts || {})) {
        if (isConfiguredAccount(account)) connectedServices.add(account.service);
      }
    } catch {
      // Keep services disabled when config cannot be read.
    }

    if (generation !== this._serviceStatusLoadGeneration) return;
    this._setServiceConnected("telegram", connectedServices.has("telegram"));
  }

  _setServiceConnected(service, connected) {
    const button = this.querySelector(`[data-action="${service}"]`);
    if (!button) return;

    button.disabled = !connected;
    button.setAttribute("aria-disabled", connected ? "false" : "true");
    button.classList.toggle("connected", connected);
    button.title = connected
      ? `${capitalize(service)} settings`
      : `${capitalize(service)} is not configured`;
  }

  _toggleRuntime(btn) {
    const runtime = document.querySelector("super-agent-runtime");
    if (!runtime) return;
    const collapsed = runtime.classList.toggle("collapsed");
    btn.classList.toggle("active", !collapsed);
    localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
  }
}

function isConfiguredAccount(account) {
  if (!account || typeof account !== "object") return false;
  if (account.service === "telegram") return Boolean(account.botToken);
  return false;
}

async function readChatConfig() {
  if (typeof window.__picotConfigCall === "function") {
    const result = await window.__picotConfigCall("read_chat_config");
    if (!result?.ok) throw new Error(result?.error || "Failed to load chat config");
    return result.data || {};
  }
  const res = await fetch("/api/chat-config");
  if (!res.ok) throw new Error("Failed to load chat config");
  return res.json();
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

customElements.define("sa-chat-header", SAChatHeader);
