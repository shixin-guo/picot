import { renderCostInfobar } from "./infobar.js";

const FILTER_STORAGE_KEY = "pi-studio-cost-filters";
const DEFAULT_RANGE = "30d";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderShell(target) {
  target.innerHTML = `
    <link rel="stylesheet" href="cost.css">
    <style>
      :host {
        display: block;
        min-height: 100%;
      }

      :host([embedded]) .cost-page-infobar {
        min-height: 100%;
        padding-bottom: 24px;
      }
    </style>
    <div class="cost-page cost-page-infobar">
      <section id="infobar-cost-section">
        <div class="infobar-topbar">
          <div class="infobar-topbar-actions">
            <div class="infobar-quick-range" role="group" aria-label="Quick range">
              <button type="button" class="infobar-range-chip" data-range-chip="7d">7d</button>
              <button type="button" class="infobar-range-chip is-active" data-range-chip="30d">30d</button>
              <button type="button" class="infobar-range-chip" data-range-chip="90d">90d</button>
            </div>
          </div>
        </div>

        <div class="infobar-panels">
          <div class="infobar-panel is-active" id="usage-overview">
            <div class="infobar-cost-block">
              <div class="infobar-subsection-head">
                <h3>Overview</h3>
              </div>
              <div class="infobar-overview-grid" id="infobar-overview-grid"></div>
              <div class="infobar-activity-wrap">
                <div id="infobar-activity-panel"></div>
              </div>
              <p class="infobar-overview-note" id="infobar-overview-note"></p>
            </div>
          </div>

          <div class="infobar-section-row">
            <div class="infobar-panel is-active" id="usage-models">
              <div class="infobar-cost-block">
                <div class="infobar-subsection-head">
                  <h3>Models</h3>
                </div>
                <div class="infobar-rank-list" id="infobar-models-list"></div>
              </div>
            </div>

            <div class="infobar-right-col">
              <div class="infobar-panel is-active" id="usage-tool-cost">
                <div class="infobar-cost-block">
                  <div class="infobar-subsection-head">
                    <h3>Tool Cost</h3>
                  </div>
                  <div id="infobar-tool-cost-panel"></div>
                </div>
              </div>

              <div class="infobar-panel is-active" id="usage-projects">
                <div class="infobar-cost-block">
                  <div class="infobar-subsection-head">
                    <h3>Projects</h3>
                  </div>
                  <div class="infobar-rank-list" id="infobar-projects-list"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="infobar-panel is-active" id="usage-sessions">
            <div class="infobar-cost-block">
              <div class="infobar-subsection-head">
                <h3>Sessions</h3>
                <span>Recent sessions in range</span>
              </div>
              <div id="infobar-sessions-panel"></div>
            </div>
          </div>
        </div>
      </section>
    </div>
  `;
}

function loadSavedRange() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_RANGE;
    const saved = JSON.parse(raw);
    return saved.range || DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

function saveFilters(range) {
  try {
    localStorage.setItem(
      FILTER_STORAGE_KEY,
      JSON.stringify({
        range,
        scope: "all",
      }),
    );
  } catch {}
}

function buildQuery(range) {
  const params = new URLSearchParams({
    range,
    granularity: "day",
    scope: "all",
  });
  return params.toString();
}

function renderLoadError(section, error) {
  const message = String(error?.message || error || "Failed to load usage data");
  const overviewEl = section.querySelector("#infobar-overview-grid");
  if (overviewEl) {
    overviewEl.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  }
}

export class CostDashboard extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this._currentRange = loadSavedRange();
    this._inFlight = null;
    this._loadVersion = 0;
    this._hasLoaded = false;

    this._root = this.attachShadow({ mode: "open" });
    renderShell(this._root);
    this._section = this._root.querySelector("#infobar-cost-section");
    this._rangeChips = Array.from(this._root.querySelectorAll("[data-range-chip]"));
    this._bindEvents();
    this._syncRangeChips();

    if (!this.hasAttribute("defer-load")) {
      this.ensureLoaded().catch((error) => {
        console.error("[Cost] Initial load failed:", error);
      });
    }
  }

  get currentRange() {
    return this._currentRange || DEFAULT_RANGE;
  }

  get loading() {
    return Boolean(this._inFlight);
  }

  ensureLoaded() {
    if (this._hasLoaded && !this._inFlight) {
      return Promise.resolve();
    }
    return this._inFlight || this.load();
  }

  async load() {
    if (!this._section) return;

    saveFilters(this.currentRange);
    const loadVersion = ++this._loadVersion;
    const query = buildQuery(this.currentRange);
    const request = fetch(`/api/cost-dashboard?${query}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((payload) => {
        if (loadVersion !== this._loadVersion) return;
        renderCostInfobar(this._section, payload);
        this._hasLoaded = true;
      })
      .catch((error) => {
        if (loadVersion === this._loadVersion) {
          renderLoadError(this._section, error);
        }
        throw error;
      });

    this._inFlight = request;
    try {
      await request;
    } finally {
      if (this._inFlight === request) this._inFlight = null;
    }
  }

  _bindEvents() {
    for (const chip of this._rangeChips) {
      chip.addEventListener("click", () => {
        const nextRange = chip.dataset.rangeChip;
        if (!nextRange || nextRange === this.currentRange) return;
        this._currentRange = nextRange;
        this._syncRangeChips();
        this._hasLoaded = false;
        this.load().catch((error) => {
          console.error("[Cost] Failed to load dashboard:", error);
        });
      });
    }
  }

  _syncRangeChips() {
    for (const chip of this._rangeChips) {
      const active = chip.dataset.rangeChip === this.currentRange;
      chip.classList.toggle("is-active", active);
      chip.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }
}

if (!customElements.get("cost-dashboard")) {
  customElements.define("cost-dashboard", CostDashboard);
}

export function createCostDashboard(target) {
  if (!target) return null;
  const element = document.createElement("cost-dashboard");
  target.replaceChildren(element);
  return element;
}
