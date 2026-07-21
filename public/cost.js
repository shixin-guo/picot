import { renderCostInfobar } from "./cost-infobar.js";

const scopeSelect = document.getElementById("scope-select");
let currentRange = "30d";
const infobarSectionEl = document.getElementById("infobar-cost-section");
const rangeChips = Array.from(document.querySelectorAll("[data-range-chip]"));

if (window.self !== window.top) {
  document.body.classList.add("embedded-cost-view");
  syncThemeFromParent();
}

function syncThemeFromParent() {
  let parentRoot;
  try {
    parentRoot = window.parent?.document?.documentElement;
  } catch {
    parentRoot = null;
  }

  const applyTheme = (themeId) => {
    if (!themeId) return;
    document.documentElement.setAttribute("data-theme", themeId);
  };

  if (parentRoot) {
    applyTheme(parentRoot.getAttribute("data-theme"));
    try {
      const observer = new MutationObserver(() => {
        applyTheme(parentRoot.getAttribute("data-theme"));
      });
      observer.observe(parentRoot, { attributes: true, attributeFilter: ["data-theme"] });
    } catch {}
    return;
  }

  try {
    const saved = readThemeCookie();
    if (saved === "dark") applyTheme("night");
    else if (saved === "light") applyTheme("terracotta");
    else if (saved) applyTheme(saved);
    else if (window.matchMedia?.("(prefers-color-scheme: light)").matches) applyTheme("terracotta");
    else applyTheme("night");
  } catch {
    applyTheme("night");
  }
}

function readThemeCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      if (entry.slice(0, eq) !== "pi-studio-theme") continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {}
  return null;
}

function loadSavedFilters() {
  try {
    const raw = localStorage.getItem("pi-studio-cost-filters");
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.range) currentRange = saved.range;
    if (saved.scope === "all") {
      if (scopeSelect) scopeSelect.value = "all";
    } else if (saved.scope === "current") {
      if (scopeSelect) scopeSelect.value = "all";
    }
  } catch {}
}

function saveFilters() {
  localStorage.setItem(
    "pi-studio-cost-filters",
    JSON.stringify({
      range: currentRange,
      scope: scopeSelect?.value ?? "all",
    }),
  );
}

function syncRangeChips() {
  for (const chip of rangeChips) {
    const active = chip.dataset.rangeChip === currentRange;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function buildQuery() {
  const params = new URLSearchParams({
    range: currentRange,
    granularity: "day",
    scope: scopeSelect?.value ?? "all",
  });
  return params.toString();
}

function renderAll(payload) {
  renderCostInfobar(infobarSectionEl, payload);
}

async function loadDashboard() {
  saveFilters();
  const query = buildQuery();
  const res = await fetch(`/api/cost-dashboard?${query}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  renderAll(payload);
}

for (const chip of rangeChips) {
  chip.addEventListener("click", () => {
    const nextRange = chip.dataset.rangeChip;
    if (!nextRange) return;
    currentRange = nextRange;
    syncRangeChips();
    loadDashboard().catch((error) => {
      console.error("[Cost] Failed to load dashboard:", error);
    });
  });
}

loadSavedFilters();
syncRangeChips();
loadDashboard().catch((error) => {
  console.error("[Cost] Initial load failed:", error);
});
