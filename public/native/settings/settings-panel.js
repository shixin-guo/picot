import { t } from "../../i18n.js";
import { applyTheme, getCurrentTheme, themes } from "../../themes.js";
import { loadCostDashboard } from "./cost-dashboard.js";
import { setupLanguageSelector } from "./language-selector.js";
import { setupPackageBrowse } from "./package-browse.js";
import { setupPackageSkillsTab } from "./package-skills-tab.js";
import { setupSettingsConfig } from "./settings-config.js";
import { setupSettingsToggles } from "./settings-toggles.js";
import { setupDiscoveredSkillsTab } from "./skills-discovered-tab.js";
import { setupSkillsInstallTab } from "./skills-install-tab.js";
import { setupSkillsTabShell } from "./skills-tab-shell.js";
import { setupThinkingEffortControl } from "./thinking-effort-control.js";

// Wires the settings overlay panel for the native runtime: open/close, tab
// switching, theme grid, the embedded pi version readout, the Usage tab (cost
// dashboard), the Extensions tab (community package browse), and the
// Configuration tab (API keys / model catalog + agent-config / models.json
// editors). When `data` + `getWorkspaceId` are supplied the Usage tab loads
// aggregated cost data from the native host on first open. `control` is a
// HostControlGateway (or null) used by the Extensions tab to list/install/remove
// packages via the embedded pi CLI. `configGateway` (or null) drives the
// Configuration tab via the picot-bridge extension. Both tabs are populated
// lazily whenever they are shown.
export function setupSettingsPanel({
  data,
  getWorkspaceId,
  control,
  configGateway,
  onModelConfigurationChanged,
  runtime,
  getTarget,
  onError,
  notify,
} = {}) {
  const panel = document.getElementById("settings-panel");
  const openBtn = document.getElementById("settings-btn");
  const closeBtn = document.getElementById("settings-close");
  const overlay = document.getElementById("settings-overlay");
  if (!panel || !openBtn) return;

  const navItems = Array.from(document.querySelectorAll(".settings-nav-item"));
  const tabs = Array.from(document.querySelectorAll(".settings-tab"));
  const validTabKeys = new Set(navItems.map((item) => item.dataset.settingsTab));
  const themeGrid = document.getElementById("theme-grid");
  const piVersionValue = document.getElementById("setting-pi-version-value");
  const appVersionValue = document.getElementById("setting-app-version-value");
  const costDashboard = document.getElementById("settings-cost-dashboard");
  const packageBrowse = setupPackageBrowse(control, { notify });
  const config = configGateway
    ? setupSettingsConfig({ configGateway, onModelConfigurationChanged })
    : null;
  const thinkingControl = setupThinkingEffortControl({
    runtime,
    getTarget,
    configGateway,
    onError,
  });
  const skillsRpc = async (command) => {
    if (!configGateway) {
      return { success: false, error: t("settings.skills.loadFailed") };
    }
    const { type, ...params } = command;
    const result = await configGateway.call(type, params);
    if (!result?.ok) {
      return { success: false, error: result?.error || t("settings.skills.loadFailed") };
    }
    return { success: true, data: result.data };
  };
  const showSkillsSuccess = notify
    ? (message) => notify({ type: "success", title: t("status.saved"), message })
    : undefined;
  const showSkillsError = notify
    ? (message) => notify({ type: "error", title: t("settings.skills.saveFailed"), message })
    : (message) => onError?.(message);

  const discoveredTab = setupDiscoveredSkillsTab({
    container: document.getElementById("settings-skills"),
    rpcCommand: skillsRpc,
    showSuccess: showSkillsSuccess,
    showError: showSkillsError,
  });
  const installTab = control
    ? setupSkillsInstallTab({
        container: document.getElementById("settings-install-skills"),
        transport: control,
        getWorkspaceId,
        isProjectTrusted: () => true,
        showSuccess: showSkillsSuccess,
        showError: showSkillsError,
      })
    : null;
  const packageTab = setupPackageSkillsTab({
    container: document.getElementById("settings-package-skills"),
    rpcCommand: skillsRpc,
  });

  const skillsTabs = Array.from(document.querySelectorAll("[data-skills-page-tab]"));
  const skillsPanels = {
    discovered: document.getElementById("settings-skills"),
    install: document.getElementById("settings-install-skills"),
    packages: document.getElementById("settings-package-skills"),
  };
  const skillsShell = setupSkillsTabShell({
    tabs: skillsTabs,
    panels: skillsPanels,
    activate: (name) => {
      if (name === "discovered") discoveredTab.activate?.();
      else if (name === "install") installTab?.activate?.();
      else if (name === "packages") packageTab.activate?.();
    },
  });

  // Backward-compatible alias: settings-panel calls skillsPage.activate() on tab switch
  const skillsPage = {
    activate: () => {
      skillsShell.select(skillsTabs[0]);
      discoveredTab.activate?.();
    },
  };
  setupLanguageSelector();
  setupSettingsToggles({ configGateway, onError });
  let usageLoaded = false;

  function loadUsage() {
    if (usageLoaded || !costDashboard || !data || !getWorkspaceId) return;
    usageLoaded = true;
    void loadCostDashboard(costDashboard, { data, getWorkspaceId });
  }

  function loadConfiguration() {
    if (!config) return;
    void config.loadApiKeysPanel();
    void config.loadInlineConfigEditor();
    void config.loadInlineModelsEditor();
  }

  function selectTab(tabKey = "general") {
    const target = tabKey === "auth" ? "configuration" : tabKey;
    for (const item of navItems) {
      item.classList.toggle("active", item.dataset.settingsTab === target);
    }
    for (const tab of tabs) {
      tab.classList.toggle("active", tab.dataset.settingsPanel === target);
    }

    if (target === "usage") loadUsage();
    if (target === "extensions") void packageBrowse.load();
    if (target === "skills") void skillsPage.activate();
    if (target === "configuration") loadConfiguration();
  }

  function buildThemeGrid() {
    if (!themeGrid) return;
    themeGrid.replaceChildren();
    const current = getCurrentTheme();
    for (const [id, theme] of Object.entries(themes)) {
      const btn = document.createElement("button");
      btn.className = `theme-swatch${current === id ? " active" : ""}`;
      const colors = document.createElement("span");
      colors.className = "swatch-colors";
      for (const color of theme.colors || []) {
        const dot = document.createElement("span");
        dot.className = "swatch-dot";
        dot.style.background = color;
        colors.append(dot);
      }
      btn.append(colors);
      btn.addEventListener("click", () => {
        applyTheme(id);
        for (const swatch of themeGrid.querySelectorAll(".theme-swatch")) {
          swatch.classList.remove("active");
        }
        btn.classList.add("active");
      });
      themeGrid.append(btn);
    }
  }

  async function loadPiVersion() {
    if (!piVersionValue) return;
    piVersionValue.textContent = t("migrated.native.settings.settingsConfig.textcontent.loading");
    try {
      const response = await fetch("/health");
      const health = await response.json();
      piVersionValue.textContent = health?.piVersion || "Unavailable";
    } catch {
      piVersionValue.textContent = t("sidebar.unavailable");
    }
  }

  async function loadAppVersion() {
    if (!appVersionValue) return;
    try {
      const version = await globalThis.__TAURI__?.app?.getVersion?.();
      appVersionValue.textContent = version ? `v${version}` : "Unavailable";
    } catch {
      appVersionValue.textContent = t("sidebar.unavailable");
    }
  }

  // Persist "settings is open, on tab X" to the URL hash (independent of the
  // path-based session route) so a page refresh — or opening a link that
  // still has the hash from before a reload — reopens the same settings tab
  // instead of silently dropping back to the chat view.
  function normalizeSettingsTabKey(tabKey) {
    const rawTabKey = typeof tabKey === "string" ? tabKey : "general";
    const decodedTabKey = decodeURIComponent(rawTabKey || "general");
    const normalizedTabKey = decodedTabKey === "auth" ? "configuration" : decodedTabKey;
    return validTabKeys.has(normalizedTabKey) ? normalizedTabKey : "general";
  }

  function settingsHashForTab(tabKey) {
    return `#/settings/${encodeURIComponent(normalizeSettingsTabKey(tabKey))}`;
  }

  function updateSettingsHash(tabKey) {
    const nextHash = settingsHashForTab(tabKey);
    if (window.location.hash === nextHash) return;
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${nextHash}`,
    );
  }

  function clearSettingsHash() {
    if (!window.location.hash.startsWith("#/settings")) return;
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }

  function openSettings(tabKey = "general", { updateHash = true } = {}) {
    const normalizedTabKey = normalizeSettingsTabKey(tabKey);
    if (updateHash) updateSettingsHash(normalizedTabKey);
    panel.classList.remove("hidden");
    selectTab(normalizedTabKey);
    buildThemeGrid();
    void loadPiVersion();
    void loadAppVersion();
  }

  function closeSettings({ clearHash = true } = {}) {
    if (clearHash) clearSettingsHash();
    panel.classList.add("hidden");
  }

  function restoreFromHash() {
    const route = window.location.hash.slice(1);
    if (route === "/settings" || route.startsWith("/settings/")) {
      const tabKey = route.split("/")[2] || "general";
      openSettings(tabKey, { updateHash: false });
      return;
    }
    if (!panel.classList.contains("hidden")) closeSettings({ clearHash: false });
  }

  openBtn.addEventListener("click", () => openSettings());
  closeBtn?.addEventListener("click", () => closeSettings());
  overlay?.addEventListener("click", () => closeSettings());
  for (const item of navItems) {
    item.addEventListener("click", () => {
      selectTab(item.dataset.settingsTab);
      updateSettingsHash(item.dataset.settingsTab);
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.classList.contains("hidden")) closeSettings();
  });
  window.addEventListener("hashchange", restoreFromHash);
  restoreFromHash();

  return { openSettings, closeSettings, thinkingControl };
}
