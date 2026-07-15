function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function formatInt(value) {
  return Number(value || 0).toLocaleString();
}

function formatCompact(value) {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
}

function formatHourLabel(hour) {
  if (!Number.isFinite(hour)) return "N/A";
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12} ${suffix}`;
}

function renderEmpty(target, message = "No data in selected range.") {
  target.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
}

const STAT_ICONS = {
  "Total cost": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5v13M11.5 4H6.75a2.25 2.25 0 0 0 0 4.5h2.5a2.25 2.25 0 0 1 0 4.5H4.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Sessions: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v6A1.5 1.5 0 0 1 12.5 10H9l-3 3v-3H3.5A1.5 1.5 0 0 1 2 8.5v-6z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`,
  Messages: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1 3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5l-4 4V3z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><circle cx="5.5" cy="6.5" r="1" fill="currentColor"/><circle cx="8" cy="6.5" r="1" fill="currentColor"/><circle cx="10.5" cy="6.5" r="1" fill="currentColor"/></svg>`,
  "Total tokens": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><ellipse cx="8" cy="4" rx="5.5" ry="2" stroke="currentColor" stroke-width="1.25"/><path d="M2.5 4v4c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4" stroke="currentColor" stroke-width="1.25"/><path d="M2.5 8v4c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V8" stroke="currentColor" stroke-width="1.25"/></svg>`,
  "Active days": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="3" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.25"/><path d="M5 1v3M11 1v3M1 7h14" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><circle cx="5" cy="10.5" r="1" fill="currentColor"/><circle cx="8" cy="10.5" r="1" fill="currentColor"/><circle cx="11" cy="10.5" r="1" fill="currentColor"/></svg>`,
  "Current streak": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 1S4 5 4 9a4 4 0 0 0 8 0c0-4-4-8-4-8z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="M8 11.5c-.83 0-1.5-.67-1.5-1.5S8 7.5 8 7.5s1.5 1 1.5 2.5-.67 1.5-1.5 1.5z" fill="currentColor"/></svg>`,
  "Longest streak": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 2.5h9v5.5a4.5 4.5 0 0 1-9 0V2.5z" stroke="currentColor" stroke-width="1.25"/><path d="M3.5 5.5H2a1.5 1.5 0 0 0 1.5 1.5M12.5 5.5H14a1.5 1.5 0 0 1-1.5 1.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><path d="M8 12.5v2M5.5 14.5h5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  "Peak hour": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.25"/><path d="M8 4v4l3 3" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  Input: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v9M4.5 7.5 8 11l3.5-3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 13.5h11" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  Output: `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 14V5M4.5 8.5 8 5l3.5 3.5" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 2.5h11" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  "Cache Read": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 1.5 5 8.5h4.5L6.5 14.5l6-8.5H8l1.5-4.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/></svg>`,
  "Cache Write": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 4a2 2 0 0 1 2-2h6l4 4v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4z" stroke="currentColor" stroke-width="1.25"/><path d="M5 2v3.5h5V2M5 15v-4h6v4" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>`,
  "Tool Calls": `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 1.5a3.5 3.5 0 0 1 .5 5.5L4 13.5a1.5 1.5 0 0 1-2-2L8.5 5A3.5 3.5 0 0 1 10 1.5z" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><circle cx="10.5" cy="3.5" r="1" fill="currentColor"/></svg>`,
};

function buildStatCard(title, value, tone, extraClass = "") {
  const icon = STAT_ICONS[title] || "";
  return `
    <article class="infobar-stat-card infobar-card-tone-${tone} ${extraClass}">
      <div class="infobar-stat-title">${icon ? `<span class="infobar-stat-icon">${icon}</span>` : ""}${escapeHtml(title)}</div>
      <div class="infobar-stat-value">${escapeHtml(value)}</div>
    </article>
  `;
}

export function renderInfobarOverview(target, overview = {}, usage = {}) {
  const stats = [
    ["Total cost", formatUsd(overview.totalCost), "green", ""],
    ["Sessions", formatInt(overview.sessions), "blue", ""],
    ["Messages", formatInt(overview.messages), "violet", ""],
    ["Total tokens", formatCompact(overview.totalTokens), "teal", ""],
    ["Active days", formatInt(overview.activeDays), "amber", ""],
    ["Current streak", `${formatInt(overview.currentStreak)}d`, "blue", ""],
    ["Longest streak", `${formatInt(overview.longestStreak)}d`, "violet", ""],
    ["Input", formatCompact(usage.inputTokens), "teal", ""],
    ["Output", formatCompact(usage.outputTokens), "green", ""],
    ["Cache Read", formatCompact(usage.cacheRead), "amber", ""],
    ["Cache Write", formatCompact(usage.cacheWrite), "violet", ""],
    ["Tool Calls", formatInt(usage.toolCalls), "rose", ""],
  ];
  target.innerHTML = stats
    .map(([title, value, tone, extraClass]) => buildStatCard(title, value, tone, extraClass))
    .join("");
}

export function renderInfobarModels(target, rows = [], payload = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    renderEmpty(target);
    return;
  }
  const modelSummary = buildModelSummary(rows, payload);
  target.innerHTML = `
    <div class="infobar-models-card">
      <div class="infobar-models-chart-wrap">
        <canvas class="infobar-models-chart" width="960" height="320"></canvas>
      </div>
      <div class="infobar-models-legend">
        ${modelSummary.models
          .map((model, index) => {
            const percent = Math.round((model.fraction || 0) * 1000) / 10;
            return `
              <div class="infobar-model-legend-row">
                <div class="infobar-model-legend-main">
                  <span class="infobar-tool-legend-dot infobar-model-color-${index + 1}"></span>
                  <span class="infobar-model-legend-name">${escapeHtml(model.name)}</span>
                </div>
                <div class="infobar-model-legend-meta">
                  <span>${formatCompact(model.inputTokens)} in · ${formatCompact(model.outputTokens)} out</span>
                  <span>${percent}%</span>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
  renderModelsChart(target.querySelector(".infobar-models-chart"), modelSummary);
}

export function renderInfobarProjects(target, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    renderEmpty(target);
    return;
  }
  const top = rows.slice(0, 6);
  const totalCost = top.reduce((sum, r) => sum + Number(r.cost || 0), 0);
  target.innerHTML = `
    <div class="infobar-projects-card">
      <div class="infobar-tool-chart-layout">
        <div class="infobar-tool-chart-wrap">
          <canvas class="infobar-projects-chart" width="240" height="240"></canvas>
        </div>
        <div class="infobar-tool-legend">
          ${top
            .map((row, index) => {
              const percent =
                totalCost > 0 ? Math.round((Number(row.cost || 0) / totalCost) * 100) : 0;
              return `
                <div class="infobar-tool-legend-row">
                  <div class="infobar-tool-legend-main">
                    <span class="infobar-tool-legend-dot" data-tool-color="${index}"></span>
                    <div>
                      <div class="infobar-tool-legend-title">${escapeHtml(row.name || "unknown")}</div>
                      <div class="infobar-tool-legend-subtitle">${formatInt(row.sessions || 0)} sessions</div>
                    </div>
                  </div>
                  <div class="infobar-tool-legend-values">
                    <span>${formatUsd(row.cost)}</span>
                    <span>${percent}%</span>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      </div>
    </div>
  `;
  renderProjectsChart(target.querySelector(".infobar-projects-chart"), top);
}

export function renderInfobarUsage(target, usage = {}) {
  const summaryCards = [
    ["Total Tokens", formatCompact(usage.totalTokens), "blue"],
    ["Input", formatCompact(usage.inputTokens), "teal"],
    ["Output", formatCompact(usage.outputTokens), "green"],
    ["Cache Read", formatCompact(usage.cacheRead), "amber"],
    ["Cache Write", formatCompact(usage.cacheWrite), "violet"],
    ["Tool Calls", formatInt(usage.toolCalls), "rose"],
  ];

  target.innerHTML = `
    <div class="infobar-usage-grid">
      ${summaryCards.map(([title, value, tone]) => buildStatCard(title, value, tone)).join("")}
    </div>
  `;
}

export function renderInfobarToolCost(target, usage = {}, metaTarget = null) {
  const tools = Array.isArray(usage.tools) ? usage.tools : [];
  if (metaTarget) {
    metaTarget.textContent = `${formatInt(tools.length)} tracked`;
  }
  target.innerHTML = `
    <div class="infobar-tool-cost-card">
      ${
        tools.length > 0
          ? `
        <div class="infobar-tool-chart-layout">
          <div class="infobar-tool-chart-wrap">
            <canvas class="infobar-tool-chart" width="240" height="240"></canvas>
          </div>
          <div class="infobar-tool-legend">
            ${tools
              .slice(0, 6)
              .map((row, index) => {
                const percent = Math.round((row.fraction || 0) * 100);
                return `
                  <div class="infobar-tool-legend-row">
                    <div class="infobar-tool-legend-main">
                      <span class="infobar-tool-legend-dot" data-tool-color="${index}"></span>
                      <div>
                        <div class="infobar-tool-legend-title">${escapeHtml(row.name || "unknown")}</div>
                        <div class="infobar-tool-legend-subtitle">${formatInt(row.count)} sessions</div>
                      </div>
                    </div>
                    <div class="infobar-tool-legend-values">
                      <span>${formatUsd(row.cost)}</span>
                      <span>${percent}%</span>
                    </div>
                  </div>
                `;
              })
              .join("")}
          </div>
        </div>
      `
          : '<div class="empty">No tool usage in selected range.</div>'
      }
    </div>
  `;

  if (tools.length > 0) {
    renderToolCostChart(target.querySelector(".infobar-tool-chart"), tools.slice(0, 6));
  }
}

function formatSessionDate(timeStr) {
  if (!timeStr) return "";
  const d = new Date(timeStr);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderSessionsPanel(target, sessions = []) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    renderEmpty(target, "No recent sessions in selected range.");
    return;
  }
  target.innerHTML = `
    <div class="infobar-sessions-table-wrap">
      <table class="infobar-sessions-table">
        <thead>
          <tr>
            <th>Session</th>
            <th>Model</th>
            <th class="num">Tokens</th>
            <th class="num">Tools</th>
            <th class="num">Cost</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          ${sessions
            .map(
              (session) => `
            <tr>
              <td class="infobar-sessions-td-title">
                <div class="infobar-sessions-title">${escapeHtml(session.title || "Untitled")}</div>
                ${session.workspace ? `<div class="infobar-sessions-workspace">${escapeHtml(session.workspace)}</div>` : ""}
              </td>
              <td class="infobar-sessions-td-model">${escapeHtml(session.model || "—")}</td>
              <td class="num">${formatCompact(session.totalTokens)}</td>
              <td class="num">${formatInt(session.toolCalls)}</td>
              <td class="num infobar-sessions-cost">${formatUsd(session.totalCost)}</td>
              <td class="infobar-sessions-td-date">${formatSessionDate(session.time)}</td>
            </tr>
          `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function deriveOverviewMetrics(payload, overview) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const dayCounts = new Map();
  const hourCounts = new Map();
  const modelCounts = new Map();

  for (const session of sessions) {
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const dayKey = time.toISOString().slice(0, 10);
    dayCounts.set(dayKey, (dayCounts.get(dayKey) || 0) + 1);
    hourCounts.set(time.getHours(), (hourCounts.get(time.getHours()) || 0) + 1);
    if (session.model) {
      modelCounts.set(session.model, (modelCounts.get(session.model) || 0) + 1);
    }
  }

  const sortedDays = Array.from(dayCounts.keys()).sort();
  let longestStreak = 0;
  let currentStreak = 0;
  let streak = 0;
  let previousDate = null;

  for (const key of sortedDays) {
    const currentDate = new Date(`${key}T00:00:00`);
    if (previousDate) {
      const diffDays = Math.round((currentDate - previousDate) / 86400000);
      streak = diffDays === 1 ? streak + 1 : 1;
    } else {
      streak = 1;
    }
    longestStreak = Math.max(longestStreak, streak);
    previousDate = currentDate;
  }

  if (sortedDays.length > 0) {
    const todayKey = new Date().toISOString().slice(0, 10);
    const cursor = new Date(`${todayKey}T00:00:00`);
    while (dayCounts.has(cursor.toISOString().slice(0, 10))) {
      currentStreak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
  }

  const peakHourEntry =
    Array.from(hourCounts.entries()).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] || null;
  const favoriteModelEntry =
    Array.from(modelCounts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ||
    null;

  return {
    totalCost: overview.totalCost || payload.summary?.totalCost || 0,
    sessions: overview.sessionCount || sessions.length,
    messages: overview.messageCount || 0,
    totalTokens: payload.summary?.totalTokens || 0,
    activeDays: overview.daysActive || sortedDays.length,
    currentStreak,
    longestStreak,
    peakHour: peakHourEntry ? formatHourLabel(peakHourEntry[0]) : "N/A",
    favoriteModel: favoriteModelEntry?.[0] || "N/A",
  };
}

function _buildActivityDays(payload) {
  const from = payload.range?.from ? new Date(payload.range.from) : null;
  const to = payload.range?.to ? new Date(payload.range.to) : null;
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const intensityByDay = new Map();

  for (const session of sessions) {
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const key = time.toISOString().slice(0, 10);
    intensityByDay.set(key, (intensityByDay.get(key) || 0) + Number(session.totalTokens || 0));
  }

  if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
    return [];
  }

  const days = [];
  const cursor = new Date(from);
  cursor.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (cursor <= end) {
    const key = cursor.toISOString().slice(0, 10);
    days.push({ key, value: intensityByDay.get(key) || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function renderActivityPanel(target, payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const intensityByDay = new Map();
  for (const session of sessions) {
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const key = time.toISOString().slice(0, 10);
    intensityByDay.set(key, (intensityByDay.get(key) || 0) + Number(session.totalTokens || 0));
  }

  const TOTAL_DAYS = 365;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = TOTAL_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({ key, value: intensityByDay.get(key) || 0 });
  }

  const max = Math.max(...days.map((day) => day.value), 0);
  const leadingEmptyDays = new Date(`${days[0]?.key}T00:00:00`).getDay();
  const totalCells = leadingEmptyDays + days.length;
  const weekColumns = Math.ceil(totalCells / 7);
  const monthLabels = buildActivityMonthLabels(days, leadingEmptyDays);
  const emptyCells = Array.from(
    { length: leadingEmptyDays },
    () => '<div class="infobar-activity-cell is-empty" aria-hidden="true"></div>',
  ).join("");

  target.innerHTML = `
    <div class="infobar-activity-calendar" style="--activity-columns:${weekColumns}">
      <div class="infobar-activity-months" aria-hidden="true">
        ${monthLabels
          .map(
            (label) =>
              `<span class="infobar-activity-month" style="grid-column:${label.column}">${escapeHtml(label.name)}</span>`,
          )
          .join("")}
      </div>
      <div class="infobar-activity-body">
        <div class="infobar-activity-weekdays" aria-hidden="true">
          <span></span>
          <span>Mon</span>
          <span></span>
          <span>Wed</span>
          <span></span>
          <span>Fri</span>
          <span></span>
        </div>
        <div class="infobar-activity-grid">
          ${emptyCells}${days
            .map((day) => {
              let level = 0;
              if (max > 0) {
                const ratio = day.value / max;
                if (ratio >= 0.75) level = 4;
                else if (ratio >= 0.5) level = 3;
                else if (ratio >= 0.25) level = 2;
                else if (ratio > 0) level = 1;
              }
              return `<div class="infobar-activity-cell level-${level}" title="${day.key} · ${formatCompact(day.value)} tokens"></div>`;
            })
            .join("")}
        </div>
      </div>
      <div class="infobar-activity-footer">
        <span>Less</span>
        <span class="infobar-activity-cell level-0" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-1" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-2" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-3" aria-hidden="true"></span>
        <span class="infobar-activity-cell level-4" aria-hidden="true"></span>
        <span>More</span>
      </div>
    </div>
  `;
}

function buildActivityMonthLabels(days, leadingEmptyDays) {
  const labels = [];
  const seen = new Set();
  for (let index = 0; index < days.length; index += 1) {
    const date = new Date(`${days[index].key}T00:00:00`);
    if (!Number.isFinite(date.getTime())) continue;
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    if (seen.has(monthKey)) continue;
    seen.add(monthKey);
    labels.push({
      column: Math.floor((leadingEmptyDays + index) / 7) + 1,
      name: date.toLocaleDateString(undefined, { month: "short" }),
    });
  }
  return labels;
}

function renderOverviewNote(target, totalTokens) {
  const warAndPeaceTokens = 587000;
  const ratio = Math.max(1, Math.round(Number(totalTokens || 0) / warAndPeaceTokens));
  target.textContent = `You've used ~${ratio}x more tokens than War and Peace.`;
}

function buildModelSummary(rows, payload) {
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const topModels = rows.slice(0, 3).map((row) => ({
    name: row.name || "unknown",
    fraction: Number(row.fraction || 0),
    inputTokens: 0,
    outputTokens: 0,
  }));
  const modelNames = new Set(topModels.map((model) => model.name));
  const byDay = new Map();

  for (const session of sessions) {
    const modelName = session.model || "unknown";
    if (!modelNames.has(modelName)) continue;
    const time = new Date(session.time);
    if (!Number.isFinite(time.getTime())) continue;
    const dayKey = time.toISOString().slice(0, 10);
    let day = byDay.get(dayKey);
    if (!day) {
      day = Object.create(null);
      byDay.set(dayKey, day);
    }
    day[modelName] = (day[modelName] || 0) + Number(session.totalTokens || 0);
    const summary = topModels.find((model) => model.name === modelName);
    if (summary) {
      summary.inputTokens += Number(session.inputTokens || 0);
      summary.outputTokens += Number(session.outputTokens || 0);
    }
  }

  const labels = Array.from(byDay.keys()).sort();
  return {
    labels,
    models: topModels,
    series: topModels.map((model) => ({
      name: model.name,
      data: labels.map((label) => Number(byDay.get(label)?.[model.name] || 0)),
    })),
  };
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function _makeBarGradient(ctx, chartArea, color) {
  if (!chartArea) return color;
  const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, hexToRgba(color, 0.5));
  return gradient;
}

function getModelChartPalette() {
  return ["#3b82f6", "#10b981", "#f59e0b"];
}

function getStackSegmentRadius(seriesList, datasetIndex, dataIndex) {
  const activeIndices = seriesList
    .map((series, index) => ({ index, value: Number(series.data?.[dataIndex] || 0) }))
    .filter((entry) => entry.value > 0)
    .map((entry) => entry.index);

  if (activeIndices.length === 0 || !activeIndices.includes(datasetIndex)) {
    return 0;
  }

  const first = activeIndices[0];
  const last = activeIndices[activeIndices.length - 1];

  if (first === last) {
    return { topLeft: 6, topRight: 6, bottomLeft: 6, bottomRight: 6 };
  }

  if (datasetIndex === first) {
    return { topLeft: 0, topRight: 0, bottomLeft: 6, bottomRight: 6 };
  }

  if (datasetIndex === last) {
    return { topLeft: 6, topRight: 6, bottomLeft: 0, bottomRight: 0 };
  }

  return 0;
}

function renderModelsChart(canvas, modelSummary) {
  if (!canvas || !modelSummary) return;
  const colors = getModelChartPalette();
  if (typeof window.Chart === "function") {
    const previous = canvas._modelsChart;
    if (previous && typeof previous.destroy === "function") {
      previous.destroy();
    }
    canvas._modelsChart = new window.Chart(canvas, {
      type: "bar",
      data: {
        labels: modelSummary.labels,
        datasets: modelSummary.series.map((series, index) => ({
          label: series.name,
          data: series.data,
          backgroundColor: colors[index] || colors[colors.length - 1],
          borderRadius(context) {
            return getStackSegmentRadius(modelSummary.series, index, context.dataIndex);
          },
          borderSkipped: false,
          maxBarThickness: 30,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.dataset.label}: ${formatCompact(context.raw)} tokens`;
              },
            },
          },
        },
        scales: {
          x: {
            stacked: true,
            grid: {
              display: false,
            },
            border: {
              display: false,
            },
            ticks: {
              color: "#8f959e",
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
            },
          },
          y: {
            stacked: true,
            grid: {
              color: "rgba(255,255,255,0.08)",
            },
            border: {
              display: false,
            },
            ticks: {
              color: "#8f959e",
              callback(value) {
                return formatCompact(value);
              },
            },
          },
        },
      },
    });
    return;
  }

  renderModelsChartFallback(canvas, modelSummary, colors);
}

function renderModelsChartFallback(canvas, modelSummary, colors) {
  const labels = modelSummary.labels.length > 0 ? modelSummary.labels : ["Total"];
  const series =
    modelSummary.labels.length > 0
      ? modelSummary.series
      : modelSummary.models.map((model) => ({
          name: model.name,
          data: [Number(model.inputTokens || 0) + Number(model.outputTokens || 0)],
        }));
  const totals = labels.map((_, dataIndex) =>
    series.reduce((sum, item) => sum + Number(item.data?.[dataIndex] || 0), 0),
  );
  const maxTotal = Math.max(...totals, 0);

  if (maxTotal <= 0) {
    canvas.replaceWith(
      Object.assign(document.createElement("div"), {
        className: "empty",
        textContent: "No model token history in selected range.",
      }),
    );
    return;
  }

  const chart = document.createElement("div");
  chart.className = "infobar-models-chart-fallback";
  chart.innerHTML = labels
    .map((label, dataIndex) => {
      const total = totals[dataIndex];
      const height = Math.max(4, (total / maxTotal) * 100);
      const segments = series
        .map((item, seriesIndex) => ({
          color: colors[seriesIndex] || colors[colors.length - 1],
          name: item.name,
          value: Number(item.data?.[dataIndex] || 0),
        }))
        .filter((item) => item.value > 0)
        .map((item) => {
          const basis = total > 0 ? (item.value / total) * 100 : 0;
          return `<span class="infobar-models-fallback-segment" style="flex-basis:${basis}%;background:${item.color}" title="${escapeHtml(item.name)}: ${formatCompact(item.value)} tokens"></span>`;
        })
        .join("");
      return `
        <div class="infobar-models-fallback-column">
          <div class="infobar-models-fallback-track">
            <div class="infobar-models-fallback-bar" style="height:${height}%">${segments}</div>
          </div>
          <div class="infobar-models-fallback-label">${escapeHtml(formatChartDateLabel(label))}</div>
        </div>
      `;
    })
    .join("");
  canvas.replaceWith(chart);
}

function formatChartDateLabel(label) {
  if (label === "Total") return label;
  const date = new Date(`${label}T00:00:00`);
  if (!Number.isFinite(date.getTime())) return label;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getToolChartPalette() {
  return ["#4f8ff7", "#67c587", "#f3a64f", "#8c7cf7", "#ef6b73", "#4fc3d9"];
}

function renderProjectsChart(canvas, rows) {
  if (!canvas || !Array.isArray(rows) || rows.length === 0) return;
  const labels = rows.map((row) => row.name || "unknown");
  const data = rows.map((row) => Number(row.cost || 0));
  const colors = getToolChartPalette().slice(0, rows.length);

  if (typeof window.Chart === "function") {
    const previous = canvas._projectsChart;
    if (previous && typeof previous.destroy === "function") {
      previous.destroy();
    }
    canvas._projectsChart = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: colors,
            borderWidth: 0,
            hoverOffset: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.label}: ${formatUsd(context.raw)}`;
              },
            },
          },
        },
      },
    });
    return;
  }

  renderDoughnutFallback(canvas, data, colors);
}

function renderToolCostChart(canvas, tools) {
  if (!canvas || !Array.isArray(tools) || tools.length === 0) return;
  const labels = tools.map((tool) => tool.name || "unknown");
  const data = tools.map((tool) => Number(tool.cost || 0));
  const colors = getToolChartPalette().slice(0, tools.length);

  if (typeof window.Chart === "function") {
    const previous = canvas._toolCostChart;
    if (previous && typeof previous.destroy === "function") {
      previous.destroy();
    }
    canvas._toolCostChart = new window.Chart(canvas, {
      type: "doughnut",
      data: {
        labels,
        datasets: [
          {
            data,
            backgroundColor: colors,
            borderWidth: 0,
            hoverOffset: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            display: false,
          },
          tooltip: {
            callbacks: {
              label(context) {
                return `${context.label}: ${formatUsd(context.raw)}`;
              },
            },
          },
        },
      },
    });
    return;
  }

  renderDoughnutFallback(canvas, data, colors);
}

function renderDoughnutFallback(canvas, data, colors) {
  const total = data.reduce((sum, value) => sum + value, 0);
  const conicStops = data.reduce(
    (parts, value, index) => {
      const start = parts.offset;
      const end = total > 0 ? start + (value / total) * 360 : start;
      parts.values.push(`${colors[index]} ${start}deg ${end}deg`);
      parts.offset = end;
      return parts;
    },
    { values: [], offset: 0 },
  );
  const background =
    conicStops.values.length > 0 ? conicStops.values.join(", ") : "#d8d3ca 0deg 360deg";

  canvas.replaceWith(
    Object.assign(document.createElement("div"), {
      className: "infobar-tool-chart-fallback",
      style: `background: radial-gradient(circle, var(--bg-solid, #f4f1ec) 0 54%, transparent 55%), conic-gradient(${background});`,
    }),
  );
}

export function renderCostInfobar(section, payload = {}) {
  if (!section) return;
  const overviewEl = section.querySelector("#infobar-overview-grid");
  const activityEl = section.querySelector("#infobar-activity-panel");
  const overviewNoteEl = section.querySelector("#infobar-overview-note");
  const modelsEl = section.querySelector("#infobar-models-list");
  const toolCostEl = section.querySelector("#infobar-tool-cost-panel");
  const projectsEl = section.querySelector("#infobar-projects-list");
  const sessionsEl = section.querySelector("#infobar-sessions-panel");
  const titleEl = section.querySelector("#infobar-page-title");

  if (
    !overviewEl ||
    !activityEl ||
    !overviewNoteEl ||
    !modelsEl ||
    !toolCostEl ||
    !projectsEl ||
    !sessionsEl
  ) {
    return;
  }

  const infobar = payload.infobar || payload || {};
  const overview = infobar.overview || {};
  const hasData = Number(overview.sessionCount || 0) > 0;
  if (titleEl) {
    titleEl.textContent = "Pi Stats";
  }
  if (!hasData) {
    renderEmpty(overviewEl);
    renderEmpty(activityEl);
    overviewNoteEl.textContent = "";
    renderEmpty(modelsEl);
    renderEmpty(toolCostEl);
    renderEmpty(projectsEl);
    renderEmpty(sessionsEl);
    return;
  }

  const overviewMetrics = deriveOverviewMetrics(payload, overview);
  renderInfobarOverview(overviewEl, overviewMetrics, infobar.usage || {});
  renderActivityPanel(activityEl, payload);
  renderOverviewNote(overviewNoteEl, overviewMetrics.totalTokens);
  renderInfobarModels(modelsEl, infobar.models || [], payload);
  renderInfobarToolCost(toolCostEl, infobar.usage || {});
  renderInfobarProjects(projectsEl, infobar.projects || []);
  renderSessionsPanel(sessionsEl, payload.sessions || payload.topSessions || []);
}
