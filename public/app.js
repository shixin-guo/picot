/**
 * Main App - Ties everything together
 */

import { setupContextViz } from "./app-context-viz.js";
import { setupSettingsEditors } from "./app-settings-editors.js";
import { setupSettingsToggles } from "./app-settings-toggles.js";
import { createAppUpdater } from "./app-updater.js";
import { setupVoiceInput } from "./app-voice-input.js";
import { DialogHandler } from "./dialogs.js";
import { FileBrowser } from "./file-browser.js";
import { anchorHistoryToBottom } from "./history-scroll-anchor.js";
import {
  getLanguagePreference,
  initI18n,
  LANGUAGES,
  onLocaleChange,
  setLocale,
  t,
} from "./i18n.js";
import { processImageFile, processImagePayload } from "./image-attachments.js";
import { setupMessagesInsets } from "./layout-insets.js";
import { MessageRenderer } from "./message-renderer.js";
import { resolveNewSessionLiveFile } from "./new-session-refresh.js";
import { getOnboardingState } from "./onboarding-state.js";
import { renderPackageInstallFailure } from "./package-install-status.js";
import { findPortForSession, getWorkspacePathForPort } from "./session-routing.js";
import { SessionSidebar } from "./session-sidebar.js";
import {
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./settings-save-status.js";
import { createSidebarResizer } from "./sidebar-resizer.js";
import { setupSidebarSearchControl } from "./sidebar-search-control.js";
import { StateManager } from "./state.js";
import { applyTheme, getCurrentTheme, themes } from "./themes.js";
import { ToolCardRenderer } from "./tool-card.js";
import { initTransport } from "./transport.js";
import { resolveWebSocketUrl, WebSocketClient } from "./websocket-client.js";
import {
  openFolderAsWorkspace,
  startInWindowNewSession,
  startNewProjectChat,
} from "./workspace-actions.js";

const fetchInstances = async () => {
  try {
    const res = await fetch("/api/instances");
    if (!res.ok) return [];
    const data = await res.json();
    return data.instances || [];
  } catch {
    return [];
  }
};
const getCurrentPort = () => {
  const fromTransport = transport?.currentPort?.();
  if (typeof fromTransport === "number") return fromTransport;
  const fromLocation = Number(location.port);
  return Number.isFinite(fromLocation) && fromLocation > 0 ? fromLocation : 47821;
};
const mobileClientMode = new URLSearchParams(window.location.search).get("mobile") === "1";
const navigateInWindow = (url) => {
  let target = url;
  if (mobileClientMode) {
    try {
      const nextUrl = new URL(url, window.location.href);
      nextUrl.searchParams.set("mobile", "1");
      target = nextUrl.toString();
    } catch {}
  }
  window.location.href = target;
};

// ──────────────────────────────────────────────────────────────────────
// Instance-swap overlay
// ──────────────────────────────────────────────────────────────────────
// `+ New Session`, `start new chat`, `Open Project`, and `Open Folder`
// all end with `window.location.href = http://<current-host>:<newPort>/`,
// which is a full-page navigation and would otherwise show a 1–2s
// freeze (while pi spawns) and then a white flash (while the WebView
// reloads). To make this look like a single smooth transition we:
//
//   1. Open a fullscreen spinner overlay BEFORE awaiting openWorkspace.
//   2. Persist a sessionStorage flag so the new page boots into the
//      same overlay (see <head> bootstrap script in index.html).
//   3. After the new page's WebSocket first connects, fade out.
//
// Returns a `dismiss` function that rolls back the overlay if the
// swap fails before navigation (e.g. openWorkspace rejects).
function showSwapOverlay(label) {
  try {
    sessionStorage.setItem("pi-studio:swapping-instance", "1");
  } catch {}
  document.body.classList.add("swapping-instance");
  const overlay = document.getElementById("instance-swap-overlay");
  if (overlay) overlay.setAttribute("data-visible", "true");
  const labelEl = document.getElementById("instance-swap-overlay-label");
  if (labelEl && typeof label === "string" && label) labelEl.textContent = label;
  return hideSwapOverlay;
}

function hideSwapOverlay() {
  try {
    sessionStorage.removeItem("pi-studio:swapping-instance");
  } catch {}
  document.body.classList.remove("swapping-instance");
  const overlay = document.getElementById("instance-swap-overlay");
  if (overlay) overlay.setAttribute("data-visible", "false");
}

// Returned to workspace-actions.js — they call this BEFORE openWorkspace
// (so the overlay covers spawn latency) and the returned dismiss is only
// invoked on error (success path lets the overlay persist across the
// navigation boundary).
const onBeforeInstanceSwap = (label) => showSwapOverlay(label);

// If the page booted into the overlay (because we just navigated from
// a previous instance), fade it out as soon as the WebSocket reaches
// the new pi. The post-connect wait avoids a brief flash of empty
// chat UI before /api/sessions and get_state finish populating things.
function dismissBootSwapOverlayWhenReady() {
  if (!document.body.classList.contains("swapping-instance")) return;
  const fade = () => {
    requestAnimationFrame(() => {
      const overlay = document.getElementById("instance-swap-overlay");
      if (overlay) overlay.setAttribute("data-visible", "false");
      document.body.classList.remove("swapping-instance");
      try {
        sessionStorage.removeItem("pi-studio:swapping-instance");
      } catch {}
    });
  };
  const alreadyOpen = wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN;
  if (alreadyOpen) {
    fade();
  } else {
    const onConnect = () => {
      wsClient.removeEventListener("connected", onConnect);
      fade();
    };
    wsClient.addEventListener("connected", onConnect);
  }
  setTimeout(() => {
    if (document.body.classList.contains("swapping-instance")) hideSwapOverlay();
  }, 5000);
}

// Initialize components
const wsUrl = resolveWebSocketUrl(window);
const wsClient = new WebSocketClient(wsUrl);
// Unified control transport: every process/window lifecycle + native op goes
// through the broker WebSocket (broker_control). No Tauri IPC hooks — the
// desktop WebView, a remote client, and a mobile client all use the same API.
// Native-only ops are gated on
// `transport.capabilities.native` (advertised by the broker handshake).
const transport = initTransport({ wsClient, env: window });
// True once the broker advertises a native (OS/window) control handler — i.e.
// we're attached to the desktop host. Drives native-only UI gating. Starts
// false and flips when the `capabilities` frame arrives (see listener below).
// `?mobile=1` is a browser client even if it reaches the desktop broker, so it
// must not use native workspace/window controls.
const nativeAvailable = () => !mobileClientMode && transport.capabilities.native;
const canUseSessionControl = () => transport.capabilities.native;
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById("messages"));
const toolCardRenderer = new ToolCardRenderer(document.getElementById("messages"));
const dialogHandler = new DialogHandler(document.getElementById("dialog-container"), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById("session-list"),
  handleSessionSelect,
  handleNewProjectChat,
  { onOpenProject: () => handleOpenFolder() },
);

// UI elements
const messageInput = document.getElementById("message-input");
const chatForm = document.getElementById("chat-form");
const sendBtn = document.getElementById("send-btn");
const abortBtn = document.getElementById("abort-btn");
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const openFolderBtn = document.getElementById("open-folder-btn");
const sidebarEl = document.getElementById("sidebar");
const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebarOverlay = document.getElementById("sidebar-overlay");

const refreshSessionsBtn = document.getElementById("refresh-sessions-btn");
const sessionSearchInput = document.getElementById("session-search-input");
const sessionSearchClearBtn = document.getElementById("session-search-clear");
const typingIndicator = document.getElementById("typing-indicator");

const sessionCostEl = document.getElementById("session-cost");
const tokenUsageEl = document.getElementById("token-usage");
const scrollBottomBtn = document.getElementById("scroll-bottom-btn");
const scrollBottomBadge = document.getElementById("scroll-bottom-badge");
const messagesContainer = document.getElementById("messages");
const mainContainer = document.querySelector(".main");
const headerEl = document.querySelector(".header");
const inputAreaEl = document.querySelector(".input-area");

headerEl?.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest("button, a, input, select, textarea, [role=button]")) return;
  window.__TAURI__?.window?.getCurrentWindow().startDragging();
});

setupMessagesInsets({
  main: mainContainer,
  messages: messagesContainer,
  header: headerEl,
  inputArea: inputAreaEl,
});

// State tracking
let currentStreamingElement = null;
let currentStreamingText = "";
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0; // fetched from model info
const originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Picot instances [{port, sessionFile, cwd}]
let workspaceLaunchInProgress = false;
// When true, the next foreground message lifecycle events should reload the
// sidebar until the newly persisted session file appears in the list.
let pendingNewSessionRefresh = false;
let pendingNewSessionPreviousFile = null;
// When set while streaming, holds the session filePath to switch to once the
// current agent run ends. The history is rendered immediately; pi gets the
// switch_session RPC only after agent_end so the running call is not aborted.
let pendingSessionSwitchPath = null;
let sessionsLoaded = false;
// Serializes handleSessionSelect: the function is a long async sequence that
// mutates shared routing state (foregroundPort, mirrorActiveSessionFile,
// viewingActiveSession, pendingSessionSwitchPath). Two overlapping invocations
// (fast double-click on different sessions) would interleave their awaits and
// corrupt that state, so a second call queues behind the first.
let sessionSelectChain = Promise.resolve();
let deferredMirrorSync = null;
let lastRenderedWelcomeWorkspacePath = null;
// Maps port -> sessionFile for each pi process we're tracking
const portSessionMap = new Map();
// The port that wsClient is currently connected to (the "foreground" session)
let foregroundPort = getCurrentPort();
let foregroundWorkspacePath = "";
const getActivePort = () => foregroundPort;
function logSessionRoute(label, details = {}) {
  console.debug(`[Session route] ${label}`, {
    foregroundPort,
    activeSessionFile: sidebar?.activeSessionFile || null,
    mirrorActiveSessionFile,
    viewingActiveSession,
    isStreaming: state?.isStreaming,
    wsSessionId: wsClient?.sessionId || null,
    wsSourcePort: wsClient?.sourcePort || null,
    ...details,
  });
}
wsClient.setRoutingContext({
  workspaceId: `workspace:${getCurrentWorkspacePath() || "unknown"}`,
  sourcePort: foregroundPort,
});

const workspaceIndicatorEl = document.createElement("div");
workspaceIndicatorEl.id = "workspace-indicator";
workspaceIndicatorEl.className = "pill workspace-indicator hidden";
workspaceIndicatorEl.title = "";
document
  .querySelector(".header-right")
  ?.insertBefore(workspaceIndicatorEl, document.querySelector("#context-viz"));

const gitBranchEl = document.createElement("div");
gitBranchEl.id = "git-branch-indicator";
gitBranchEl.className = "pill git-branch-indicator hidden";
gitBranchEl.title = "Current git branch";
document
  .querySelector(".header-right")
  ?.insertBefore(gitBranchEl, document.querySelector("#context-viz"));

function updateGitBranchIndicator(branch = "") {
  const name = typeof branch === "string" ? branch.trim() : "";
  if (!name) {
    gitBranchEl.classList.add("hidden");
    gitBranchEl.textContent = "";
    return;
  }
  gitBranchEl.classList.remove("hidden");
  gitBranchEl.textContent = name;
  gitBranchEl.title = `Branch: ${name}`;
}

async function refreshGitBranch() {
  try {
    const params = new URLSearchParams();
    if (typeof foregroundPort === "number" && Number.isFinite(foregroundPort)) {
      params.set("foregroundPort", String(foregroundPort));
    }
    const res = await fetch(`/api/git-branch${params.size ? `?${params.toString()}` : ""}`);
    if (!res.ok) {
      updateGitBranchIndicator("");
      return;
    }
    const data = await res.json();
    updateGitBranchIndicator(data?.branch || "");
  } catch {
    updateGitBranchIndicator("");
  }
}

function updateWorkspaceIndicator(path = "") {
  const normalizedPath = typeof path === "string" ? path.trim() : "";
  if (!normalizedPath) {
    workspaceIndicatorEl.classList.add("hidden");
    workspaceIndicatorEl.textContent = "";
    workspaceIndicatorEl.title = "";
    if (typeof refreshHeaderOpenAppButton === "function") refreshHeaderOpenAppButton();
    return;
  }
  workspaceIndicatorEl.classList.remove("hidden");
  workspaceIndicatorEl.textContent = normalizedPath;
  workspaceIndicatorEl.title = normalizedPath;
  if (typeof refreshHeaderOpenAppButton === "function") refreshHeaderOpenAppButton();
}

function syncWorkspaceIndicatorFromInstances() {
  const workspacePath = getWorkspacePathForPort(liveInstances, foregroundPort);
  if (workspacePath) foregroundWorkspacePath = workspacePath;
  updateWorkspaceIndicator(workspacePath || foregroundWorkspacePath);
  refreshFileBrowserForWorkspace(workspacePath || foregroundWorkspacePath);
  refreshGitBranch();
}

function getCurrentWorkspacePath() {
  return getWorkspacePathForPort(liveInstances, foregroundPort) || foregroundWorkspacePath;
}

function workspacePathFromId(workspaceId) {
  if (typeof workspaceId !== "string") return "";
  return workspaceId.startsWith("workspace:") ? workspaceId.slice("workspace:".length) : "";
}

function renderWorkspaceWelcome({ force = false } = {}) {
  const workspacePath = getCurrentWorkspacePath();
  const welcomeVisible = Boolean(document.querySelector(".welcome"));
  if (!force && welcomeVisible && lastRenderedWelcomeWorkspacePath === workspacePath) {
    return;
  }
  messageRenderer.renderWelcome({ workspacePath });
  lastRenderedWelcomeWorkspacePath = workspacePath;
}

function hasAnySessionsLoaded() {
  return (
    Array.isArray(sidebar.projects) &&
    sidebar.projects.some(
      (project) => Array.isArray(project.sessions) && project.sessions.length > 0,
    )
  );
}

function setWorkspaceLaunchInProgress(inProgress) {
  workspaceLaunchInProgress = inProgress;
  if (openFolderBtn) {
    openFolderBtn.disabled = inProgress;
    openFolderBtn.setAttribute("aria-busy", inProgress ? "true" : "false");
    openFolderBtn.title = inProgress ? "Opening workspace..." : "Open folder as workspace";
  }
}

// File browser
const fileSidebar = document.getElementById("file-sidebar");
const fileSidebarToggle = document.getElementById("file-sidebar-toggle");
const fileSidebarClose = document.getElementById("file-sidebar-close");
const fileSidebarUp = document.getElementById("file-sidebar-up");
const fileList = document.getElementById("file-list");
const fileSidebarPath = document.getElementById("file-sidebar-path");
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput);
let fileBrowserWorkspacePath = null;

function refreshFileBrowserForWorkspace(path = getCurrentWorkspacePath(), { force = false } = {}) {
  const normalized = typeof path === "string" ? path.trim() : "";
  if (!force && normalized === fileBrowserWorkspacePath) return;
  fileBrowserWorkspacePath = normalized;

  const isCollapsed = fileSidebar.classList.contains("collapsed");
  if (isCollapsed && !force) {
    fileBrowser.setWorkspaceRoot(normalized);
    return;
  }
  fileBrowser.load(normalized || undefined);
}

fileSidebarToggle.addEventListener("click", () => {
  const isCollapsed = fileSidebar.classList.toggle("collapsed");
  if (!isCollapsed) {
    refreshFileBrowserForWorkspace(getCurrentWorkspacePath(), { force: true });
  }
  localStorage.setItem("pi-studio-file-sidebar", isCollapsed ? "closed" : "open");
});

fileSidebarClose.addEventListener("click", () => {
  fileSidebar.classList.add("collapsed");
  localStorage.setItem("pi-studio-file-sidebar", "closed");
});

fileSidebarUp.addEventListener("click", () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

document.getElementById("file-sidebar-finder").addEventListener("click", () => {
  if (fileBrowser.currentPath) {
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// ═══════════════════════════════════════
// "Open workspace in app" header control (VS Code / Cursor / Terminal / …)
// Mirrors the Codex-style split button in the chat header.
// ═══════════════════════════════════════
const HEADER_OPEN_APP_STORAGE_KEY = "pi-studio-open-app";
const HEADER_OPEN_APP_MONOGRAMS = {
  vscode: "VS",
  cursor: "C",
  webstorm: "WS",
  zed: "Z",
  terminal: "T",
  ghostty: "G",
  finder: "F",
};
const HEADER_OPEN_APP_ICONS = {
  vscode: "icons/app-vscode.png",
  cursor: "icons/app-cursor.svg",
  webstorm: "icons/app-webstorm.svg",
  zed: "icons/app-zed.png",
  terminal: "icons/app-terminal.svg",
  ghostty: "icons/app-ghostty.png",
  finder: "icons/app-finder.png",
};
const headerOpenApp = {
  el: document.getElementById("header-open-app"),
  btn: document.getElementById("header-open-app-btn"),
  logo: document.getElementById("header-open-app-logo"),
  toggle: document.getElementById("header-open-app-toggle"),
  menu: document.getElementById("header-open-app-menu"),
  apps: [],
  selectedId: localStorage.getItem(HEADER_OPEN_APP_STORAGE_KEY) || null,
};

function getSelectedOpenApp() {
  return (
    headerOpenApp.apps.find((a) => a.id === headerOpenApp.selectedId) ||
    headerOpenApp.apps[0] ||
    null
  );
}

function openAppMonogram(app) {
  if (!app?.id) return "•";
  return HEADER_OPEN_APP_MONOGRAMS[app.id] || app.label?.slice(0, 1).toUpperCase() || "•";
}

function openAppIconPath(app) {
  if (!app?.id) return "";
  return HEADER_OPEN_APP_ICONS[app.id] || "";
}

function renderOpenAppLogo(app) {
  const icon = openAppIconPath(app);
  const monogram = openAppMonogram(app);
  if (icon) {
    return `<img src="${icon}" alt="" class="header-open-app-logo-img">`;
  }
  return `<span class="header-open-app-logo-text">${monogram}</span>`;
}

function refreshHeaderOpenAppButton() {
  if (!headerOpenApp.el) return;
  const hasNative = nativeAvailable();
  const path = getCurrentWorkspacePath();
  const selected = getSelectedOpenApp();
  if (!hasNative || !selected || !path || headerOpenApp.apps.length === 0) {
    headerOpenApp.el.classList.add("hidden");
    return;
  }
  headerOpenApp.el.classList.remove("hidden");
  if (headerOpenApp.logo) headerOpenApp.logo.innerHTML = renderOpenAppLogo(selected);
  headerOpenApp.btn.title = `Open ${path} in ${selected.label}`;
  headerOpenApp.btn.setAttribute("aria-label", `Open workspace in ${selected.label}`);
}

async function openWorkspaceInApp(app) {
  const target = app || getSelectedOpenApp();
  const path = getCurrentWorkspacePath();
  if (!nativeAvailable() || !target || !path) return;
  headerOpenApp.selectedId = target.id;
  localStorage.setItem(HEADER_OPEN_APP_STORAGE_KEY, target.id);
  refreshHeaderOpenAppButton();
  try {
    await transport.openInApp(path, {
      appName: target.appName ?? null,
      command: target.command ?? null,
    });
  } catch (err) {
    console.error("[Header] Failed to open workspace in app:", err);
  }
}

function closeHeaderOpenAppMenu() {
  if (headerOpenApp.menu) headerOpenApp.menu.classList.add("hidden");
}

function toggleHeaderOpenAppMenu() {
  if (!headerOpenApp.menu) return;
  if (!headerOpenApp.menu.classList.contains("hidden")) {
    closeHeaderOpenAppMenu();
    return;
  }
  headerOpenApp.menu.innerHTML = "";
  for (const app of headerOpenApp.apps) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "header-open-app-menu-item";
    if (app.id === headerOpenApp.selectedId) row.classList.add("active");
    row.title = `Open in ${app.label}`;
    row.setAttribute("aria-label", `Open in ${app.label}`);
    row.innerHTML = `<span class="header-open-app-logo" aria-hidden="true">${renderOpenAppLogo(app)}</span><span>${app.label}</span>`;
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      closeHeaderOpenAppMenu();
      void openWorkspaceInApp(app);
    });
    headerOpenApp.menu.appendChild(row);
  }
  headerOpenApp.menu.classList.remove("hidden");
}

async function loadHeaderOpenApps() {
  if (!nativeAvailable()) return;
  try {
    const apps = await transport.listInstalledApps();
    headerOpenApp.apps = Array.isArray(apps) ? apps : [];
    if (!headerOpenApp.apps.some((a) => a.id === headerOpenApp.selectedId)) {
      headerOpenApp.selectedId = headerOpenApp.apps[0]?.id || null;
    }
    refreshHeaderOpenAppButton();
  } catch (err) {
    console.error("[Header] Failed to load installed apps:", err);
  }
}

if (headerOpenApp.btn) {
  headerOpenApp.btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void openWorkspaceInApp();
  });
}
if (headerOpenApp.toggle) {
  headerOpenApp.toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHeaderOpenAppMenu();
  });
}
document.addEventListener("click", () => closeHeaderOpenAppMenu());
void loadHeaderOpenApps();

// Restore file sidebar state
if (localStorage.getItem("pi-studio-file-sidebar") === "open") {
  fileSidebar.classList.remove("collapsed");
  refreshFileBrowserForWorkspace(getCurrentWorkspacePath(), { force: true });
}

// Resizable sidebars — drag handle on inner edge, persisted to localStorage.
createSidebarResizer({
  sidebarEl,
  side: "left",
  storageKey: "picot-sidebar-width",
  minWidth: 200,
  maxWidth: 500,
});
createSidebarResizer({
  sidebarEl: fileSidebar,
  side: "right",
  storageKey: "picot-file-sidebar-width",
  minWidth: 200,
  maxWidth: 500,
});

// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener("focus", () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});

window.addEventListener("blur", () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log("[App] Returning to app, reconnecting...");
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener("scroll", () => {
  const threshold = 150;
  const atBottom =
    messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight <
    threshold;
  isScrolledUp = !atBottom;

  if (atBottom) {
    scrollBottomBtn.classList.add("hidden");
    scrollBottomBadge.classList.add("hidden");
  } else {
    scrollBottomBtn.classList.remove("hidden");
  }
});

scrollBottomBtn.addEventListener("click", () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: "smooth" });
  scrollBottomBtn.classList.add("hidden");
  scrollBottomBadge.classList.add("hidden");
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    scrollBottomBadge.classList.remove("hidden");
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener("connected", () => {
  updateConnectionStatus("connected");
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);
});

wsClient.addEventListener("disconnected", () => {
  updateConnectionStatus("disconnected");
  sidebar.clearStreaming();

  // Deferred session switch requires agent_end to complete, which won't fire
  // after a crash/disconnect. Unblock input immediately so the user isn't stuck.
  if (pendingSessionSwitchPath) {
    pendingSessionSwitchPath = null;
    updateUI();
  }

  // If the streaming state is still true 3 s after disconnect (pi likely
  // crashed — agent_end won't re-fire after reconnect), unlock the UI.
  // Brief intentional reconnects (Case 1 session switch) complete in < 100 ms
  // so they are unaffected by the 3-second gate.
  setTimeout(() => {
    if (wsClient.connectionState !== "open" && state.isStreaming) {
      state.setStreaming(false);
      showTypingIndicator(false);
      updateUI();
    }
  }, 3000);
});

wsClient.addEventListener("reconnectFailed", () => {
  updateConnectionStatus("disconnected");
  messageRenderer.renderError("Connection lost. Please refresh the page.");
});

wsClient.addEventListener("rpcEvent", (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener("serverError", (e) => {
  messageRenderer.renderError(e.detail.message);
});

// The broker could not deliver a command to any live pi process. For a tracked
// prompt this means the user's message was dropped — surface it, clear the
// optimistic streaming/typing state, and restore the text so it isn't lost.
wsClient.addEventListener("commandUndeliverable", (e) => {
  const { requestId, reason, command } = e.detail || {};
  const pending = requestId ? inFlightPrompts.get(requestId) : null;
  if (!pending) {
    console.warn("[WS] command undeliverable:", { command, reason, requestId });
    return;
  }
  clearTimeout(pending.timer);
  inFlightPrompts.delete(requestId);
  state.setStreaming(false);
  showTypingIndicator(false);
  const detail =
    reason === "no_route"
      ? "no running session to receive it"
      : "the session process is no longer reachable";
  messageRenderer.renderError(
    `Message not delivered (${detail}). The session may have closed — start a new chat or try again.`,
  );
  if (pending.message && !messageInput.value.trim()) {
    messageInput.value = pending.message;
    messageInput.style.height = "auto";
  }
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener("mirrorSync", (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  const eventSessionFile = event?.__broker?.sessionId || null;
  const eventSourcePort = event?.__broker?.sourcePort ?? null;

  // Port-based guard: the broker broadcasts every upstream's events to all UI
  // clients, so an event from a *different* pi process (e.g. the previous
  // session that is still streaming after the user started a new parallel
  // session) must never render into the foreground UI. A brand-new session
  // has no session file yet, so the sessionId guard below can't catch this —
  // the source port is the only reliable discriminator at that moment.
  if (
    typeof eventSourcePort === "number" &&
    typeof foregroundPort === "number" &&
    eventSourcePort !== foregroundPort
  ) {
    if (eventSessionFile) handleBackgroundRPCEvent(eventSessionFile, event);
    return;
  }

  if (
    eventSessionFile &&
    sidebar.activeSessionFile &&
    eventSessionFile !== sidebar.activeSessionFile
  ) {
    handleBackgroundRPCEvent(eventSessionFile, event);
    return;
  }

  // While the user is previewing a different session, suppress all live
  // rendering so the history view isn't overwritten by streaming output.
  // agent_end still needs to fire so we can complete the deferred switch.
  if (pendingSessionSwitchPath && event.type !== "agent_end") return;

  switch (event.type) {
    case "agent_start":
      handleAgentStart(event);
      break;
    case "agent_end":
      handleAgentEnd(event);
      if (pendingNewSessionRefresh) {
        refreshSidebarForNewSession(event).catch(() => {});
      }
      break;
    case "message_start":
      handleMessageStart(event.message);
      // Refresh the sidebar as soon as the new session is persisted. Pi writes
      // the brand-new session's .jsonl on the first user message round-trip, so
      // refreshing on the user message (not just the assistant turn) makes the
      // session — with its first message as the title — show up immediately.
      if (pendingNewSessionRefresh) {
        refreshSidebarForNewSession(event).catch(() => {});
        pollInstances().catch(() => {});
      }
      break;
    case "message_update":
      handleMessageUpdate(event);
      break;
    case "message_end":
      handleMessageEnd(event.message);
      if (pendingNewSessionRefresh) {
        refreshSidebarForNewSession(event).catch(() => {});
      }
      break;
    case "tool_execution_start":
      handleToolExecutionStart(event);
      break;
    case "tool_execution_update":
      handleToolExecutionUpdate(event);
      break;
    case "tool_execution_end":
      handleToolExecutionEnd(event);
      break;
    case "auto_compaction_start":
      handleCompactionStart();
      break;
    case "auto_compaction_end":
      handleCompactionEnd(event);
      break;
    case "extension_ui_request":
      handleExtensionUIRequest(event);
      break;
    case "extension_error":
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case "session_name":
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector(".session-item.active .session-title");
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleBackgroundRPCEvent(sessionFile, event) {
  switch (event.type) {
    case "agent_start":
      sidebar.setStreaming(sessionFile, true);
      break;
    case "agent_end":
      sidebar.setStreaming(sessionFile, false);
      sidebar.markUnread(sessionFile);
      sidebar.loadSessions({ quiet: true }).catch(() => {});
      pollInstances().catch(() => {});
      break;
    case "message_end":
      sidebar.markUnread(sessionFile);
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement("div");
  el.className = "system-message compaction-message";
  el.id = "compaction-indicator";
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById("compaction-indicator");
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : "";
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add("compaction-done");
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

/**
 * Refresh the sidebar after a brand-new session's first message round-trips.
 *
 * Pi only persists a new session's .jsonl on the first message round-trip, and
 * `/api/sessions` can briefly return *successfully* without the new file yet
 * (loadSessions' built-in retry only covers fetch failures, not "fetched but
 * the row isn't there"). So we reload, and if the freshly created session still
 * isn't in the list, retry a few times with a short backoff before giving up.
 */
async function refreshSidebarForNewSession(event = null, attempt = 0) {
  const projects = await sidebar.loadSessions({ quiet: true }).catch(() => null);

  const liveFile = getCurrentLiveSessionFile(event);
  if (liveFile) {
    // Read the result this call actually fetched (not sidebar.projects, which a
    // concurrent load could leave stale) so we detect the new session as soon as
    // any fetch observes it on disk.
    const found = (projects || sidebar.projects).some((p) =>
      p.sessions.some((s) => s.filePath === liveFile),
    );
    if (found) {
      sidebar.setActive(liveFile);
      pendingNewSessionRefresh = false;
      pendingNewSessionPreviousFile = null;
      return;
    }
  }

  if (attempt < 4) {
    await pollInstances().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    return refreshSidebarForNewSession(event, attempt + 1);
  }
}

function getCurrentLiveSessionFile(event = null) {
  return resolveNewSessionLiveFile({
    event,
    liveInstances,
    foregroundPort,
    mirrorActiveSessionFile,
    excludedSessionFile: pendingNewSessionPreviousFile,
  });
}

function handleAgentStart(event = null) {
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
  const live = getCurrentLiveSessionFile(event);
  if (live) sidebar.setStreaming(live, true);
}

function handleAgentEnd(event = null) {
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = "";
  updateUI();

  // Deferred session switch: user clicked a history session while streaming.
  // Now that the agent run is done, tell pi to switch — no abort needed.
  if (pendingSessionSwitchPath) {
    const targetPath = pendingSessionSwitchPath;
    pendingSessionSwitchPath = null;
    const live = getCurrentLiveSessionFile();
    if (live) sidebar.setStreaming(live, false);
    foregroundPort = findPortForSession(liveInstances, targetPath, foregroundPort);
    syncWorkspaceIndicatorFromInstances();
    transport.switchSession(targetPath, foregroundPort).catch((e) => {
      messageRenderer.renderError(`Failed to switch session: ${e}`);
    });
    return;
  }

  const live = getCurrentLiveSessionFile(event);
  if (live) {
    sidebar.setStreaming(live, false);
    // If user is not currently viewing this session in the sidebar,
    // mark it as unread so they see a blue dot when they look back.
    if (live !== sidebar.activeSessionFile) {
      sidebar.markUnread(live);
    }
  }

  // Notify via tab title if unfocused
  if (!hasFocus) {
    unreadCount++;
    document.title = `(${unreadCount}) ● ${originalTitle}`;
  }
}

let currentStreamingThinking = "";

function handleMessageStart(message) {
  if (message.role === "assistant") {
    currentStreamingText = "";
    currentStreamingThinking = "";
    currentStreamingElement = messageRenderer.renderAssistantMessage({ content: "" }, true);
  } else if (message.role === "user") {
    // In mirror mode, user messages from TUI appear via events
    // Only render if we didn't just send this message ourselves
    if (!lastSentMessage || getMessageText(message) !== lastSentMessage) {
      const content = getMessageText(message);
      if (content) {
        messageRenderer.renderUserMessage({ content });
      }
    }
    lastSentMessage = null;
  }
}

function getMessageText(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

function getAssistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function getAssistantThinking(message) {
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((block) => block.type === "thinking")
    .map((block) => block.thinking || "")
    .join("\n");
}

function ensureStreamingAssistantElement(message = null) {
  if (currentStreamingElement) return currentStreamingElement;
  currentStreamingText = getAssistantText(message);
  currentStreamingThinking = getAssistantThinking(message);
  currentStreamingElement = messageRenderer.renderAssistantMessage({ content: "" }, true);
  if (currentStreamingThinking) {
    messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
  }
  if (currentStreamingText) {
    messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
  }
  return currentStreamingElement;
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent, message } = event;
  if (message?.role === "assistant") {
    ensureStreamingAssistantElement(message);
  }

  if (assistantMessageEvent.type === "thinking_delta") {
    currentStreamingThinking =
      getAssistantThinking(message) || currentStreamingThinking + assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === "text_delta") {
    currentStreamingText =
      getAssistantText(message) || currentStreamingText + assistantMessageEvent.delta;
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
    }
  }
}

function handleMessageEnd(message) {
  if (message?.role === "assistant" && message?.stopReason === "error") {
    const provider = message?.provider ? String(message.provider) : "unknown";
    const model = message?.model ? String(message.model) : "unknown";
    const errorMessage = message?.errorMessage
      ? String(message.errorMessage)
      : "Model request failed";
    messageRenderer.renderError(`[${provider}/${model}] ${errorMessage}`);
  }
  if (!currentStreamingElement && message?.role === "assistant") {
    ensureStreamingAssistantElement(message);
  }
  if (currentStreamingElement) {
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(
      currentStreamingElement,
      usage,
      currentStreamingThinking,
    );
    currentStreamingElement = null;
    currentStreamingThinking = "";

    // Track session cost and tokens
    if (usage?.cost?.total) {
      sessionTotalCost += usage.cost.total;
    }
    if (usage?.input) {
      lastInputTokens = usage.input + (usage.cacheRead || 0);
      lastUsage = usage;
    }
    updateCostDisplay();
    updateTokenUsage();
    showNewMessageBadge();
  }
}

function handleToolExecutionStart(event) {
  const { toolCallId, toolName, args } = event;

  state.addToolExecution(toolCallId, {
    toolName,
    args,
    status: "pending",
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: "streaming",
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? "error" : "complete",
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case "select":
      dialogHandler.showSelect(event);
      break;
    case "confirm":
      dialogHandler.showConfirm(event);
      break;
    case "input":
      dialogHandler.showInput(event);
      break;
    case "editor":
      dialogHandler.showEditor(event);
      break;
    case "notify":
      dialogHandler.showNotification(event);
      break;
    default:
      console.warn("[App] Unknown extension UI method:", event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return "";

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === "text") return block.text;
        return JSON.stringify(block);
      })
      .join("\n");
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener("keydown", (e) => {
  // IME composition uses Enter to confirm candidates; never send during composition.
  const isImeComposing = e.isComposing || e.keyCode === 229;
  if (isImeComposing) return;

  // Enter sends, Shift+Enter inserts newline
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener("input", () => {
  messageInput.style.height = "auto";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
});

// ═══════════════════════════════════════
// Image attachment
// ═══════════════════════════════════════

const attachBtn = document.getElementById("attach-btn");
const imageInput = document.getElementById("image-input");
const imagePreviews = document.getElementById("image-previews");
let pendingImages = []; // Array of { data: base64, mimeType: string }

async function addImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const img = await processImageFile(file);
      pendingImages.push(img);
    } catch (e) {
      console.error("[Picot] Image processing failed:", e);
    }
  }
  renderImagePreviews();
}

async function addImagePayloads(payloads) {
  for (const payload of payloads) {
    try {
      const img = await processImagePayload(payload);
      pendingImages.push(img);
    } catch (e) {
      console.error("[Picot] Native image processing failed:", e);
    }
  }
  renderImagePreviews();
}

attachBtn.addEventListener("click", async () => {
  if (!nativeAvailable() || typeof transport.pickImageFiles !== "function") {
    imageInput.click();
    return;
  }
  const workspacePath = getCurrentWorkspacePath();
  try {
    const result = await transport.pickImageFiles(workspacePath || null);
    if (!Array.isArray(result) || result.length === 0) return;
    await addImagePayloads(result);
  } catch (err) {
    console.error("[Picot] Native image picker failed:", err);
    messageRenderer.renderError(`Failed to attach image: ${err}`);
  }
});

imageInput.addEventListener("change", () => {
  addImageFiles(imageInput.files);
  imageInput.value = "";
});

// Drag & drop anywhere on the composer card
const composerCard = document.getElementById("composer-card");
composerCard.addEventListener("dragover", (e) => {
  e.preventDefault();
});
composerCard.addEventListener("drop", (e) => {
  e.preventDefault();
  addImageFiles(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener("paste", (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith("image/")) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addImageFiles(files);
});

function renderImagePreviews() {
  imagePreviews.innerHTML = "";
  if (pendingImages.length === 0) {
    imagePreviews.classList.add("hidden");
    return;
  }
  imagePreviews.classList.remove("hidden");
  pendingImages.forEach((img, i) => {
    const el = document.createElement("div");
    el.className = "image-preview";
    el.innerHTML = `
      <img src="data:${img.mimeType};base64,${img.data}" />
      <button class="image-preview-remove" data-index="${i}">✕</button>
    `;
    el.querySelector(".image-preview-remove").addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImagePreviews();
    });
    imagePreviews.appendChild(el);
  });
}

// ═══════════════════════════════════════
// Send message (with images)
// ═══════════════════════════════════════

let messageQueue = [];

function clearMessageQueue() {
  messageQueue = [];
  renderQueuedMessages();
}

// Prompts are sent fire-and-forget over the WebSocket. The broker replies with
// `command_undeliverable` (correlated by requestId) when it cannot route the
// command to a live pi process. We track in-flight prompt requestIds here so the
// `commandUndeliverable` handler can tell a real dropped prompt apart from
// background/system commands and recover the user's text. Entries self-expire:
// the broker decides deliverability synchronously, so anything not reported
// undeliverable within a few seconds was forwarded successfully.
const inFlightPrompts = new Map();

function trackPromptDelivery(requestId, message) {
  if (!requestId) return;
  const timer = setTimeout(() => inFlightPrompts.delete(requestId), 8000);
  inFlightPrompts.set(requestId, { message, timer });
}

function refreshSidebarAfterUserPrompt() {
  const refresh = () => {
    sidebar.loadSessions({ quiet: true }).catch(() => {});
    pollInstances().catch(() => {});
  };
  refresh();
  setTimeout(refresh, 500);
  setTimeout(refresh, 1500);
}

function sendMessage() {
  if (!currentOnboardingState().canQuery) return;

  const message = messageInput.value.trim();
  if (!message) return;

  messageInput.value = "";
  messageInput.style.height = "auto";

  const cmd = {
    type: "prompt",
    message,
  };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map((img) => {
      console.log(`[Picot] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return {
        type: "image",
        data: img.data,
        mimeType: img.mimeType || "image/png",
      };
    });
    pendingImages = [];
    renderImagePreviews();
  }

  if (state.isStreaming) {
    // Queue it — show as bubble above input
    messageQueue.push(cmd);
    lastSentMessage = message;
    renderQueuedMessages();
    return;
  }

  lastSentMessage = message;
  messageRenderer.renderUserMessage({ content: message, images: cmd.images });
  if (!hasAnySessionsLoaded()) {
    pendingNewSessionRefresh = true;
  }

  trackPromptDelivery(wsClient.send(cmd), message);
  refreshSidebarAfterUserPrompt();
}

const queuedMessagesEl = document.getElementById("queued-messages");

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = "";
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add("hidden");
    return;
  }
  queuedMessagesEl.classList.remove("hidden");
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement("div");
    el.className = "queued-msg";
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector(".queued-msg-cancel").addEventListener("click", () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    if (!hasAnySessionsLoaded()) {
      pendingNewSessionRefresh = true;
    }

    const cmd = messageQueue.shift();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    trackPromptDelivery(wsClient.send(cmd), cmd.message);
    refreshSidebarAfterUserPrompt();
  }
}

abortBtn.addEventListener("click", () => {
  abortCurrentRun();
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById("command-btn");
const commandPalette = document.getElementById("command-palette");
const commandPaletteOverlay = document.getElementById("command-palette-overlay");
const commandList = document.getElementById("command-list");

const commands = [
  {
    icon: "🗜️",
    label: "Compact",
    desc: "Compact context to save tokens",
    action: () => rpcCommand({ type: "compact" }, "Compacting..."),
  },
  {
    icon: "📋",
    label: "Export HTML",
    desc: "Export session as HTML file",
    action: () => rpcExportHtml(),
  },
  {
    icon: "📊",
    label: "Session Stats",
    desc: "Show session statistics",
    action: () => showSessionStats(),
  },
  {
    icon: "⬇️",
    label: "Expand All Tools",
    desc: "Expand all tool cards",
    action: () => toolCardRenderer.expandAll(),
  },
  {
    icon: "⬆️",
    label: "Collapse All Tools",
    desc: "Collapse all tool cards",
    action: () => toolCardRenderer.collapseAll(),
  },
];

function openCommandPalette() {
  commandList.innerHTML = "";
  commands.forEach((cmd) => {
    const el = document.createElement("div");
    el.className = "command-item";
    el.innerHTML = `
      <div class="command-icon">${cmd.icon}</div>
      <div>
        <div class="command-label">${cmd.label}</div>
        <div class="command-desc">${cmd.desc}</div>
      </div>
    `;
    el.addEventListener("click", () => {
      closeCommandPalette();
      cmd.action();
    });
    commandList.appendChild(el);
  });
  commandPalette.classList.remove("hidden");
  commandPaletteOverlay.classList.remove("hidden");
}

function closeCommandPalette() {
  commandPalette.classList.add("hidden");
  commandPaletteOverlay.classList.add("hidden");
}

commandBtn.addEventListener("click", openCommandPalette);
commandPaletteOverlay.addEventListener("click", closeCommandPalette);

async function rpcCommand(cmd, statusMsg) {
  try {
    if (statusMsg) statusText.textContent = statusMsg;
    const resp = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      statusText.textContent = t("status.done");
      setTimeout(() => {
        statusText.textContent = t("status.connected");
      }, 2000);
    } else {
      statusText.textContent = data.error || t("status.failed");
      setTimeout(() => {
        statusText.textContent = "Connected";
      }, 3000);
    }
    return data;
  } catch (_e) {
    statusText.textContent = t("status.error");
    setTimeout(() => {
      statusText.textContent = "Connected";
    }, 3000);
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: "export_html" }, "Exporting...");
  if (data?.success && data.data?.path) {
    statusText.textContent = `Exported: ${data.data.path}`;
    setTimeout(() => {
      statusText.textContent = "Connected";
    }, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: "get_session_stats" }, "Loading stats...");
  if (data?.success && data.data) {
    const s = data.data;
    const lines = [
      `📊 Session Stats`,
      `Messages: ${s.totalMessages} (${s.userMessages} user, ${s.assistantMessages} assistant)`,
      `Tool calls: ${s.toolCalls}`,
    ];
    if (s.tokens) {
      lines.push(`Context: ~${(s.tokens.input / 1000).toFixed(1)}k tokens`);
    }
    messageRenderer.renderSystemMessage(lines.join("\n"));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById("model-dropdown");
const modelDropdownBtn = document.getElementById("model-dropdown-btn");
const modelDropdownLabel = document.getElementById("model-dropdown-label");
const modelDropdownMenu = document.getElementById("model-dropdown-menu");
const thinkingBtn = document.getElementById("thinking-btn");
function formatThinkingLevelLabel(level) {
  return t("settings.thinkingLevel", { level: level || t("settings.off") });
}
function formatCompactThinkingLevelLabel(level) {
  return t("settings.thinkingCompact", { level: level || t("settings.off") });
}
function updateThinkingBtn() {
  thinkingBtn.textContent = formatCompactThinkingLevelLabel(currentThinkingLevel);
  thinkingBtn.title = t("settings.thinkingTitle");
  thinkingBtn.setAttribute(
    "aria-label",
    t("settings.thinkingAriaLabel", { level: currentThinkingLevel || t("settings.off") }),
  );
  thinkingBtn.classList.toggle("off", currentThinkingLevel === "off");
}
let currentModelId = "";
let availableModels = [];
let hasLoadedAvailableModels = false;
let didAutoOpenEmptyModelsDropdown = false;
let currentThinkingLevel = "off";

function currentOnboardingState() {
  return getOnboardingState({
    hasSessions: hasAnySessionsLoaded(),
    workspacePath: getCurrentWorkspacePath(),
    availableModels,
  });
}

function openConfigurationSettings() {
  return openSettings().then(() => selectSettingsTab("configuration"));
}

function updateOnboardingUI() {
  const onboarding = currentOnboardingState();
  const needsSetup = !onboarding.canQuery;
  composerCard.classList.toggle("onboarding-disabled", needsSetup);
  if (needsSetup) {
    messageInput.placeholder = onboarding.message;
  }
  return onboarding;
}

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_available_models" }),
      }),
      fetch("/api/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "get_state" }),
      }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && Array.isArray(modelsData.data?.models)) {
      availableModels = modelsData.data.models;
      hasLoadedAvailableModels = true;
      if (availableModels.length > 0) {
        didAutoOpenEmptyModelsDropdown = false;
      }
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || "";
      updateModelLabel();

      const model = availableModels.find((m) => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      updateThinkingBtn();
    }
  } catch (_e) {
    // ignore
  } finally {
    updateModelLabel();
    updateUI();
    maybeAutoOpenEmptyModelsDropdown();
  }
}

function maybeAutoOpenEmptyModelsDropdown() {
  if (
    hasLoadedAvailableModels &&
    availableModels.length === 0 &&
    !didAutoOpenEmptyModelsDropdown &&
    modelDropdownMenu.classList.contains("hidden") &&
    settingsPanel.classList.contains("hidden")
  ) {
    didAutoOpenEmptyModelsDropdown = true;
    openModelDropdown();
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  modelDropdownLabel.textContent = shortName || "model";
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains("hidden");
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  modelDropdownMenu.innerHTML = "";

  // Search input
  const search = document.createElement("input");
  search.className = "model-dropdown-search";
  search.placeholder = "Search models…";
  search.type = "text";
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement("div");
  itemsContainer.className = "model-dropdown-items";
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.innerHTML = "";
    const query = (filter || "").toLowerCase();
    // Empty-state: no API keys configured anywhere. Surface this loudly
    // instead of leaving the dropdown blank — empty dropdowns look like
    // a hung load, not a setup problem.
    if (availableModels.length === 0) {
      const empty = document.createElement("div");
      empty.className = "model-dropdown-empty";
      empty.innerHTML = `
        <div style="padding:14px;color:var(--text-dim);font-size:12px;line-height:1.5">
          <div style="color:var(--text-primary);margin-bottom:6px">No models available</div>
          <div>No API keys configured. Set a key in Settings &rarr; Configuration.</div>
          <button type="button" class="btn-primary" style="margin-top:10px">Open Settings</button>
        </div>`;
      empty.querySelector("button").addEventListener("click", () => {
        closeModelDropdown();
        openConfigurationSettings().catch(() => {});
      });
      itemsContainer.appendChild(empty);
      return;
    }
    availableModels.forEach((m) => {
      const shortName = m.id.replace(/-\d{8}$/, "");
      const providerStr = m.provider || "";
      if (
        query &&
        !shortName.toLowerCase().includes(query) &&
        !providerStr.toLowerCase().includes(query)
      )
        return;

      const el = document.createElement("div");
      el.className = `model-dropdown-item${m.id === currentModelId ? " active" : ""}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : "";
      const providerLabel =
        m.provider && m.provider !== "anthropic"
          ? `<span class="model-dropdown-item-provider">${m.provider}</span>`
          : "";
      el.innerHTML = `<span>${shortName}${providerLabel}</span><span class="model-dropdown-item-ctx">${ctxK}</span>`;
      el.addEventListener("click", async () => {
        closeModelDropdown();
        const display = m.id.replace(/^claude-/, "").replace(/-\d{8}$/, "");
        await rpcCommand(
          { type: "set_model", provider: m.provider, modelId: m.id },
          `Switching to ${display}...`,
        );
        currentModelId = m.id;
        updateModelLabel();
        if (m.contextWindow) {
          contextWindowSize = m.contextWindow;
          updateTokenUsage();
        }
      });
      itemsContainer.appendChild(el);
    });
  }

  renderItems("");

  search.addEventListener("input", () => renderItems(search.value));
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModelDropdown();
      e.stopPropagation();
    }
    if (e.key === "Enter") {
      const first = itemsContainer.querySelector(".model-dropdown-item");
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove("hidden");
  modelDropdown.classList.add("open");
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add("hidden");
  modelDropdown.classList.remove("open");
}

modelDropdownBtn.addEventListener("click", toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
});

// Thinking level button — cycles through levels
thinkingBtn.addEventListener("click", async () => {
  const data = await rpcCommand({ type: "cycle_thinking_level" }, "Cycling thinking...");
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener("keydown", (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === "Escape") {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains("hidden")) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains("hidden")) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains("hidden")) {
      closeModelDropdown();
      return;
    }

    if (state.isStreaming) {
      abortCurrentRun();
    } else if (!sidebarEl.classList.contains("collapsed") && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === "/" && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }

  // Cmd+N (macOS) / Ctrl+N (Windows/Linux) — Start a new chat session in
  // the current workspace. Mirrors the header "+ New Session" button.
  // We intentionally do NOT gate on isInInput() so the shortcut works
  // even while the user is typing in the composer. Shift/Alt are excluded
  // so we don't shadow Cmd+Shift+N (reserved for future "new window").
  if ((e.key === "n" || e.key === "N") && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    newSession().catch((err) => {
      messageRenderer.renderError(`Failed to start new session: ${err}`);
    });
  }

  // Cmd+Option+I (macOS) / Ctrl+Alt+I (Windows/Linux) — Open webview inspector.
  if ((e.key === "i" || e.key === "I") && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey) {
    e.preventDefault();
    if (nativeAvailable()) {
      transport.openDevtools().catch((err) => {
        messageRenderer.renderError(`Failed to open inspector: ${err}`);
      });
    }
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = "☰";
}

function toggleSidebar() {
  sidebarEl.classList.toggle("collapsed");
  sidebarOverlay.classList.toggle(
    "visible",
    !sidebarEl.classList.contains("collapsed") && isMobile(),
  );
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener("click", toggleSidebar);

sidebarOverlay.addEventListener("click", () => {
  sidebarEl.classList.add("collapsed");
  sidebarOverlay.classList.remove("visible");
  updateSidebarToggleIcon();
});

refreshSessionsBtn.addEventListener("click", () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add("spinning");
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove("spinning"), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener(
    "touchstart",
    (e) => {
      const touch = e.touches[0];
      // Only track swipes starting within 20px of left edge
      if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains("collapsed")) {
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        tracking = true;
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchmove",
    (e) => {
      if (!tracking) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchStartX;
      const dy = Math.abs(touch.clientY - touchStartY);
      // If vertical movement dominates, cancel
      if (dy > dx) {
        tracking = false;
      }
    },
    { passive: true },
  );

  document.addEventListener(
    "touchend",
    (e) => {
      if (!tracking) return;
      tracking = false;
      const touch = e.changedTouches[0];
      const dx = touch.clientX - touchStartX;
      if (dx > 60) {
        sidebarEl.classList.remove("collapsed");
        sidebarOverlay.classList.add("visible");
      }
    },
    { passive: true },
  );
})();

// Session search
setupSidebarSearchControl({
  input: sessionSearchInput,
  clearButton: sessionSearchClearBtn,
  onChange: (value) => sidebar.setSearchQuery(value),
});

/**
 * Reset the chat surface to a fresh "new session" view inside the current window.
 * Clears renderers/state, unmarks the active sidebar item and refreshes the list
 * so the newly created session shows up once pi writes its first message to disk.
 */
async function resetUiForNewSession() {
  pendingNewSessionPreviousFile =
    mirrorActiveSessionFile ||
    sidebar.activeSessionFile ||
    liveInstances.find((i) => i?.port === foregroundPort)?.sessionFile ||
    null;
  state.reset();
  messageRenderer.clear();
  toolCardRenderer.clear();
  renderWorkspaceWelcome();
  sidebar.clearActive();
  mirrorActiveSessionFile = null;
  viewingActiveSession = true;
  pendingSessionSwitchPath = null;
  updateMirrorInputState();
  updateUI();

  // Mark that the next assistant turn should refresh the sidebar, since pi
  // doesn't persist a brand-new session to disk until the first message round-trip.
  pendingNewSessionRefresh = true;

  pollInstances().catch(() => {});
  sidebar.loadSessions().catch(() => {});
}

async function activateNewParallelSession(port, cwd) {
  logSessionRoute("activateNewParallelSession:start", { port, cwd });
  foregroundPort = port;
  portSessionMap.delete(port);
  if (cwd) {
    foregroundWorkspacePath = cwd;
    updateWorkspaceIndicator(cwd);
    refreshFileBrowserForWorkspace(cwd);
  }
  wsClient.setRoutingContext({
    workspaceId: `workspace:${cwd || getCurrentWorkspacePath() || "unknown"}`,
    sessionId: null,
    sourcePort: foregroundPort,
  });
  await resetUiForNewSession();
  pollInstances().catch(() => {});
  logSessionRoute("activateNewParallelSession:done", { port, cwd });
}

async function newSession() {
  if (nativeAvailable()) {
    // Default behavior is process-efficient: create the new chat in-place on
    // the current pi process. Only spawn a dedicated process when a parallel
    // task is actually running.
    await startInWindowNewSession({
      transport,
      getCurrentCwd: getCurrentWorkspacePath,
      getCurrentPort: getActivePort,
      fetchInstances,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      shouldSpawnParallel: () => state.isStreaming,
      onInPlaceSessionCreated: () => {
        resetUiForNewSession().catch(() => {});
      },
      onParallelSessionCreated: activateNewParallelSession,
      renderError: (message) => messageRenderer.renderError(message),
    });
    return;
  }

  if (canUseSessionControl()) {
    sessionTotalCost = 0;
    lastInputTokens = 0;
    updateCostDisplay();
    updateTokenUsage();
    try {
      await transport.newSession(getActivePort());
      await resetUiForNewSession();
    } catch (err) {
      messageRenderer.renderError(`Failed to start new session: ${err}`);
      return;
    }
    if (isMobile()) {
      sidebarEl.classList.add("collapsed");
      sidebarOverlay.classList.remove("visible");
    }
    return;
  }

  // Browser/dev fallback: classic in-place "new session" against the same
  // pi process (no Tauri windows available in this mode).
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  const data = await rpcCommand({ type: "new_session" }, "Starting new session...");
  if (data?.success === false || data?.data?.cancelled) {
    messageRenderer.renderError(data?.error || "New session was cancelled");
    return;
  }
  await resetUiForNewSession();

  if (isMobile()) {
    sidebarEl.classList.add("collapsed");
    sidebarOverlay.classList.remove("visible");
  }
  if (!isMobile()) messageInput.focus();
}

async function handleNewProjectChat(project) {
  if (workspaceLaunchInProgress) return;
  setWorkspaceLaunchInProgress(true);
  try {
    if (!canUseSessionControl()) {
      const targetPath = project?.path || "";
      const currentPath = getCurrentWorkspacePath();
      const singleProject =
        Array.isArray(sidebar.projects) && sidebar.projects.length === 1
          ? sidebar.projects[0]
          : null;
      const isCurrentProject =
        !targetPath ||
        targetPath === currentPath ||
        (!currentPath && singleProject?.path === targetPath);
      if (isCurrentProject) {
        await newSession();
      } else {
        messageRenderer.renderError(
          "Starting a new chat in another project requires the desktop broker. Reopen the mobile QR code.",
        );
      }
      if (isMobile()) {
        sidebarEl.classList.add("collapsed");
        sidebarOverlay.classList.remove("visible");
      }
      return;
    }

    // Prefer reuse: same project + no active parallel run => in-place
    // new_session on current process. Spawn dedicated process only when
    // a parallel run is active.
    const launched = await startNewProjectChat({
      project,
      transport,
      getCurrentPort: getActivePort,
      getCurrentCwd: getCurrentWorkspacePath,
      shouldSpawnParallel: () => mobileClientMode || state.isStreaming,
      onInPlaceSessionCreated: () => {
        resetUiForNewSession().catch(() => {});
      },
      onParallelSessionCreated: mobileClientMode ? null : activateNewParallelSession,
      fetchInstances,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      renderError: (message) => messageRenderer.renderError(message),
    });
    if (!launched) return;

    if (isMobile()) {
      sidebarEl.classList.add("collapsed");
      sidebarOverlay.classList.remove("visible");
    }
  } finally {
    setWorkspaceLaunchInProgress(false);
  }
}

// Public entry point: serializes selections so overlapping clicks don't
// interleave their awaits and corrupt shared routing state.
function handleSessionSelect(session, project) {
  const run = sessionSelectChain.then(() => handleSessionSelectImpl(session, project));
  // Keep the chain alive even if this selection rejects.
  sessionSelectChain = run.catch(() => {});
  return run;
}

async function handleSessionSelectImpl(session, project) {
  logSessionRoute("select:start", {
    selectedSession: session?.filePath,
    projectPath: project?.path,
    projectDir: project?.dirName,
    liveInstances,
  });
  // An explicit session selection supersedes any pending deferred switch.
  // Leaving it set would (a) suppress all live rendering for the newly
  // selected session via the `pendingSessionSwitchPath` guard in
  // `handleRPCEvent`, and (b) yank the user to the stale deferred target on
  // the next `agent_end`. Clearing it here is what keeps tool-call/streaming
  // updates flowing after an A → B → A switch.
  if (pendingSessionSwitchPath && pendingSessionSwitchPath !== session.filePath) {
    logSessionRoute("select:clear-stale-deferred", {
      pendingSessionSwitchPath,
      selectedSession: session?.filePath,
    });
    pendingSessionSwitchPath = null;
  }
  sidebar.setActive(session.filePath);
  const targetLiveInstance = liveInstances.find(
    (instance) => instance.sessionFile === session.filePath,
  );
  foregroundPort = findPortForSession(liveInstances, session.filePath, foregroundPort);
  syncWorkspaceIndicatorFromInstances();
  // Historical sessions in another workspace have no live instance, so the
  // indicator path resolved from liveInstances may be null. Refresh the file
  // tree directly from the project the user just clicked into so it doesn't
  // stay stale while the chat history replays.
  if (project?.path && project.path !== fileBrowserWorkspacePath) {
    refreshFileBrowserForWorkspace(project.path, { force: true });
  }
  if (session.filePath) {
    wsClient.setRoutingContext({
      workspaceId: `workspace:${project?.path || getCurrentWorkspacePath() || "unknown"}`,
      sessionId: session.filePath,
      sourcePort: foregroundPort,
    });
  }
  logSessionRoute("select:routed", {
    selectedSession: session.filePath,
    targetLiveInstance,
  });
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();

  // Native host: switch session via control command to the current pi instance
  if (nativeAvailable() && session.filePath) {
    const wasStreaming = state.isStreaming;
    clearMessageQueue();
    state.reset();
    if (sidebar.isStreaming(session.filePath)) {
      state.setStreaming(true);
      showTypingIndicator(true);
    } else {
      showTypingIndicator(false);
    }
    updateUI();
    await renderSelectedSessionHistory(session, project);

    if (targetLiveInstance) {
      logSessionRoute("select:target-live-sync", {
        selectedSession: session.filePath,
        targetPort: targetLiveInstance.port,
      });
      mirrorActiveSessionFile = session.filePath;
      viewingActiveSession = true;
      updateMirrorInputState();
      wsClient.send({ type: "mirror_sync_request" });
      if (isMobile()) {
        sidebarEl.classList.add("collapsed");
        sidebarOverlay.classList.remove("visible");
      }
      return;
    }

    if (wasStreaming) {
      if (transport.spawnSessionProcess) {
        let targetPort = null;
        try {
          const cwd = getCurrentWorkspacePath();
          targetPort = await transport.spawnSessionProcess(session.filePath, cwd);
        } catch (e) {
          console.error(
            "[App] Failed to spawn session process, falling back to deferred switch:",
            e,
          );
        }
        if (targetPort != null) {
          logSessionRoute("select:spawned-dedicated", {
            selectedSession: session.filePath,
            targetPort,
          });
          foregroundPort = targetPort;
          portSessionMap.set(targetPort, session.filePath);
          wsClient.setRoutingContext({
            sessionId: session.filePath,
            sourcePort: foregroundPort,
          });
          syncWorkspaceIndicatorFromInstances();
          pollInstances().catch(() => {});
          wsClient.send({ type: "mirror_sync_request" });
          if (isMobile()) {
            sidebarEl.classList.add("collapsed");
            sidebarOverlay.classList.remove("visible");
          }
          return;
        }
      }
      // Fallback: defer the switch until the current agent run ends.
      // This preserves the old safe behavior when spawn is unavailable or fails.
      pendingSessionSwitchPath = session.filePath;
      updateUI();
      if (isMobile()) {
        sidebarEl.classList.add("collapsed");
        sidebarOverlay.classList.remove("visible");
      }
      return;
    }

    try {
      logSessionRoute("select:switch-current-process", {
        selectedSession: session.filePath,
        targetPort: foregroundPort,
      });
      await transport.switchSession(session.filePath, foregroundPort);
      wsClient.send({ type: "mirror_sync_request" });
    } catch (e) {
      messageRenderer.renderError(`Failed to switch session: ${e}`);
    }
    if (isMobile()) {
      sidebarEl.classList.add("collapsed");
      sidebarOverlay.classList.remove("visible");
    }
    return;
  }

  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add("collapsed");
    sidebarOverlay.classList.remove("visible");
  }
}

async function renderSelectedSessionHistory(session, project) {
  messageRenderer.clear();
  toolCardRenderer.clear();
  if (!session || !project) {
    renderWorkspaceWelcome();
    return;
  }

  messageRenderer.renderSystemMessage("Loading session…");
  const dirName = project?.dirName;
  const file = session.file;
  if (!dirName || !file) {
    logSessionRoute("history:skip-missing-path", {
      selectedSession: session?.filePath,
      dirName,
      file,
    });
    return;
  }

  try {
    const url = `/api/sessions/${dirName}/${file}`;
    logSessionRoute("history:fetch", {
      url,
      selectedSession: session.filePath,
      dirName,
      file,
    });
    const res = await fetch(url);
    logSessionRoute("history:fetch-result", {
      url,
      status: res.status,
      ok: res.ok,
    });
    const data = await res.json();
    messageRenderer.clear();
    logSessionRoute("history:render", {
      selectedSession: session.filePath,
      entries: data.entries?.length || 0,
    });
    renderSessionHistory(data.entries || [], { searchQuery: sidebar.searchQuery });
  } catch (e) {
    console.error("[Session route] history:fetch-error", {
      selectedSession: session?.filePath,
      error: e,
    });
    messageRenderer.renderError(`Failed to load session: ${e}`);
  }
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage("Loading session...");

      const dirName = project?.dirName;
      const file = session.file;
      console.log("[App] Loading history:", { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const res = await fetch(`/api/sessions/${dirName}/${file}`);
          console.log("[App] History fetch status:", res.status);
          const data = await res.json();
          console.log("[App] History entries:", data.entries?.length || 0);

          messageRenderer.clear();
          renderSessionHistory(data.entries || [], { searchQuery: sidebar.searchQuery });
        } catch (e) {
          console.error("[App] History fetch error:", e);
        }
      } else {
        console.log("[App] Skipped history load: dirName or file missing");
      }
    } else {
      renderWorkspaceWelcome();
    }

    // In mirror mode, check if this session is live on any instance
    if (isMirrorMode) {
      const liveInstance = liveInstances.find((i) => i.sessionFile === sessionFile);
      if (liveInstance) {
        foregroundPort = liveInstance.port;
        syncWorkspaceIndicatorFromInstances();
        mirrorActiveSessionFile = sessionFile;
        viewingActiveSession = true;
        wsClient.setRoutingContext({
          workspaceId: `workspace:${liveInstance.cwd || getCurrentWorkspacePath() || "unknown"}`,
          sessionId: sessionFile,
          sourcePort: foregroundPort,
        });
        updateMirrorInputState();
        wsClient.send({ type: "mirror_sync_request" });
        return;
      }

      // Check if this is the active session on the current instance
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      updateMirrorInputState();

      if (viewingActiveSession) {
        // Re-request live state from the extension
        wsClient.send({ type: "mirror_sync_request" });
      }
    } else {
      const res = await fetch("/api/sessions/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        messageRenderer.renderError(`Failed to switch session: ${err.error}`);
      }
    }
  } catch (error) {
    console.error("[App] Failed to switch session:", error);
    messageRenderer.renderError("Failed to switch session");
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  logSessionRoute("mirrorSync:received", {
    sessionFile: data.sessionFile,
    sessionId: data.sessionId,
    workspaceId: data.workspaceId,
    entries: data.entries?.length || 0,
    isStreaming: data.isStreaming,
  });
  if (!sessionsLoaded) {
    deferredMirrorSync = data;
    return;
  }

  // The broker broadcasts every upstream's `mirror_sync` to all UI clients,
  // including snapshots a *background* pi process emits on its own
  // `session_start` (e.g. the previously-running session that keeps streaming
  // after the user switched to an older session). Such a stray snapshot must
  // NOT hijack the foreground UI: applying it would clobber the rendered
  // history AND — critically — reset the routing context to the background
  // process's session/port, causing the user's next message to be sent into
  // that previous session instead of the one they're now viewing.
  const syncPort = typeof data.port === "number" ? data.port : null;
  if (syncPort !== null && typeof foregroundPort === "number" && syncPort !== foregroundPort) {
    logSessionRoute("mirrorSync:ignored-background", {
      syncPort,
      foregroundPort,
      sessionFile: data.sessionFile,
    });
    const bgFile = data.sessionFile || data.sessionId;
    if (bgFile) {
      const bgStreaming = Boolean(data.isStreaming);
      sidebar.setStreaming(bgFile, bgStreaming);
      updateMirrorLiveIndicator();
    }
    return;
  }

  console.log("[Mirror] Received state snapshot:", data.entries?.length, "entries");
  isMirrorMode = true;

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  if (data.sessionFile) portSessionMap.set(foregroundPort, data.sessionFile);
  const syncWorkspacePath = workspacePathFromId(data.workspaceId);
  if (syncWorkspacePath) {
    foregroundWorkspacePath = syncWorkspacePath;
    updateWorkspaceIndicator(syncWorkspacePath);
  }
  wsClient.setRoutingContext({
    workspaceId: data.workspaceId || `workspace:${getCurrentWorkspacePath() || "unknown"}`,
    sessionId: data.sessionId || data.sessionFile || null,
    sourcePort: data.port || foregroundPort,
  });
  viewingActiveSession = true;
  // The snapshot's `isStreaming` comes from the pi process's instantaneous
  // `!ctx.isIdle()`, which can momentarily read false between messages / tool
  // calls of an agent run that is still actively going. The sidebar's
  // streaming set is driven by real `agent_start` / `agent_end` events and is
  // the more reliable signal for a background session we're switching into, so
  // OR the two: only treat the session as idle when both agree it is idle.
  const liveFile = data.sessionFile || mirrorActiveSessionFile;
  const sidebarStreaming = liveFile ? sidebar.isStreaming(liveFile) : false;
  const isStreaming = Boolean(data.isStreaming) || sidebarStreaming;
  state.setStreaming(isStreaming);
  showTypingIndicator(isStreaming);
  if (liveFile) sidebar.setStreaming(liveFile, isStreaming);
  updateMirrorInputState();
  updateMirrorLiveIndicator();
  updateUI();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || "";
    updateModelLabel();
    if (data.model.contextWindow) {
      contextWindowSize = data.model.contextWindow;
    }
  }

  // Update thinking level
  if (data.thinkingLevel) {
    currentThinkingLevel = data.thinkingLevel;
    updateThinkingBtn();
  }

  // Clear and render message history
  messageRenderer.clear();
  sessionTotalCost = 0;
  lastInputTokens = 0;

  // Keep Welcome stable when there are already sessions in the sidebar and
  // the user has not explicitly selected one yet.
  if (!sidebar.activeSessionFile && hasAnySessionsLoaded()) {
    renderWorkspaceWelcome();
    updateCostDisplay();
    updateTokenUsage();
    return;
  }

  if (data.entries && data.entries.length > 0) {
    renderSessionHistory(data.entries, { searchQuery: sidebar.searchQuery });
  } else {
    renderWorkspaceWelcome();
  }

  updateCostDisplay();
  updateTokenUsage();
}

// Mark sessions in the sidebar with a green dot only when actively streaming
function updateMirrorLiveIndicator() {
  document.querySelectorAll(".session-item").forEach((el) => {
    el.classList.toggle("mirror-live", sidebar.streamingFiles.has(el.dataset.filePath));
  });
}

// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch("/api/instances");
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      logSessionRoute("instances:poll", {
        count: liveInstances.length,
        instances: liveInstances,
      });
      updateMirrorLiveIndicator();
      syncWorkspaceIndicatorFromInstances();
      if (document.querySelector(".welcome")) {
        renderWorkspaceWelcome();
      }
    }
  } catch {}
}

// Poll every 5 seconds
setInterval(pollInstances, 5000);
pollInstances();

// Enable/disable input based on whether we're viewing the live session
function updateMirrorInputState() {
  if (!isMirrorMode) return;

  const inputArea = document.querySelector(".input-area");
  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = "Message...";
    inputArea?.classList.remove("mirror-readonly");
  } else {
    messageInput.disabled = true;
    messageInput.placeholder = "Viewing historical session (read-only)";
    inputArea?.classList.add("mirror-readonly");
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries, { searchQuery = "" } = {}) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0,
    assistantCount = 0,
    toolCardCount = 0,
    toolResultCount = 0;

  for (const entry of entries) {
    if (entry.type !== "message") continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n");
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === "image")
            .map((b) => ({
              data: b.source?.data || b.data || "",
              mimeType: b.source?.media_type || b.media_type || "image/png",
            }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage(
          { content: content || "", images: images.length > 0 ? images : undefined },
          true,
        );
      }
    } else if (msg.role === "assistant") {
      const textBlocks = (msg.content || []).filter((b) => b.type === "text");
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === "thinking");
      const toolCalls = (msg.content || []).filter((b) => b.type === "toolCall");

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === "text" || block.type === "thinking") {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join("\n");

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true,
        );

        // Track cost and tokens from history
        if (msg.usage?.cost?.total) {
          sessionTotalCost += msg.usage.cost.total;
        }
        if (msg.usage?.input) {
          lastInputTokens = msg.usage.input + (msg.usage.cacheRead || 0);
          lastUsage = msg.usage;
        }
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        toolCardCount++;
        const card = toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
        console.log(
          `[History] Tool card created: ${tc.name}`,
          card?.offsetHeight,
          card?.innerHTML?.substring(0, 100),
        );
      }
    } else if (msg.role === "toolResult") {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError,
      );
    }
  }

  console.log(
    `[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`,
  );
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll(".tool-card").length);
  console.log(
    `[History] DOM thinking-block count:`,
    document.querySelectorAll(".thinking-block").length,
  );

  if (searchQuery) {
    messageRenderer.highlightSearchQuery(searchQuery);
  }

  updateCostDisplay();
  updateTokenUsage();
  fetchContextWindow();

  anchorHistoryToBottom(document.getElementById("messages"), {
    preserveScrollTarget: Boolean(searchQuery),
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle("hidden", !show);
}

function abortCurrentRun() {
  wsClient.send({ type: "abort" });
  messageRenderer.renderError("Aborted by user");
  showTypingIndicator(false);

  // In some abort paths, backend agent_end can be delayed or missing.
  // Optimistically unlock input so users can continue immediately.
  if (state.isStreaming) {
    state.setStreaming(false);
    currentStreamingElement = null;
    currentStreamingText = "";
    currentStreamingThinking = "";
    updateUI();
  }
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add("visible");
  } else {
    sessionCostEl.classList.remove("visible");
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = `${pct}%`;
    tokenUsageEl.classList.add("visible");
    tokenUsageEl.classList.remove("warning", "critical");
    if (pct >= 80) {
      tokenUsageEl.classList.add("critical");
    } else if (pct >= 60) {
      tokenUsageEl.classList.add("warning");
    }
    tokenUsageEl.title = `Context: ${(lastInputTokens / 1000).toFixed(1)}k / ${(contextWindowSize / 1000).toFixed(0)}k tokens`;
    if (pct >= 80) {
      showCompactButton();
    } else {
      hideCompactButton();
    }
  } else if (lastInputTokens > 0) {
    // No context window info yet, just show raw tokens
    tokenUsageEl.textContent = `${(lastInputTokens / 1000).toFixed(1)}k`;
    tokenUsageEl.classList.add("visible");
    tokenUsageEl.classList.remove("warning", "critical");
  }
}

function showCompactButton() {
  if (document.getElementById("compact-btn")) return;
  const btn = document.createElement("button");
  btn.id = "compact-btn";
  btn.className = "compact-btn";
  btn.textContent = t("misc.compact");
  btn.title = t("misc.compactTitle");
  btn.addEventListener("click", () => {
    rpcCommand({ type: "compact" }, "Compacting...");
    hideCompactButton();
  });
  // Insert next to token usage in header
  tokenUsageEl.parentElement.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById("compact-btn");
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = "";
let lanUrl = "";
let lanUrls = [];

const lanQrBtn = document.getElementById("lan-qr-btn");
const lanQrModal = document.getElementById("lan-qr-modal");
const lanQrModalBackdrop = document.getElementById("lan-qr-modal-backdrop");
const lanQrModalClose = document.getElementById("lan-qr-modal-close");
const lanQrLoading = document.getElementById("lan-qr-loading");
const lanQrImage = document.getElementById("lan-qr-image");
const lanQrOpenLink = document.getElementById("lan-qr-open-link");
let lanQrUrl = "";

function updateLanQrButton(url = "") {
  if (!lanQrBtn) return;
  if (url) {
    lanQrBtn.classList.remove("hidden");
  } else {
    lanQrBtn.classList.add("hidden");
  }
}

async function openLanQrModal() {
  if (!lanQrModal) return;
  lanQrModal.classList.remove("hidden");
  if (lanQrLoading) lanQrLoading.style.display = "";
  if (lanQrImage) lanQrImage.classList.add("hidden");
  if (lanQrOpenLink) lanQrOpenLink.classList.add("hidden");
  lanQrUrl = "";
  try {
    const res = await fetch("/api/lan-qr");
    if (!res.ok) throw new Error("unavailable");
    const data = await res.json();
    if (lanQrImage) {
      lanQrImage.src = data.dataUrl;
      lanQrImage.classList.remove("hidden");
    }
    if (typeof data.url === "string" && data.url) {
      lanQrUrl = data.url;
      if (lanQrOpenLink) lanQrOpenLink.classList.remove("hidden");
    }
    if (lanQrLoading) lanQrLoading.style.display = "none";
  } catch {
    if (lanQrLoading) lanQrLoading.textContent = t("misc.qrUnavailable");
  }
}

function closeLanQrModal() {
  if (lanQrModal) lanQrModal.classList.add("hidden");
}

if (lanQrBtn) lanQrBtn.addEventListener("click", openLanQrModal);
if (lanQrModalBackdrop) lanQrModalBackdrop.addEventListener("click", closeLanQrModal);
if (lanQrModalClose) lanQrModalClose.addEventListener("click", closeLanQrModal);
if (lanQrOpenLink)
  lanQrOpenLink.addEventListener("click", () => {
    if (lanQrUrl) openExternalLink(lanQrUrl);
  });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && lanQrModal && !lanQrModal.classList.contains("hidden")) {
    closeLanQrModal();
  }
});

async function refreshLanUrl() {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) {
      return;
    }
    const data = await res.json();
    tailscaleUrl = typeof data?.tailscaleUrl === "string" ? data.tailscaleUrl : tailscaleUrl;
    lanUrls = Array.isArray(data?.lanUrls)
      ? data.lanUrls.filter((value) => typeof value === "string" && value.trim())
      : [];
    lanUrl = typeof data?.lanUrl === "string" ? data.lanUrl : "";
    if (!lanUrl && lanUrls.length > 0) lanUrl = lanUrls[0];
    if (tailscaleUrl) {
      statusText.textContent = t("status.connectedTS");
      statusText.title = tailscaleUrl;
    } else if (lanUrl) {
      statusText.textContent = t("status.connectedLAN");
      statusText.title = lanUrl;
    }
    updateLanQrButton(lanUrl);
  } catch {
    updateLanQrButton("");
  }
}

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === "connected") {
    if (tailscaleUrl) {
      statusText.textContent = "Connected • TS";
      statusText.title = tailscaleUrl;
    } else if (lanUrl) {
      statusText.textContent = "Connected • LAN";
      statusText.title = lanUrl;
    } else {
      statusText.textContent = "Connected";
      statusText.title = "";
    }
    // Fetch network link metadata on first connect
    if (!tailscaleUrl && !lanUrl) {
      void refreshLanUrl();
    }
  } else if (status === "disconnected") {
    statusText.textContent = t("status.disconnected");
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;
  const onboarding = updateOnboardingUI();

  composerCard.classList.toggle("streaming", isStreaming);

  if (isStreaming) {
    statusIndicator.classList.add("streaming");
    statusIndicator.classList.remove("connected");
    statusText.textContent = t("status.working");
  } else {
    statusIndicator.classList.remove("streaming");
    statusIndicator.classList.add("connected");
    statusText.textContent = "Connected";
  }

  messageInput.disabled = !onboarding.canType;
  sendBtn.disabled = !onboarding.canQuery;

  if (isStreaming) {
    abortBtn.classList.remove("hidden");
    sendBtn.classList.add("hidden");
  } else {
    abortBtn.classList.add("hidden");
    sendBtn.classList.remove("hidden");
    flushQueue();
  }

  // Viewing a history session while original is still streaming —
  // block input until agent_end triggers the deferred switch_session.
  if (pendingSessionSwitchPath) {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    abortBtn.classList.add("hidden");
    messageInput.placeholder = "Waiting for current session to finish…";
  } else if (onboarding.canQuery) {
    messageInput.placeholder = "Type a message...";
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener("sessionSwitch", () => {
  console.log("[App] Session switched");
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════

const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings-panel");
const settingsOverlay = document.getElementById("settings-overlay");
const settingsClose = document.getElementById("settings-close");
const settingsNavItems = Array.from(document.querySelectorAll(".settings-nav-item"));
const settingsTabs = Array.from(document.querySelectorAll(".settings-tab"));
const themeGrid = document.getElementById("theme-grid");
const languageOptions = document.getElementById("settings-language-options");

const toggleAutoCompact = document.getElementById("toggle-auto-compact");
const btnThinkingLevel = document.getElementById("btn-thinking-level");
const toggleShowThinking = document.getElementById("toggle-show-thinking");
const toggleAuth = document.getElementById("toggle-auth");
const authSection = document.getElementById("settings-auth-section");
const piVersionValue = document.getElementById("setting-pi-version-value");
let piVersionCache = null;
let piVersionInflight = null;
let loadInlineConfigEditor = async () => {};
let loadInlineModelsEditor = async () => {};
let loadApiKeysPanel = async () => {};

function selectSettingsTab(tabKey = "general") {
  const targetTabKey = tabKey === "auth" ? "configuration" : tabKey;
  settingsNavItems.forEach((item) => {
    item.classList.toggle("active", item.dataset.settingsTab === targetTabKey);
  });
  settingsTabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.settingsPanel === targetTabKey);
  });
  if (targetTabKey === "configuration") {
    loadApiKeysPanel();
    loadInlineConfigEditor();
    loadInlineModelsEditor();
  }
  if (targetTabKey === "extensions") {
    loadBrowsePackages();
  }
}

function formatPiVersionError(err, fallback = "unknown error") {
  const raw = String(err?.message || err?.error || err || fallback).trim();
  if (!raw) return fallback;
  return raw.length > 56 ? `${raw.slice(0, 56)}...` : raw;
}

async function loadPiVersion() {
  if (!piVersionValue) return;
  if (piVersionCache) {
    piVersionValue.textContent = piVersionCache;
    return;
  }
  if (piVersionInflight) {
    return;
  }
  piVersionInflight = (async () => {
    try {
      if (nativeAvailable()) {
        const version = await transport.getPiVersion();
        if (version) {
          piVersionCache = version;
          piVersionValue.textContent = piVersionCache;
        } else {
          piVersionValue.textContent = t("status.unavailableVersion");
        }
      } else {
        const data = await rpcCommand({ type: "get_pi_version" });
        if (data?.success && data.data?.version) {
          piVersionCache = data.data.version;
          piVersionValue.textContent = piVersionCache;
        } else {
          const reason = formatPiVersionError(data?.error, "version missing in response");
          console.error("[settings] failed to load pi version:", data);
          piVersionValue.textContent = `Unavailable (${reason})`;
        }
      }
    } catch (err) {
      const reason = formatPiVersionError(err);
      console.error("[settings] failed to load pi version:", err);
      piVersionValue.textContent = `Unavailable (${reason})`;
    } finally {
      piVersionInflight = null;
    }
  })();
}

function setExtensionActionButton(button, label, loading = false) {
  if (!button) return;
  if (loading) {
    button.innerHTML = '<span class="settings-btn-spinner" aria-hidden="true"></span><span></span>';
    const text = button.querySelector("span:last-child");
    if (text) text.textContent = label;
    return;
  }
  button.textContent = label;
}

// ═══════════════════════════════════════
// Browse community packages (pi-packages-api)
// ═══════════════════════════════════════

const PKG_API_BASE = "https://pi-packages-api.shixin.workers.dev";
const browseListEl = document.getElementById("pkg-browse-list");
const browseSearchEl = document.getElementById("pkg-browse-search");
const browsePillsEl = document.getElementById("pkg-browse-pills");
const browseCountEl = document.getElementById("pkg-browse-count");
let browsePaginationEl = document.getElementById("pkg-browse-pagination");
if (!browsePaginationEl && browseListEl && browseListEl.parentNode) {
  browsePaginationEl = document.createElement("div");
  browsePaginationEl.className = "pkg-browse-pagination";
  browsePaginationEl.id = "pkg-browse-pagination";
  browsePaginationEl.hidden = true;
  browseListEl.parentNode.insertBefore(browsePaginationEl, browseListEl.nextSibling);
}
const browseInstalledOnlyEl = document.getElementById("pkg-browse-installed-only");
const browseSortEl = document.getElementById("pkg-browse-sort");

let browseAllPackages = null;
let browseInstalledSet = new Set();
let browseLoaded = false;
let browseLoading = false;
let browseActiveType = "all";
let browseSearchQuery = "";
let browseInstalledOnly = false;
let browseSortMode = "downloads";
let browseSearchTimer = null;
let browsePage = 1;
const BROWSE_PAGE_SIZE = 50;

async function loadBrowsePackages(force = false) {
  if (!browseListEl) return;
  if (browseLoading) return;
  if (browseLoaded && !force) {
    renderBrowsePackages();
    return;
  }
  browseLoading = true;
  browseListEl.innerHTML = `<div class="settings-api-keys-loading pkg-browse-full-row">${escapeHtml(t("extensions.loadingPackages"))}</div>`;
  try {
    const [packages, installed] = await Promise.all([
      fetchBrowsePackages(),
      fetchInstalledSources(),
    ]);
    browseAllPackages = packages;
    browseInstalledSet = installed;
    browseLoaded = true;
    renderBrowsePackages();
  } catch (err) {
    const message = String(err?.message || err || t("extensions.failedToLoadPackages"));
    browseListEl.innerHTML = `<div class="settings-api-keys-empty pkg-browse-full-row">${escapeHtml(message)} <button type="button" class="settings-value-btn" id="pkg-browse-retry">${escapeHtml(t("actions.retry"))}</button></div>`;
    const retry = document.getElementById("pkg-browse-retry");
    if (retry) retry.addEventListener("click", () => loadBrowsePackages(true));
  } finally {
    browseLoading = false;
  }
}

async function fetchBrowsePackages() {
  const pageSize = 250;
  const all = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetch(`${PKG_API_BASE}/packages?page=${page}&pageSize=${pageSize}`);
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    const data = await res.json();
    if (Array.isArray(data?.packages)) all.push(...data.packages);
    totalPages = Number(data?.totalPages) || 1;
    page += 1;
  } while (page <= totalPages);
  return all;
}

async function fetchInstalledSources() {
  if (!nativeAvailable()) return new Set();
  try {
    const configured = await transport.listPiPackages();
    return new Set(Array.isArray(configured) ? configured : []);
  } catch {
    return new Set();
  }
}

function browseSourceFor(pkg) {
  return `npm:${pkg.name}`;
}

function normalizeRepoUrl(url) {
  if (!url) return null;
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
}

function openExternalLink(url) {
  if (!url) return;
  if (nativeAvailable()) {
    transport.openExternal(url).catch((err) => {
      console.error("[browse] failed to open external link:", err);
    });
  } else {
    window.open(url, "_blank", "noopener");
  }
}

const BROWSE_LINK_SVGS = {
  npm: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M0 0v24h24v-24h-24zm19.2 19.2h-2.4v-9.6h-4.8v9.6h-7.2v-14.4h14.4v14.4z"/></svg>',
  github:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
};

function createBrowseLinkButton(kind, label, url) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pkg-browse-link";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `${BROWSE_LINK_SVGS[kind] || BROWSE_LINK_SVGS.link}<span>${escapeHtml(label)}</span>`;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    openExternalLink(url);
  });
  return btn;
}

function buildBrowseLinks(pkg) {
  const links = pkg.links || {};
  const container = document.createElement("div");
  container.className = "pkg-browse-links";

  const npmUrl = links.npm || `https://www.npmjs.com/package/${encodeURIComponent(pkg.name)}`;
  container.appendChild(createBrowseLinkButton("npm", "npm", npmUrl));

  const repo = normalizeRepoUrl(links.repository);
  if (repo) {
    const isGithub = /github\.com/i.test(repo);
    container.appendChild(
      createBrowseLinkButton(isGithub ? "github" : "link", isGithub ? "GitHub" : "repo", repo),
    );
  }

  const homepage = normalizeRepoUrl(links.homepage);
  if (homepage && homepage !== repo) {
    container.appendChild(createBrowseLinkButton("link", "homepage", homepage));
  }

  return container;
}

function browseUpdatedTime(pkg) {
  const raw = pkg.updatedAt || pkg.updated || pkg.modified || pkg.date || pkg.time || 0;
  const t = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function sortBrowsePackages(packages) {
  const sorted = packages.slice();
  switch (browseSortMode) {
    case "name":
      sorted.sort((a, b) =>
        (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }),
      );
      break;
    case "updated":
      sorted.sort((a, b) => browseUpdatedTime(b) - browseUpdatedTime(a));
      break;
    default:
      sorted.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
      break;
  }
  return sorted;
}

function filterBrowsePackages() {
  if (!browseAllPackages) return [];
  const query = browseSearchQuery.toLowerCase().trim();
  const filtered = browseAllPackages.filter((pkg) => {
    if (browseInstalledOnly && !browseInstalledSet.has(browseSourceFor(pkg))) return false;
    if (browseActiveType !== "all") {
      if (!Array.isArray(pkg.types) || !pkg.types.includes(browseActiveType)) return false;
    }
    if (query) {
      const inName = pkg.name.toLowerCase().includes(query);
      const inDesc = (pkg.description || "").toLowerCase().includes(query);
      const inAuthor = (pkg.author || "").toLowerCase().includes(query);
      if (!inName && !inDesc && !inAuthor) return false;
    }
    return true;
  });
  return sortBrowsePackages(filtered);
}

function renderBrowsePackages() {
  if (!browseListEl) return;
  const results = filterBrowsePackages();

  const totalPages = Math.max(1, Math.ceil(results.length / BROWSE_PAGE_SIZE));
  if (browsePage > totalPages) browsePage = totalPages;
  if (browsePage < 1) browsePage = 1;
  const start = (browsePage - 1) * BROWSE_PAGE_SIZE;
  const pageResults = results.slice(start, start + BROWSE_PAGE_SIZE);

  if (browseCountEl) {
    if (results.length === 0) {
      browseCountEl.textContent = `0 of ${results.length}`;
    } else {
      const rangeStart = start + 1;
      const rangeEnd = start + pageResults.length;
      browseCountEl.textContent = `${rangeStart}–${rangeEnd} of ${results.length}`;
    }
  }

  browseListEl.innerHTML = "";
  if (!results.length) {
    browseListEl.innerHTML = `<div class="settings-api-keys-empty pkg-browse-full-row">${escapeHtml(t("extensions.noPackagesMatch"))}</div>`;
    renderBrowsePagination(totalPages);
    return;
  }
  for (const pkg of pageResults) {
    browseListEl.appendChild(createBrowseRow(pkg));
  }
  renderBrowsePagination(totalPages);
}

function renderBrowsePagination(totalPages) {
  if (!browsePaginationEl) return;
  if (totalPages <= 1) {
    browsePaginationEl.hidden = true;
    browsePaginationEl.innerHTML = "";
    return;
  }
  browsePaginationEl.hidden = false;
  browsePaginationEl.innerHTML = "";

  const goTo = (page) => {
    browsePage = page;
    renderBrowsePackages();
    if (browseListEl) browseListEl.scrollIntoView({ block: "nearest" });
  };

  const addBtn = (label, page, { active = false, disabled = false } = {}) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pkg-browse-page-btn${active ? " is-active" : ""}`;
    btn.textContent = label;
    btn.disabled = disabled;
    if (!disabled && !active) btn.addEventListener("click", () => goTo(page));
    browsePaginationEl.appendChild(btn);
  };

  const addEllipsis = () => {
    const span = document.createElement("span");
    span.className = "pkg-browse-page-ellipsis";
    span.textContent = "…";
    browsePaginationEl.appendChild(span);
  };

  addBtn("‹", browsePage - 1, { disabled: browsePage <= 1 });

  const pages = new Set([1, totalPages, browsePage]);
  for (let d = 1; d <= 2; d++) {
    pages.add(browsePage - d);
    pages.add(browsePage + d);
  }
  const visible = [...pages].filter((p) => p >= 1 && p <= totalPages).sort((a, b) => a - b);

  let prev = 0;
  for (const p of visible) {
    if (p - prev > 1) addEllipsis();
    addBtn(String(p), p, { active: p === browsePage });
    prev = p;
  }

  addBtn("›", browsePage + 1, { disabled: browsePage >= totalPages });
}

function createBrowseRow(pkg) {
  const source = browseSourceFor(pkg);
  const installed = browseInstalledSet.has(source);

  const row = document.createElement("div");
  row.className = "settings-extension-row pkg-browse-row";

  const info = document.createElement("div");
  info.className = "settings-extension-info";

  const name = document.createElement("div");
  name.className = "settings-extension-name";
  name.textContent = pkg.name;
  info.appendChild(name);

  if (pkg.description) {
    const description = document.createElement("div");
    description.className = "settings-extension-description";
    description.textContent = pkg.description;
    info.appendChild(description);
  }

  const badges = document.createElement("div");
  badges.className = "pkg-browse-badges";
  for (const t of pkg.types || []) {
    const badge = document.createElement("span");
    badge.className = "pkg-browse-badge";
    badge.dataset.type = t;
    badge.textContent = t;
    badges.appendChild(badge);
  }
  const downloads = document.createElement("span");
  downloads.className = "pkg-browse-meta";
  downloads.textContent = `${(pkg.downloads || 0).toLocaleString()}/mo`;
  badges.appendChild(downloads);
  info.appendChild(badges);

  const status = document.createElement("div");
  status.className = "settings-extension-status";
  status.hidden = true;
  info.appendChild(status);

  info.appendChild(buildBrowseLinks(pkg));

  const actions = document.createElement("div");
  actions.className = "settings-extension-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-value-btn";

  const canManage = nativeAvailable();
  if (!canManage) {
    button.disabled = true;
    setExtensionActionButton(button, t("extensions.desktopOnly"));
  } else {
    setExtensionActionButton(button, installed ? t("actions.uninstall") : t("actions.install"));
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.classList.add("loading");
      const previous = installed ? t("actions.uninstall") : t("actions.install");
      setExtensionActionButton(
        button,
        installed ? t("status.uninstalling") : t("status.installing"),
        true,
      );
      status.hidden = false;
      status.classList.remove("is-error");
      status.textContent = installed ? t("status.removing") : t("status.installing");
      status.title = status.textContent;
      try {
        if (installed) {
          await transport.removePiPackage(source);
          browseInstalledSet.delete(source);
        } else {
          await transport.installPiPackage(source);
          browseInstalledSet.add(source);
        }
        renderBrowsePackages();
      } catch (err) {
        renderPackageInstallFailure(status, err, installed ? "uninstall" : "install");
        button.disabled = false;
        button.classList.remove("loading");
        setExtensionActionButton(button, previous);
      }
    });
  }
  actions.appendChild(button);

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

if (browsePillsEl) {
  browsePillsEl.addEventListener("click", (event) => {
    const pill = event.target.closest(".pkg-browse-pill");
    if (!pill) return;
    browseActiveType = pill.dataset.pkgType || "all";
    for (const p of browsePillsEl.querySelectorAll(".pkg-browse-pill")) {
      p.classList.toggle("active", p === pill);
    }
    browsePage = 1;
    renderBrowsePackages();
  });
}

if (browseSearchEl) {
  browseSearchEl.addEventListener("input", () => {
    clearTimeout(browseSearchTimer);
    browseSearchTimer = setTimeout(() => {
      browseSearchQuery = browseSearchEl.value;
      browsePage = 1;
      renderBrowsePackages();
    }, 180);
  });
}

if (browseInstalledOnlyEl) {
  browseInstalledOnlyEl.addEventListener("change", () => {
    browseInstalledOnly = browseInstalledOnlyEl.checked;
    browsePage = 1;
    renderBrowsePackages();
  });
}

if (browseSortEl) {
  browseSortEl.value = browseSortMode;
  browseSortEl.addEventListener("change", () => {
    browseSortMode = browseSortEl.value || "downloads";
    browsePage = 1;
    renderBrowsePackages();
  });
}

// ═══════════════════════════════════════
// Auto-updater (Tauri-only)
// ═══════════════════════════════════════

const sidebarUpdateBtn = document.getElementById("sidebar-update-btn");
const updater = createAppUpdater({
  transport,
  appVersionValue: document.getElementById("setting-app-version-value"),
  updaterSection: document.getElementById("setting-updater-section"),
  checkUpdatesBtn: document.getElementById("btn-check-updates"),
  updateStatusRow: document.getElementById("setting-update-status-row"),
  updateStatusEl: document.getElementById("setting-update-status"),
  updateInstallRow: document.getElementById("setting-update-install-row"),
  updateInstallLabel: document.getElementById("setting-update-install-label"),
  installUpdateBtn: document.getElementById("btn-install-update"),
  sidebarUpdateBtn,
  onOpenSettings: async () => {
    await openSettings();
    selectSettingsTab("general");
  },
});
void updater.initUpdaterUI();

// Native capabilities arrive asynchronously over the broker WS (the handshake
// frame lands right after connect). Re-evaluate native-gated UI once it's known
// so buttons that were hidden on first paint appear when attached to the host.
wsClient.addEventListener("capabilities", () => {
  refreshHeaderOpenAppButton();
  void loadHeaderOpenApps();
  void updater.initUpdaterUI();
});

function buildThemeGrid() {
  themeGrid.innerHTML = "";
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement("button");
    btn.className = `theme-swatch${current === id ? " active" : ""}`;
    const dots = (theme.colors || [])
      .map((c) => `<span class="swatch-dot" style="background:${c}"></span>`)
      .join("");
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener("click", () => {
      applyTheme(id);
      themeGrid.querySelectorAll(".theme-swatch").forEach((s) => {
        s.classList.remove("active");
      });
      btn.classList.add("active");
    });
    themeGrid.appendChild(btn);
  }
}

function buildLanguageSelector() {
  if (!languageOptions) return;
  languageOptions.innerHTML = "";
  const current = getLanguagePreference();

  for (const lang of LANGUAGES) {
    const btn = document.createElement("button");
    btn.className = `theme-swatch${current === lang.value ? " active" : ""}`;
    btn.textContent = lang.nativeLabel ?? t(lang.labelKey);
    btn.addEventListener("click", () => {
      setLocale(lang.value).then(() => buildLanguageSelector());
    });
    languageOptions.appendChild(btn);
  }
}

onLocaleChange(buildLanguageSelector);

async function openSettings() {
  settingsPanel.classList.remove("hidden");
  messagesContainer.style.display = "none";
  document.querySelector(".input-area").style.display = "none";
  document.querySelector(".mode-link:first-child")?.classList.remove("active");
  selectSettingsTab("general");
  buildThemeGrid();
  buildLanguageSelector();
  if (piVersionValue) {
    piVersionValue.textContent = piVersionCache || t("status.loading");
  }
  setTimeout(() => {
    if (!settingsPanel.classList.contains("hidden")) loadPiVersion();
  }, 300);
  void refreshLanUrl();
  // Fetch current state for toggles
  try {
    const resp = await fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "get_state" }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? " on" : ""}`;
      // Thinking level
      btnThinkingLevel.textContent = formatThinkingLevelLabel(s.thinkingLevel);
      currentThinkingLevel = s.thinkingLevel || "off";
      updateThinkingBtn();
      // Session name
      inputSessionName.value = s.sessionName || "";
    }
  } catch (_e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: "get_auth" });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = "";
      toggleAuth.className = `settings-toggle${authData.data.enabled ? " on" : ""}`;
    } else {
      authSection.style.display = "none";
    }
  } catch {
    authSection.style.display = "none";
  }
}

function closeSettings() {
  settingsPanel.classList.add("hidden");
  messagesContainer.style.display = "";
  document.querySelector(".input-area").style.display = "";
  document.querySelector(".mode-link:first-child")?.classList.add("active");
}

async function openUpdatesFromSidebar() {
  await updater.openUpdatesFromSidebar();
}

settingsBtn.addEventListener("click", openSettings);
sidebarUpdateBtn?.addEventListener("click", () => {
  openUpdatesFromSidebar().catch((err) => {
    console.warn("[updater] unable to open updates from sidebar:", err);
  });
});
settingsClose.addEventListener("click", closeSettings);
settingsOverlay?.addEventListener("click", closeSettings);
settingsNavItems.forEach((item) => {
  item.addEventListener("click", () => {
    selectSettingsTab(item.dataset.settingsTab || "general");
  });
});

setupSettingsToggles({
  toggleAutoCompact,
  btnThinkingLevel,
  toggleShowThinking,
  toggleAuth,
  rpcCommand,
  getCurrentThinkingLevel: () => currentThinkingLevel,
  setCurrentThinkingLevel: (level) => {
    currentThinkingLevel = level;
  },
  updateThinkingBtn,
});

({ loadApiKeysPanel, loadInlineConfigEditor, loadInlineModelsEditor } = setupSettingsEditors({
  rpcCommand,
  closeSettings,
  onModelConfigurationChanged: async () => {
    await fetchModelInfo();
    updateUI();
  },
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
}));

// Restore saved theme, then initialize i18n before any UI setup that calls t()
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);
await initI18n();

setupContextViz({
  tokenUsageEl,
  contextViz: document.getElementById("context-viz"),
  contextBar: document.getElementById("context-bar"),
  contextLegend: document.getElementById("context-legend"),
  contextVizUsed: document.getElementById("context-viz-used"),
  contextVizTotal: document.getElementById("context-viz-total"),
  getUsage: () => lastUsage,
  getContextWindowSize: () => contextWindowSize,
});

setupVoiceInput({
  micBtn: document.getElementById("mic-btn"),
  messageInput,
});

// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, collapse model bar above input
if (isMobile()) {
  sidebarEl.classList.add("collapsed");

  const mobileBar = document.getElementById("mobile-model-bar");

  // Start collapsed
  mobileBar.classList.add("collapsed");

  // Toggle via chevron
  const contextToggle = document.getElementById("mobile-context-toggle");
  contextToggle.addEventListener("click", () => {
    mobileBar.classList.toggle("collapsed");
    contextToggle.classList.toggle("flipped", !mobileBar.classList.contains("collapsed"));
  });
}

// Make the Picot icon in sidebar switch back to chat
document.querySelector(".mode-link:first-child")?.addEventListener("click", () => {
  closeSettings();
});

// ═══════════════════════════════════════
// Open Folder as workspace
// ═══════════════════════════════════════

async function handleOpenFolder() {
  if (workspaceLaunchInProgress) return;
  setWorkspaceLaunchInProgress(true);
  try {
    await openFolderAsWorkspace({
      transport,
      fetchInstances,
      getCurrentPort: getActivePort,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      renderError: (message) => messageRenderer.renderError(message),
    });
  } finally {
    setWorkspaceLaunchInProgress(false);
  }
}

openFolderBtn?.addEventListener("click", handleOpenFolder);

wsClient.connect();
dismissBootSwapOverlayWhenReady();
renderWorkspaceWelcome();
sidebar.loadSessions().then(() => {
  sessionsLoaded = true;
  updateUI();
  if (!hasAnySessionsLoaded()) {
    renderWorkspaceWelcome();
  }
  if (deferredMirrorSync) {
    const syncData = deferredMirrorSync;
    deferredMirrorSync = null;
    handleMirrorSync(syncData);
  }
  if (isMirrorMode) updateMirrorLiveIndicator();
});

// Dismiss mobile splash screen
const splash = document.getElementById("mobile-splash");
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add("hidden");
    setTimeout(() => splash.remove(), 300);
  });
}

console.log("🚀 Picot initialized");
