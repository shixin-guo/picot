/**
 * <sa-chat-header> Web Component
 *
 * Chat header shown when Super Agent workspace is active.
 * Mirrors the layout of the regular .header (header-left / header-right)
 * so it looks visually consistent with the rest of the app.
 *
 * Buttons call window.__saOpenSettings().
 */

import { onLocaleChange, t } from "../i18n/index.js";

class SAChatHeader extends HTMLElement {
  connectedCallback() {
    this.classList.add("header", "super-agent-chat-header");
    this._renderShell();

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
    window.addEventListener("picot-chat-config-updated", this._handleChatConfigUpdated);
    this._unsubLocale = onLocaleChange(() => {
      this._renderShell();
      this._syncLanQrButton();
      this._loadServiceStatus();
    });
    this._loadServiceStatus();
  }

  disconnectedCallback() {
    this._lanQrObserver?.disconnect();
    this._unsubLocale?.();
    if (this._handleChatConfigUpdated) {
      window.removeEventListener("picot-chat-config-updated", this._handleChatConfigUpdated);
    }
  }

  _renderShell() {
    this.innerHTML = `
      <div class="header-left">
        <button class="sidebar-toggle sa-sidebar-delegate" title="${t("chrome.toggleSidebar")}" aria-label="${t("chrome.toggleSidebar")}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="21" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <button class="icon-btn lan-qr-btn hidden" data-action="lan-qr" title="${t("chrome.showMobileQr")}" aria-label="${t("chrome.showMobileQr")}">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2"/>
            <line x1="12" y1="18" x2="12.01" y2="18"/>
          </svg>
        </button>
        <div class="status">
          <span class="status-indicator connected" id="sa-status-indicator"></span>
          <span class="status-text" id="sa-status-text">${t("superAgent.listening")}</span>
        </div>
      </div>
      <div class="header-right">
        <button class="pill sa-service-pill" data-action="telegram" disabled aria-disabled="true" title="${t("superAgent.serviceNotConfigured", { service: t("chat.telegram") })}">
          <span class="sa-service-dot sa-dot-telegram"></span>${t("chat.telegram")}
        </button>
        <button class="icon-btn sa-runtime-toggle" data-action="runtime" title="${t("superAgent.taskBoard")}" aria-label="${t("superAgent.toggleTaskBoard")}">
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

    // Re-bind sidebar toggle after re-render
    this.querySelector(".sa-sidebar-delegate")?.addEventListener("click", () => {
      document.getElementById("sidebar-toggle")?.click();
    });
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
    const connectedServices = new Set();

    try {
      const res = await fetch("/api/chat-config");
      if (res.ok) {
        const data = await res.json();
        const config = JSON.parse(data?.content || "{}");
        for (const account of Object.values(config.accounts || {})) {
          if (isConfiguredAccount(account)) connectedServices.add(account.service);
        }
      }
    } catch {
      // Keep services disabled when config cannot be read.
    }

    this._setServiceConnected("telegram", connectedServices.has("telegram"));
  }

  _setServiceConnected(service, connected) {
    const button = this.querySelector(`[data-action="${service}"]`);
    if (!button) return;

    const serviceLabel = service === "telegram" ? t("chat.telegram") : capitalize(service);
    button.disabled = !connected;
    button.setAttribute("aria-disabled", connected ? "false" : "true");
    button.classList.toggle("connected", connected);
    button.title = connected
      ? t("superAgent.serviceSettings", { service: serviceLabel })
      : t("superAgent.serviceNotConfigured", { service: serviceLabel });
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

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

customElements.define("sa-chat-header", SAChatHeader);
