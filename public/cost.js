const scopeSelect = document.getElementById('scope-select');
const rangeSelect = document.getElementById('range-select');

const applyFiltersBtn = document.getElementById('apply-filters-btn');
const resetFiltersBtn = document.getElementById('reset-filters-btn');

const kpiTotalCost = document.getElementById('kpi-total-cost');
const kpiTotalTokens = document.getElementById('kpi-total-tokens');
const kpiCostSession = document.getElementById('kpi-cost-session');
const kpiCostMessage = document.getElementById('kpi-cost-message');

const trendBarsEl = document.getElementById('trend-bars');
const trendEmptyEl = document.getElementById('trend-empty');
const modelBreakdownEl = document.getElementById('model-breakdown');
const toolBreakdownEl = document.getElementById('tool-breakdown');

const allSessionsEl = document.getElementById('all-sessions');

let currentPayload = null;

if (window.self !== window.top) {
  document.body.classList.add('embedded-cost-view');
  syncThemeFromParent();
}

function syncThemeFromParent() {
  let parentRoot;
  try {
    parentRoot = window.parent?.document?.documentElement;
  } catch {
    // Cross-origin: fall back to localStorage / OS preference.
    parentRoot = null;
  }

  const applyTheme = (themeId) => {
    if (!themeId) return;
    document.documentElement.setAttribute('data-theme', themeId);
  };

  if (parentRoot) {
    applyTheme(parentRoot.getAttribute('data-theme'));
    try {
      const observer = new MutationObserver(() => {
        applyTheme(parentRoot.getAttribute('data-theme'));
      });
      observer.observe(parentRoot, { attributes: true, attributeFilter: ['data-theme'] });
    } catch {
      // ignore observer setup failure
    }
    return;
  }

  // Cross-origin fallback: read the same cookie the parent persists.
  // (Themes are stored in a cookie rather than localStorage so they
  // survive across the different `localhost:<port>` origins Pi Studio
  // uses for each workspace — see public/themes.js for details.)
  try {
    const saved = readThemeCookie();
    if (saved === 'dark') applyTheme('night');
    else if (saved === 'light') applyTheme('terracotta');
    else if (saved) applyTheme(saved);
    else if (window.matchMedia?.('(prefers-color-scheme: light)').matches) applyTheme('terracotta');
    else applyTheme('night');
  } catch {
    applyTheme('night');
  }
}

function readThemeCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (const entry of cookies) {
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      if (entry.slice(0, eq) !== 'pi-studio-theme') continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatInt(value) {
  return Number(value || 0).toLocaleString();
}

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem('pi-studio-cost-filters');
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.range) rangeSelect.value = saved.range;
    if (saved.scope) scopeSelect.value = saved.scope;

  } catch {
    // ignore
  }
}

function saveFilters() {
  localStorage.setItem('pi-studio-cost-filters', JSON.stringify({
    range: rangeSelect.value,
    scope: scopeSelect.value,
  }));
}

function buildQuery() {
  const params = new URLSearchParams({
    range: rangeSelect.value,
    granularity: 'day',
    scope: scopeSelect.value,
  });
  return params.toString();
}

function renderKpis(summary = {}) {
  kpiTotalCost.textContent = formatUsd(summary.totalCost);
  kpiTotalTokens.textContent = formatInt(summary.totalTokens);
  kpiCostSession.textContent = formatUsd(summary.avgCostPerSession);
  kpiCostMessage.textContent = formatUsd(summary.avgCostPerUserMessage);
}

function renderTrend(series = []) {
  if (!Array.isArray(series) || series.length === 0) {
    trendBarsEl.innerHTML = '';
    trendEmptyEl.classList.remove('hidden');
    return;
  }
  trendEmptyEl.classList.add('hidden');
  const max = Math.max(...series.map((s) => Number(s.cost || 0)), 0.0001);
  trendBarsEl.innerHTML = series.map((s) => {
    const width = Math.max(2, Math.round((Number(s.cost || 0) / max) * 100));
    return `
      <div class="trend-row">
        <span>${s.bucket}</span>
        <div class="trend-bar-wrap"><div class="trend-bar" style="width:${width}%"></div></div>
        <span>${formatUsd(s.cost)}</span>
      </div>
    `;
  }).join('');
}

function renderBreakdown(target, rows = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    target.innerHTML = '<div class="empty">No data</div>';
    return;
  }
  target.innerHTML = rows.slice(0, 12).map((row) => `
    <div class="breakdown-row">
      <span>${row.name || 'unknown'}</span>
      <span>${formatUsd(row.cost)}</span>
    </div>
  `).join('');
}

function renderSessionsTable(target, sessions = []) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    target.innerHTML = '<div class="empty">No sessions found.</div>';
    return;
  }
  target.innerHTML = `
    <table class="cost-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Title</th>
          <th>Workspace</th>
          <th>Model</th>
          <th>Total Cost</th>
          <th>Tokens</th>
          <th>Tool Calls</th>
          <th>Cost / Msg</th>
        </tr>
      </thead>
      <tbody>
        ${sessions.map((s) => `
          <tr>
            <td>${new Date(s.time).toLocaleString()}</td>
            <td>${escapeHtml(s.title || 'Untitled')}</td>
            <td>${escapeHtml(s.workspace || '')}</td>
            <td>${escapeHtml(s.model || 'unknown')}</td>
            <td>${formatUsd(s.totalCost)}</td>
            <td>${formatInt(s.totalTokens)}</td>
            <td>${formatInt(s.toolCalls)}</td>
            <td>${formatUsd(s.costPerUserMessage)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderAll(payload) {
  currentPayload = payload;
  renderKpis(payload.summary || {});
  renderTrend(payload.series || []);
  renderBreakdown(modelBreakdownEl, payload.breakdown?.byModel || []);
  renderBreakdown(toolBreakdownEl, payload.breakdown?.byTool || []);
  renderSessionsTable(allSessionsEl, payload.sessions || []);
}

async function loadDashboard() {
  saveFilters();
  const query = buildQuery();
  const res = await fetch(`/api/cost-dashboard?${query}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  renderAll(payload);
}


applyFiltersBtn.addEventListener('click', () => {
  loadDashboard().catch((error) => {
    console.error('[Cost] Failed to load dashboard:', error);
  });
});

resetFiltersBtn.addEventListener('click', () => {
  rangeSelect.value = '30d';
  scopeSelect.value = 'current';
  loadDashboard().catch((error) => {
    console.error('[Cost] Failed to reset dashboard:', error);
  });
});

loadSavedFilters();
loadDashboard().catch((error) => {
  console.error('[Cost] Initial load failed:', error);
});
