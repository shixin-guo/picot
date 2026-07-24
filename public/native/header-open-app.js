const STORAGE_KEY = "picot-open-app";

const MONOGRAMS = {
  vscode: "VS",
  cursor: "C",
  webstorm: "WS",
  zed: "Z",
  terminal: "T",
  ghostty: "G",
  finder: "F",
};

const ICONS = {
  vscode: "icons/app-vscode.png",
  cursor: "icons/app-cursor.svg",
  webstorm: "icons/app-webstorm.svg",
  zed: "icons/app-zed.png",
  terminal: "icons/app-terminal.svg",
  ghostty: "icons/app-ghostty.png",
  finder: "icons/app-finder.png",
};

function renderLogo(app) {
  const icon = ICONS[app?.id];
  if (icon) return `<img src="${icon}" alt="" class="header-open-app-logo-img">`;
  const label = MONOGRAMS[app?.id] || app?.label?.slice(0, 1).toUpperCase() || "•";
  return `<span class="header-open-app-logo-text">${label}</span>`;
}

function reportError(onError, error) {
  onError?.(error instanceof Error ? error : new Error(String(error)));
}

/**
 * Wire the header split button that opens the current workspace in an external
 * editor/app (VS Code, Cursor, Finder, Terminal, ...).
 *
 * @param {object} options
 * @param {import('./data-gateway.js').HostDataGateway} options.data
 * @param {import('./control-gateway.js').HostControlGateway} options.control
 * @param {string} options.workspaceId
 * @param {(error: Error) => void} [options.onError]
 * @returns {boolean}
 */
export function setupHeaderOpenApp({ data, control, workspaceId, onError } = {}) {
  const root = document.getElementById("header-open-app");
  const button = document.getElementById("header-open-app-btn");
  const logo = document.getElementById("header-open-app-logo");
  const toggle = document.getElementById("header-open-app-toggle");
  const menu = document.getElementById("header-open-app-menu");
  if (!root || !button || !logo || !toggle || !menu) return false;

  const state = {
    apps: [],
    path: "",
    selectedId: localStorage.getItem(STORAGE_KEY) || null,
  };

  const selectedApp = () =>
    state.apps.find((app) => app.id === state.selectedId) || state.apps[0] || null;

  const refresh = () => {
    const app = selectedApp();
    if (!state.path || !app || state.apps.length === 0) {
      root.classList.add("hidden");
      return;
    }
    root.classList.remove("hidden");
    logo.innerHTML = renderLogo(app);
    button.title = `Open ${state.path} in ${app.label}`;
    button.setAttribute("aria-label", `Open workspace in ${app.label}`);
  };

  const closeMenu = () => menu.classList.add("hidden");

  const openWorkspace = async (app = selectedApp()) => {
    if (!app || !state.path) return;
    state.selectedId = app.id;
    localStorage.setItem(STORAGE_KEY, app.id);
    refresh();
    try {
      await control.openInApp(state.path, {
        appName: app.appName ?? null,
        command: app.command ?? null,
      });
    } catch (error) {
      reportError(onError, error);
    }
  };

  const renderMenu = () => {
    menu.innerHTML = "";
    for (const app of state.apps) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "header-open-app-menu-item";
      if (app.id === state.selectedId) item.classList.add("active");
      item.title = `Open in ${app.label}`;
      item.setAttribute("aria-label", `Open in ${app.label}`);
      item.innerHTML = `<span class="header-open-app-logo" aria-hidden="true">${renderLogo(app)}</span><span>${app.label}</span>`;
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        closeMenu();
        openWorkspace(app);
      });
      menu.appendChild(item);
    }
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    openWorkspace();
  });
  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.classList.contains("hidden")) {
      renderMenu();
      menu.classList.remove("hidden");
    } else {
      closeMenu();
    }
  });
  document.addEventListener("click", closeMenu);

  Promise.all([data.workspaceInfo(workspaceId), control.listInstalledApps()])
    .then(([workspace, apps]) => {
      state.path = workspace?.info?.path || "";
      state.apps = Array.isArray(apps) ? apps : [];
      if (!state.apps.some((app) => app.id === state.selectedId)) {
        state.selectedId = state.apps[0]?.id || null;
      }
      refresh();
    })
    .catch((error) => {
      root.classList.add("hidden");
      reportError(onError, error);
    });

  return true;
}
