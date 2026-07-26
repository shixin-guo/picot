/**
 * <super-agent-entry> Web Component
 *
 * The sidebar entry for Super Agent.
 * Renders the icon, name, status line, and badge.
 * Compatibility wrapper only: navigation is owned by the pinned normal session
 * rendered by SessionSidebar.
 */

import { onLocaleChange, t } from "../i18n/index.js";

class SuperAgentEntry extends HTMLElement {
  connectedCallback() {
    this._renderShell();
    this._unsubLocale = onLocaleChange(() => this._renderShell());
    this.addEventListener("click", () => this._open());
  }

  disconnectedCallback() {
    this._unsubLocale?.();
  }

  _renderShell() {
    const badgeCount = this.querySelector("[data-badge]")?.textContent || "0";
    const badgeHidden = this.querySelector("[data-badge]")?.classList.contains("hidden") ?? true;
    this.innerHTML = `
      <div class="super-agent-entry-inner">
        <div class="super-agent-entry-icon">⚡</div>
        <div class="super-agent-entry-info">
          <div class="super-agent-entry-name">${t("superAgent.entryName")}</div>
          <div class="super-agent-entry-status">
            <span class="super-agent-status-dot"></span>
            <span class="super-agent-status-text">${t("superAgent.entryStatusIncoming")}</span>
          </div>
        </div>
        <div class="super-agent-entry-badge${badgeHidden ? " hidden" : ""}" data-badge>${badgeCount}</div>
      </div>
    `;
  }

  // Called by <super-agent-runtime> when pending/running count changes
  setBadge(count) {
    const el = this.querySelector("[data-badge]");
    if (!el) return;
    el.textContent = count;
    el.classList.toggle("hidden", count === 0);
  }

  async _open() {
    document.querySelector(".super-agent-pinned-group .session-item")?.click();
    document.dispatchEvent(new CustomEvent("sa-open-runtime", { detail: { filter: "pending" } }));
  }
}

customElements.define("super-agent-entry", SuperAgentEntry);
