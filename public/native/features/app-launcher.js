import { initI18n, t } from "../../i18n.js";
import { applyTheme, getCurrentTheme } from "../../themes.js";
import { SessionSidebar } from "../session/session-sidebar.js";
import { HostControlGateway } from "../transport/control-gateway.js";
import { HostDataGateway } from "../transport/data-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "../transport/runtime-adapter.js";
import { sessionScopedClientId } from "../utils/random-id.js";
import { appRoutePath } from "../utils/router.js";
import { setupOpenFolderButton } from "../workspace/workspace-actions.js";
import { resolveRemoteAuth } from "./remote-auth.js";

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
  setupOpenFolderButton({ onError: showLauncherError });

  if (remoteAuth.clientType === "remote" && !remoteAuth.deviceToken) {
    showPairingRequired();
    return;
  }

  const adapter = new HostRuntimeAdapter({
    url: resolveHostWebSocketUrl(window),
    clientId: sessionScopedClientId(remoteAuth.clientType),
    clientType: remoteAuth.clientType,
    deviceToken: remoteAuth.deviceToken,
  });
  const data = new HostDataGateway(adapter);
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

function showPairingRequired() {
  const message = t("launcher.pairingRequired");
  const sessionList = document.getElementById("session-list");
  if (sessionList) {
    const status = document.createElement("div");
    status.className = "session-loading";
    status.textContent = message;
    sessionList.replaceChildren(status);
  }

  const welcome = document.querySelector("#messages .welcome");
  if (!welcome) return;
  const form = document.createElement("form");
  form.className = "launcher-pairing";
  const help = document.createElement("p");
  help.textContent = t("launcher.pairingHelp");
  const input = document.createElement("input");
  input.className = "ui-input";
  input.placeholder = t("launcher.pairingInput");
  input.setAttribute("aria-label", t("launcher.pairingInput"));
  const button = document.createElement("button");
  button.type = "submit";
  button.className = "ui-button ui-button--primary";
  button.textContent = t("launcher.pairDevice");
  const error = document.createElement("p");
  error.className = "launcher-pairing-error";
  error.setAttribute("role", "alert");
  form.append(help, input, button, error);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const path = pairingPathFromInput(input.value);
    if (!path) {
      error.textContent = t("launcher.invalidPairing");
      input.focus();
      return;
    }
    window.location.assign(path);
  });
  welcome.appendChild(form);
}

export function pairingPathFromInput(value, origin = window.location.origin) {
  const input = String(value ?? "").trim();
  if (!input) return null;
  let token = input;
  try {
    token = new URL(input).searchParams.get("pairingToken") ?? "";
  } catch {
    try {
      token = decodeURIComponent(input);
    } catch {
      return null;
    }
  }
  if (!token.startsWith("picot_pair_")) return null;
  const target = new URL("/app", origin);
  target.searchParams.set("pairingToken", token);
  return `${target.pathname}${target.search}`;
}

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
