import { renderCostDashboard } from "./cost-dashboard-render.js";

const FILTER_STORAGE_KEY = "pi-studio-cost-filters";
const DEFAULT_RANGE = "30d";
const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderShell(container) {
  container.innerHTML = `
    <div class="cost-dash-page">
      <section id="cost-dash-section">
        <div class="cost-dash-topbar">
          <div class="cost-dash-topbar-actions">
            <div class="cost-dash-quick-range" role="group" aria-label="Quick range">
              <button type="button" class="cost-dash-range-chip" data-range-chip="7d">7d</button>
              <button type="button" class="cost-dash-range-chip" data-range-chip="30d">30d</button>
              <button type="button" class="cost-dash-range-chip" data-range-chip="90d">90d</button>
            </div>
          </div>
        </div>

        <div class="cost-dash-panels">
          <div class="cost-dash-panel is-active" id="usage-overview">
            <div class="cost-dash-cost-block">
              <div class="cost-dash-subsection-head">
                <h3>Overview</h3>
              </div>
              <div class="cost-dash-overview-grid" id="cost-dash-overview-grid"></div>
              <div class="cost-dash-activity-wrap">
                <div id="cost-dash-activity-panel"></div>
              </div>
              <p class="cost-dash-overview-note" id="cost-dash-overview-note"></p>
            </div>
          </div>

          <div class="cost-dash-section-row">
            <div class="cost-dash-panel is-active" id="usage-models">
              <div class="cost-dash-cost-block">
                <div class="cost-dash-subsection-head">
                  <h3>Models</h3>
                </div>
                <div class="cost-dash-rank-list" id="cost-dash-models-list"></div>
              </div>
            </div>

            <div class="cost-dash-right-col">
              <div class="cost-dash-panel is-active" id="usage-tool-cost">
                <div class="cost-dash-cost-block">
                  <div class="cost-dash-subsection-head">
                    <h3>Tool Cost</h3>
                  </div>
                  <div id="cost-dash-tool-cost-panel"></div>
                </div>
              </div>

              <div class="cost-dash-panel is-active" id="usage-projects">
                <div class="cost-dash-cost-block">
                  <div class="cost-dash-subsection-head">
                    <h3>Projects</h3>
                  </div>
                  <div class="cost-dash-rank-list" id="cost-dash-projects-list"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="cost-dash-panel is-active" id="usage-sessions">
            <div class="cost-dash-cost-block">
              <div class="cost-dash-subsection-head">
                <h3>Sessions</h3>
                <span>Recent sessions in range</span>
              </div>
              <div id="cost-dash-sessions-panel"></div>
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
    return RANGE_DAYS[saved.range] ? saved.range : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

function saveRange(range) {
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({ range, scope: "all" }));
  } catch {}
}

function syncRangeChips(container, range) {
  for (const chip of container.querySelectorAll("[data-range-chip]")) {
    const active = chip.dataset.rangeChip === range;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function renderLoadError(container, error) {
  container.innerHTML = `<p class="cost-dash-empty-state cost-dash-error">${escapeHtml(
    error?.message || String(error) || "Failed to load usage data",
  )}</p>`;
}

function rangeBounds(range, now = new Date()) {
  const days = RANGE_DAYS[range] ?? RANGE_DAYS[DEFAULT_RANGE];
  const to = new Date(now);
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - (days - 1));
  return { from, to };
}

function isInRange(session, bounds) {
  const time = new Date(session?.time);
  return Number.isFinite(time.getTime()) && time >= bounds.from && time <= bounds.to;
}

function number(value) {
  return Number(value) || 0;
}

function aggregateRows(rows, getName, update) {
  const byName = new Map();
  for (const row of rows) {
    const name = getName(row) || "unknown";
    const existing = byName.get(name) || { name, cost: 0, sessions: 0, totalTokens: 0 };
    update(existing, row);
    byName.set(name, existing);
  }
  return Array.from(byName.values()).sort((left, right) => right.cost - left.cost);
}

function adaptDashboardToInfobarPayload(dashboard, range) {
  const allSessions = Array.isArray(dashboard?.sessions)
    ? dashboard.sessions
    : Array.isArray(dashboard?.topSessions)
      ? dashboard.topSessions
      : [];
  const bounds = rangeBounds(range);
  const sessions = allSessions.filter((session) => isInRange(session, bounds));

  const summary = sessions.reduce(
    (totals, session) => {
      totals.totalCost += number(session.totalCost);
      totals.totalTokens += number(session.totalTokens);
      totals.inputTokens += number(session.inputTokens);
      totals.outputTokens += number(session.outputTokens);
      totals.cacheRead += number(session.cacheRead);
      totals.cacheWrite += number(session.cacheWrite);
      totals.toolCalls += number(session.toolCalls);
      totals.userMessageCount += number(session.userMessages);
      return totals;
    },
    {
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      toolCalls: 0,
      userMessageCount: 0,
    },
  );
  summary.sessionCount = sessions.length;
  summary.avgCostPerSession = sessions.length > 0 ? summary.totalCost / sessions.length : 0;
  summary.avgCostPerUserMessage =
    summary.userMessageCount > 0 ? summary.totalCost / summary.userMessageCount : 0;

  const models = aggregateRows(
    sessions,
    (session) => session.model,
    (entry, session) => {
      entry.cost += number(session.totalCost);
      entry.sessions += 1;
      entry.totalTokens += number(session.totalTokens);
      entry.inputTokens = number(entry.inputTokens) + number(session.inputTokens);
      entry.outputTokens = number(entry.outputTokens) + number(session.outputTokens);
    },
  ).map((entry) => ({
    ...entry,
    fraction: summary.totalTokens > 0 ? entry.totalTokens / summary.totalTokens : 0,
  }));

  const toolRows = aggregateToolRows(sessions);
  const projects = aggregateRows(
    sessions,
    (session) => session.projectName || session.workspace || session.projectPath,
    (entry, session) => {
      entry.cost += number(session.totalCost);
      entry.sessions += 1;
      entry.totalTokens += number(session.totalTokens);
    },
  );

  return {
    range: {
      range,
      from: bounds.from.toISOString(),
      to: bounds.to.toISOString(),
    },
    summary,
    infobar: {
      overview: {
        totalCost: summary.totalCost,
        sessionCount: summary.sessionCount,
        messageCount: summary.userMessageCount,
      },
      usage: {
        totalTokens: summary.totalTokens,
        inputTokens: summary.inputTokens || summary.totalTokens,
        outputTokens: summary.outputTokens,
        cacheRead: summary.cacheRead,
        cacheWrite: summary.cacheWrite,
        toolCalls: summary.toolCalls,
        tools: toolRows,
      },
      models,
      projects,
    },
    sessions: sessions
      .slice()
      .sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime()),
  };
}

function aggregateToolRows(sessions) {
  const byName = new Map();
  for (const session of sessions) {
    const costs = session.toolCostByName || {};
    for (const [name, costValue] of Object.entries(costs)) {
      const entry = byName.get(name) || { name, cost: 0, count: 0 };
      entry.cost += number(costValue);
      entry.count += 1;
      byName.set(name, entry);
    }
  }
  const total = Array.from(byName.values()).reduce((sum, row) => sum + row.cost, 0);
  return Array.from(byName.values())
    .map((row) => ({ ...row, fraction: total > 0 ? row.cost / total : 0 }))
    .sort((left, right) => right.cost - left.cost);
}

// Loads and renders the Usage dashboard into `container`. The UI shell and CSS
// classes intentionally match the standalone Usage page so the Settings tab
// keeps the same visual design while using the native host data plane.
export async function loadCostDashboard(container, { data, getWorkspaceId }) {
  if (!container) return;
  let currentRange = loadSavedRange();

  // Show a plain loading state first — don't render section titles until data arrives.
  container.innerHTML = `<div class="cost-dash-page"><p class="cost-dash-empty-state">Loading usage…</p></div>`;

  try {
    const workspaceId = getWorkspaceId();
    if (!workspaceId) throw new Error("No active workspace");
    const response = await data.costDashboard(workspaceId);
    const dashboard = response?.dashboard ?? {};

    // Data is ready — now render the full shell with all section headings.
    renderShell(container);
    syncRangeChips(container, currentRange);
    const section = container.querySelector("#cost-dash-section");

    const renderRange = () => {
      saveRange(currentRange);
      syncRangeChips(container, currentRange);
      renderCostDashboard(section, adaptDashboardToInfobarPayload(dashboard, currentRange));
    };

    for (const chip of container.querySelectorAll("[data-range-chip]")) {
      chip.addEventListener("click", () => {
        const nextRange = chip.dataset.rangeChip;
        if (!RANGE_DAYS[nextRange]) return;
        currentRange = nextRange;
        renderRange();
      });
    }

    renderRange();
  } catch (error) {
    renderLoadError(container, error);
  }
}
