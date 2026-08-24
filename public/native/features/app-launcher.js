import { initI18n, t } from "../../i18n.js";
import { applyTheme, getCurrentTheme } from "../../themes.js";
import { SessionSidebar } from "../session/session-sidebar.js";
import { HostControlGateway } from "../transport/control-gateway.js";
import { HostDataGateway } from "../transport/data-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "../transport/runtime-adapter.js";
import { sessionScopedClientId } from "../utils/random-id.js";
import { appRoutePath } from "../utils/router.js";
import { setupOpenFolderButton } from "../workspace/workspace-actions.js";
import {
  claimDeviceAccess,
  clearPendingDeviceRequest,
  createDeviceAccessRequest,
  DEVICE_TOKEN_KEY,
  pendingDeviceRequest,
  resolveRemoteAuth,
} from "./remote-auth.js";

document.body.dataset.runtime = "native";
document.body.classList.add("app-launcher");
clearSessionSwapOverlay();

try {
  applyTheme(getCurrentTheme());
  await initI18n();
  prepareLauncherShell();
  await startLauncher();
} catch (error) {
  prepareLauncherShell();
  showLauncherError(error);
}

async function startLauncher() {
  const remoteAuth = await resolveRemoteAuth();
  setupSidebarToggle();

  if (remoteAuth.clientType === "remote" && !remoteAuth.deviceToken) {
    setupRemoteAccessLauncher();
    return;
  }

  setupOpenFolderButton({ onError: showLauncherError });

  const adapter = new HostRuntimeAdapter({
    url: resolveHostWebSocketUrl(window),
    clientId: sessionScopedClientId(remoteAuth.clientType),
    clientType: remoteAuth.clientType,
    deviceToken: remoteAuth.deviceToken,
  });
  const data = new HostDataGateway(adapter, { deviceToken: remoteAuth.deviceToken });
  const control = new HostControlGateway(adapter);
  const sidebar = new SessionSidebar(document.getElementById("session-list"), {
    data,
    runtime: null,
    control,
    config: null,
    getTarget: () => null,
    onSelect: (session) => openLauncherSession(session, { control }).catch(showLauncherError),
    onCreateSession: null,
    onSessionsLoaded: null,
    onAgentInboxSessionChange: null,
    loadSessions: () => data.listLauncherSessions(),
    cacheScope: "launcher",
  });

  setupSidebarSearch(sidebar);
  setupRefresh(sidebar);
  adapter.connect();
  sidebar.load().catch(showLauncherError);
}

export async function openLauncherSession(
  session,
  { control, navigate = (path) => window.location.assign(path) },
) {
  if (!session?.id || !session?.projectPath) throw new Error(t("launcher.invalidSession"));
  const workspaceId = await control.resolveWorkspace(session.projectPath);
  const path = appRoutePath({ name: "session", workspaceId, sessionId: session.id });
  navigate(path);
}

function clearSessionSwapOverlay() {
  document.body.classList.remove("swapping-instance");
  document.documentElement.classList.remove("swapping-instance-pending");
  document.getElementById("instance-swap-overlay")?.removeAttribute("data-visible");
  try {
    sessionStorage.removeItem("pi-studio:swapping-instance");
  } catch {
    // Storage is best-effort; the DOM state above is authoritative.
  }
}

function prepareLauncherShell() {
  document.getElementById("new-session-btn")?.classList.add("hidden");
  document.querySelector(".sidebar-primary-nav")?.classList.add("hidden");
  document.querySelector(".sidebar-footer")?.classList.add("hidden");

  const header = document.querySelector(".session-header");
  const headerLeft = header?.querySelector(".header-left");
  const toggle = document.getElementById("sidebar-toggle");
  if (headerLeft && toggle) {
    headerLeft.replaceChildren(toggle);
    const title = document.createElement("h1");
    title.className = "launcher-header-title";
    title.textContent = t("launcher.title");
    headerLeft.appendChild(title);
  }
  header?.querySelector(".header-right")?.classList.add("hidden");

  const hint = document.querySelector("#messages .welcome .hint");
  if (hint) hint.textContent = t("launcher.hint");
  document.querySelector("#messages .shortcuts-hint")?.classList.add("hidden");

  const composer = document.getElementById("composer-card");
  composer?.setAttribute("aria-disabled", "true");
  composer?.querySelectorAll("button, input, textarea, select").forEach((control) => {
    control.disabled = true;
  });
  const messageInput = document.getElementById("message-input");
  if (messageInput) messageInput.placeholder = t("launcher.composerHint");
}

function setupRemoteAccessLauncher({
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  reload = () => window.location.reload(),
} = {}) {
  const sessionList = document.getElementById("session-list");
  sessionList?.replaceChildren();
  const welcome = document.querySelector("#messages .welcome");
  if (!welcome) return () => {};
  const existing = welcome.querySelector(".launcher-access");
  existing?.remove();
  const container = document.createElement("section");
  container.className = "launcher-access";
  const copy = document.createElement("p");
  copy.className = "launcher-access-copy";
  copy.textContent = t("launcher.accessHint");
  const status = document.createElement("p");
  status.className = "launcher-access-status";
  status.setAttribute("role", "status");
  const error = document.createElement("p");
  error.className = "launcher-error";
  error.setAttribute("role", "alert");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ui-button ui-button--primary launcher-access-button";
  container.append(copy, status, error, button);
  welcome.appendChild(container);

  let stopped = false;
  let timer = null;
  let request = pendingDeviceRequest(storage);
  let backoff = request?.pollAfterMs || 1500;

  const setState = (state, message = "") => {
    button.textContent =
      state === "waiting" ? t("launcher.waitingApproval") : t("launcher.requestAccess");
    button.disabled = state === "waiting" || state === "requesting";
    button.setAttribute(
      "aria-busy",
      state === "requesting" || state === "waiting" ? "true" : "false",
    );
    status.textContent = message;
    error.textContent = "";
  };
  const schedule = (delay = backoff) => {
    if (stopped || document.visibilityState === "hidden" || navigator.onLine === false) return;
    clearTimeout(timer);
    timer = setTimeout(poll, delay);
  };
  const poll = async () => {
    if (stopped || !request || document.visibilityState === "hidden" || navigator.onLine === false)
      return;
    try {
      const result = await claimDeviceAccess({ ...request, fetchImpl });
      if (stopped) return;
      if (result.status === 200 && result.body?.deviceToken) {
        storage.setItem(DEVICE_TOKEN_KEY, result.body.deviceToken);
        clearPendingDeviceRequest(storage);
        request = null;
        status.textContent = t("launcher.accessApproved");
        reload();
        return;
      }
      if (result.status === 202) {
        backoff = request.pollAfterMs || 1500;
        setState("waiting", t("launcher.waitingApproval"));
        schedule(backoff);
        return;
      }
      if (result.status === 403 || result.status === 404 || result.status === 410) {
        clearPendingDeviceRequest(storage);
        request = null;
        setState(
          "retry",
          result.status === 403 ? t("launcher.accessDenied") : t("launcher.accessExpired"),
        );
        return;
      }
      throw new Error("claim failed");
    } catch {
      if (stopped) return;
      backoff = Math.min(backoff * 2, 15000);
      error.textContent = t("launcher.accessNetworkError");
      schedule(backoff);
    }
  };
  const begin = async () => {
    if (button.disabled) return;
    setState("requesting", t("launcher.requestingAccess"));
    try {
      request = await createDeviceAccessRequest({ fetchImpl, storage });
      backoff = request.pollAfterMs || 1500;
      setState("waiting", t("launcher.waitingApproval"));
      schedule(0);
    } catch (requestError) {
      setState("retry");
      error.textContent =
        requestError instanceof Error ? requestError.message : t("launcher.accessNetworkError");
    }
  };
  button.addEventListener("click", begin);
  const resume = () => request && schedule(0);
  const cleanup = () => {
    stopped = true;
    clearTimeout(timer);
    button.removeEventListener("click", begin);
    window.removeEventListener("online", resume);
    document.removeEventListener("visibilitychange", resume);
    window.removeEventListener("pagehide", cleanup);
  };
  window.addEventListener("online", resume);
  document.addEventListener("visibilitychange", resume);
  window.addEventListener("pagehide", cleanup);
  if (request) {
    setState("waiting", t("launcher.waitingApproval"));
    schedule(0);
  } else {
    setState("idle");
  }
  return cleanup;
}

export { setupRemoteAccessLauncher };

function setupSidebarToggle() {
  const sidebar = document.getElementById("sidebar");
  const toggle = document.getElementById("sidebar-toggle");
  const overlay = document.getElementById("sidebar-overlay");
  if (!sidebar || !toggle) return;
  const isMobile = () => window.innerWidth <= 768;
  const setCollapsed = (collapsed) => {
    sidebar.classList.toggle("collapsed", collapsed);
    overlay?.classList.toggle("visible", !collapsed && isMobile());
  };
  if (isMobile()) setCollapsed(true);
  toggle.addEventListener("click", () => setCollapsed(!sidebar.classList.contains("collapsed")));
  overlay?.addEventListener("click", () => setCollapsed(true));
}

function setupSidebarSearch(sidebar) {
  const input = document.getElementById("session-search-input");
  const clear = document.getElementById("session-search-clear");
  input?.addEventListener("input", () => {
    sidebar.setSearchQuery(input.value);
    clear?.classList.toggle("hidden", input.value.length === 0);
  });
  clear?.addEventListener("click", () => {
    input.value = "";
    sidebar.setSearchQuery("");
    clear.classList.add("hidden");
    input.focus();
  });
}

function setupRefresh(sidebar) {
  document.getElementById("refresh-sessions-btn")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    button.classList.remove("spinning");
    void button.offsetWidth;
    button.classList.add("spinning");
    sidebar.load().catch(showLauncherError);
  });
}

function showLauncherError(error) {
  const welcome = document.querySelector("#messages .welcome");
  if (!welcome) return;
  let alert = welcome.querySelector(".launcher-error");
  if (!alert) {
    alert = document.createElement("p");
    alert.className = "launcher-error";
    alert.setAttribute("role", "alert");
    welcome.appendChild(alert);
  }
  alert.textContent = error instanceof Error ? error.message : String(error);
}
