import { FilePreviewPanel } from "../file-preview-panel.js";
import { initI18n, onLocaleChange, t } from "../i18n.js";
import { reconcileSnapshotTarget } from "../session/bootstrap-target.js";
import { dispatchSuperAgentTaskNative } from "../super-agent/native-dispatch.js";
import { isSuperAgentProjectPath } from "../super-agent/session.js";
import { isSuperAgentEnabled } from "../super-agent/settings.js";
import { selectSuperAgentStartupAction } from "../super-agent/startup-flow.js";
import { buildTaskComposerPrompt, markTaskChildSessionBound } from "../super-agent/task-state.js";
import { updateSuperAgentTask } from "../super-agent/task-store.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { setupAtFileMention } from "../ui/at-file-mention.js";
import { ConvNav } from "../ui/conv-nav.js";
import { setupMessagesInsets } from "../ui/layout-insets.js";
import { MessageRenderer } from "../ui/message-renderer.js";
import { createProcessDetailsGroup, summarizeProcessGroup } from "../ui/process-group.js";
import { setupResizablePanel } from "../ui/resizable-panel.js";
import { ToolCardRenderer } from "../ui/tool-card.js";
import { setupComposerAutoResize } from "./composer/composer-autoresize.js";
import { setupComposerImageAttachments } from "./composer/composer-images.js";
import { setupComposerSlashMenu } from "./composer/composer-slash-menu.js";
import { setupComposerSubmitHandling } from "./composer/composer-submit.js";
import { renderQueuedMessages } from "./composer/queued-messages.js";
import { buildCommandCatalog, resolveComposerInput } from "./composer/slash-commands.js";
import { setupCommandPalette } from "./extensions/command-palette.js";
import { showNativeDialog } from "./extensions/dialog.js";
import { ExtensionUiHost } from "./extensions/extension-ui-host.js";
import { showInlineExtensionPrompt } from "./extensions/inline-extension-prompt.js";
import { setupAppUpdater } from "./features/app-updater.js";
import { refreshLanQrButton, setupLanQr } from "./features/lan-qr.js";
import { resolveRemoteAuth } from "./features/remote-auth.js";
import {
  isRpivTodoCommandNotify,
  isRpivTodoWidgetRequest,
  RpivTodoMirrorPanel,
} from "./features/rpiv-todo-mirror.js";
import { setupTerminalPanel } from "./features/terminal-panel-integration.js";
import { createNotificationCenter } from "./notifications/notification-center.js";
import { createTaskCompletionNotifications } from "./notifications/task-completion-notifications.js";
import { setupSessionInfo } from "./session/session-info.js";
import { createSessionSelectionHandler } from "./session/session-navigation.js";
import { setupSessionSearchDialog } from "./session/session-search-dialog.js";
import { SessionSidebar } from "./session/session-sidebar.js";
import { createSessionStore, reduceSessionState } from "./session/session-store.js";
import { setupSettingsPanel } from "./settings/settings-panel.js";
import { resolveBootstrapTarget } from "./transport/bootstrap-target.js";
import { ConfigGateway } from "./transport/config-gateway.js";
import {
  setupConfigGatewayConnectionListener,
  signalConfigGatewayReady,
} from "./transport/config-gateway-readiness.js";
import { HostControlGateway } from "./transport/control-gateway.js";
import { HostDataGateway } from "./transport/data-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "./transport/runtime-adapter.js";
import { RuntimeGateway } from "./transport/runtime-gateway.js";
import { setupAppKeyboardShortcuts } from "./utils/keyboard-shortcuts.js";
import { randomId } from "./utils/random-id.js";
import { appRoutePath, parseAppRoute, replaceTemporarySessionRoute } from "./utils/router.js";
import { findLatestAssistantUsage, setupContextUsage } from "./workspace/context-usage.js";
import { NativeFileBrowser, toggleExclusiveSidePanel } from "./workspace/file-browser.js";
import { setupHeaderOpenApp } from "./workspace/header-open-app.js";
import { setupProjectHeader } from "./workspace/project-header.js";
import {
  createSessionViaHost,
  openSessionInProjectViaHost,
  resolveWorkspaceViaHost,
  setupNewSessionButton,
  setupOpenFolderButton,
  spawnSessionViaHost,
} from "./workspace/workspace-actions.js";

// Declared before the first `await` in this module: `hydrateSnapshotOnce()`
// is called both from the runtime-event subscriber and from the startup
// try-block, either of which can run while the module is paused at a later
// `await`. Declaring this variable after those awaits would leave it in the
// TDZ and cause "Cannot access 'snapshotInFlight' before initialization" when
// the handler fires before module evaluation reaches the `let` line.
let snapshotInFlight = false;
const route = parseAppRoute(window.location.pathname);
if (route.name !== "session") throw new Error("Native Picot requires a session route");

applyTheme(getCurrentTheme());
await initI18n();
document.body.dataset.runtime = "native";

const messagesElement = document.getElementById("messages");
const headerElement = document.querySelector(".header");
const scrollBottomBadge = document.getElementById("scroll-bottom-badge");
const convNav = new ConvNav({
  messagesEl: messagesElement,
  headerEl: headerElement,
  badgeEl: scrollBottomBadge,
});
const notifications = createNotificationCenter();
const taskCompletionNotifications = createTaskCompletionNotifications({
  title: () => t("settings.taskCompleteTitle"),
  body: () => t("settings.taskCompleteMessage"),
});

setupMessagesInsets({
  main: document.querySelector(".main"),
  messages: messagesElement,
  header: document.querySelector(".header"),
  inputArea: document.querySelector(".input-area"),
  workspaceContent: document.querySelector(".workspace-content"),
});
const messageRenderer = new MessageRenderer(messagesElement);
const toolRenderer = new ToolCardRenderer(messagesElement);
const input = document.getElementById("message-input");
const form = document.getElementById("chat-form");
const abortButton = document.getElementById("abort-btn");
const sendButton = document.getElementById("send-btn");
const statusText = document.getElementById("status-text");
const statusIndicator = document.getElementById("status-indicator");
const composerCard = document.getElementById("composer-card");
const commandButton = document.getElementById("command-btn");
const commandPalette = document.getElementById("command-palette");
const commandPaletteOverlay = document.getElementById("command-palette-overlay");
const commandList = document.getElementById("command-list");
const attachButton = document.getElementById("attach-btn");
const imageInput = document.getElementById("image-input");
const imagePreviews = document.getElementById("image-previews");
const skillSlashMenu = document.getElementById("skill-slash-menu");
const atFileMentionMenu = document.getElementById("at-file-mention-menu");
const composerAutoResize = setupComposerAutoResize({ input });
const queuedMessages = document.getElementById("queued-messages");
const todoMirrorPanel = new RpivTodoMirrorPanel({
  container: document.querySelector(".input-area"),
});

// ── Composer model dropdown & thinking button ─────────────────────────────────
const modelDropdown = document.getElementById("model-dropdown");
const modelDropdownBtn = document.getElementById("model-dropdown-btn");
const modelDropdownLabel = document.getElementById("model-dropdown-label");
const modelDropdownMenu = document.getElementById("model-dropdown-menu");
const modelDropdownToolbar = modelDropdown?.closest(".composer-toolbar");
const thinkingBtn = document.getElementById("thinking-btn");
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

function formatThinkingLevelLabel(level) {
  const normalizedLevel = level || "off";
  const key = `settings.thinkingLevels.${normalizedLevel}`;
  const label = t(key);
  return label === key ? normalizedLevel : label;
}
let currentThinkingLevel = "off";
let currentModelId = null;
let currentModelContextWindow = 0;
let availableModels = [];
let target = provisionalTargetFromRoute(route);
let configGatewayTargetReady = false;
let resolveConfigGatewayReady;
const configGatewayReady = new Promise((resolve) => {
  resolveConfigGatewayReady = resolve;
});
let store = createSessionStore(target);
let navigationGeneration = 0;
let commandCatalog = buildCommandCatalog({});
let streamingElement = null;
let sidebar = null;
const sessionInfo = setupSessionInfo({
  toggle: document.getElementById("session-info-toggle"),
  panel: document.getElementById("session-info-panel"),
  fileValue: document.getElementById("session-info-file"),
  idValue: document.getElementById("session-info-id"),
  getTarget: () => target,
  getSessions: () => sidebar?.sessions ?? [],
});
let activeSearchQuery = "";
// Auto-launch guard. Stored in sessionStorage (not a module variable) so it
// survives same-window `window.navigate()` reloads: when the user selects
// another project's session the inbox window reloads at the new URL, and
// without a durable guard auto-launch would immediately yank the window back
// to the Agent Inbox. sessionStorage is per-window/tab, so a genuinely new
// window still auto-launches once.
const SUPER_AGENT_LAUNCHED_KEY = "pi-studio-super-agent-launched";
function wasSuperAgentLaunched() {
  try {
    return sessionStorage.getItem(SUPER_AGENT_LAUNCHED_KEY) === "1";
  } catch {
    return false;
  }
}
function markSuperAgentLaunched() {
  try {
    sessionStorage.setItem(SUPER_AGENT_LAUNCHED_KEY, "1");
  } catch {
    // sessionStorage may be unavailable; auto-launch simply repeats.
  }
}
let pendingBoundSessionFirstMessage = null;
let superAgentEnsureInFlight = null;

// Maps a dispatched child runtime instanceId -> Agent Inbox task id, so
// `session_bound` events from the background child can upgrade the task's
// temporary child session id to the persisted one.
//
// Declared before the first `await` below: once `adapter.connect()` runs,
// background runtime events can arrive and call `bindDispatchedChildSession`
// (which reads this map) any time later top-level `await`s yield control
// back to the event loop — before the rest of this module's top-level code
// has finished executing. Declaring it late (as a later top-level `const`)
// caused a "Cannot access 'dispatchedInstances' before initialization" TDZ
// crash that could abort session creation on fresh installs.
const dispatchedInstances = new Map();

const remoteAuth = await resolveRemoteAuth();

const adapter = new HostRuntimeAdapter({
  url: resolveHostWebSocketUrl(window),
  clientId: sessionScopedClientId(remoteAuth.clientType),
  clientType: remoteAuth.clientType,
  deviceToken: remoteAuth.deviceToken,
});
setupTerminalPanel({
  adapter,
  getWorkspaceId: () => target.workspaceId,
  native: remoteAuth.clientType === "desktop",
});
const runtime = new RuntimeGateway(adapter);
const data = new HostDataGateway(adapter, { fetchImpl: window.fetch.bind(window) });
const control = new HostControlGateway(adapter);
const config = new ConfigGateway({
  runtime,
  getTarget: () => target,
  waitUntilReady: () => (configGatewayTargetReady ? Promise.resolve() : configGatewayReady),
});
window.__picotConfigCall = (op, params, options) => config.call(op, params, options);
const contextUsage = setupContextUsage();
const compactContextButton = document.getElementById("compact-context-btn");
const filePreviewPanel = setupFilePreviewPanel();
// Owned by setupFileBrowser() once the sidebar DOM is ready. Kept at module
// scope so openFilesPanel() (the workspace-path pill handler) can refresh it
// after expanding the sidebar — mirroring the toolbar button's behavior.
let fileBrowser = null;

/**
 * Expand the file sidebar and (when newly opened) load the workspace root.
 * Wired to both the #file-sidebar-toggle button, the Cmd/Ctrl+B shortcut,
 * and the #workspace-indicator path pill.
 */
function openFilesPanel() {
  const sidebar = document.getElementById("file-sidebar");
  if (!sidebar) return;
  const opened = toggleExclusiveSidePanel(sidebar, [document.getElementById("diff-sidebar")]);
  if (opened && fileBrowser?.currentPath === null) fileBrowser.load().catch(showError);
}
const sessionCostEl = document.getElementById("session-cost");
let sessionTotalCost = 0;

function computeTotalCostFromMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const msg of messages) {
    if (msg?.usage?.cost?.total) total += Number(msg.usage.cost.total) || 0;
  }
  return total;
}

function setSessionCost(cost) {
  sessionTotalCost = cost;
  if (!sessionCostEl) return;
  if (!cost || cost <= 0) {
    sessionCostEl.classList.remove("visible");
    sessionCostEl.textContent = "";
    return;
  }
  sessionCostEl.classList.add("visible");
  sessionCostEl.textContent = `$${cost.toFixed(4)}`;
  sessionCostEl.title = `Session cost: $${cost.toFixed(6)}`;
}

async function requestManualCompaction() {
  if (
    !contextUsage.canCompact ||
    store.lifecycle === "working" ||
    store.compaction?.status === "running"
  )
    return;
  contextUsage.setCompacting(true);
  try {
    await runtime.request({ type: "compact" }, target, { idempotencyKey: randomId() });
  } catch (error) {
    contextUsage.setCompacting(false);
    throw error;
  }
}

compactContextButton?.addEventListener("click", () => requestManualCompaction().catch(showError));
const extensionUi = new ExtensionUiHost({
  runtime,
  showDialog: (request, opts) => showNativeDialog(request, undefined, opts),
  showInlinePrompt: (request, opts) =>
    showInlineExtensionPrompt(request, { container: messagesElement, ...opts }),
  hooks: {
    notify: (request) => {
      // Configuration data-plane responses arrive as notify events; swallow
      // them so they don't render as chat messages.
      if (config.consumeNotify(request)) return;
      // rpiv-todo's /todos command emits a centered notify transcript. Picot
      // already mirrors the same state natively, so expand the panel instead
      // of rendering a duplicate system message.
      if (isRpivTodoCommandNotify(request.message)) {
        todoMirrorPanel.expand();
        return;
      }
      messageRenderer.renderSystemMessage(request.message || "");
    },
    status: (request) => setStatus(request.statusText || "Connected"),
    title: (request) => {
      if (request.title) document.title = request.title;
    },
    editorText: (request) => {
      input.value = request.text || "";
      composerAutoResize.sync();
      input.focus();
    },
    widget: (request) => {
      // rpiv-todo owns the tool/reducer; Picot renders a native mirror from
      // the persisted todo tool-result snapshots instead of the TUI widget.
      if (isRpivTodoWidgetRequest(request)) return;
    },
  },
});
await extensionUi.setForegroundSession(target.sessionId, { flush: false });
await extensionUi.flushForegroundQueue();

const hydrateFromSnapshot = async (snapshot) => {
  await adoptTarget(reconcileSnapshotTarget(target, snapshot.target));
  store = reduceSessionState(store, snapshot);
  renderHistory(snapshot.state.messages ?? []);
  todoMirrorPanel.hydrateFromMessages(snapshot.state.messages ?? []);
  renderQueuedMessages(queuedMessages, store.queue);
  convNav.rebuild();
  const pi = snapshot.state.pi ?? {};
  setStatus(pi.isStreaming ? "Working…" : "Connected");
  contextUsage.setWorking(Boolean(pi.isStreaming));
  contextUsage.setCompacting(snapshot.state.compaction?.status === "running");
  updateComposerModel(pi.model ?? null);
  updateComposerThinking(pi.thinkingLevel ?? "off");
  contextUsage.setUsage(
    findLatestAssistantUsage(snapshot.state.messages),
    currentModelContextWindow,
  );
  setSessionCost(computeTotalCostFromMessages(snapshot.state.messages ?? []));
  // Flush queued extension prompts after rendering is settled so inline cards
  // are not immediately destroyed by a subsequent renderHistory() clear.
  await extensionUi.flushForegroundQueue();
};

runtime.subscribe((frame) => {
  if (frame.type !== "runtime_event") return;
  taskCompletionNotifications.handleRuntimeFrame(frame);
  if (
    frame.target.instanceId !== target.instanceId ||
    (frame.target.sessionId && frame.target.sessionId !== target.sessionId)
  ) {
    handleBackgroundRuntimeEvent(frame).catch(showError);
    return;
  }
  const previous = store;
  store = reduceSessionState(store, frame);
  if (!previous.snapshotRequired && store.snapshotRequired) {
    // Use hydrateSnapshotOnce to deduplicate concurrent calls (e.g. when the
    // subscriber fires at the same time as the startup try-block) and to
    // silently retry on brief WebSocket disconnections that can occur during
    // project switches, instead of rendering error messages that are quickly
    // overwritten once the connection stabilises.
    hydrateSnapshotOnce().catch(showError);
    return;
  }
  if (previous.queue !== store.queue) renderQueuedMessages(queuedMessages, store.queue);
  handleRuntimeEvent(frame.event).catch(showError);
});
setupConfigGatewayConnectionListener({
  adapter,
  isReady: () => configGatewayTargetReady,
  onDisconnected: () => setStatus("Disconnected"),
});
adapter.connect();

// Wire DOM-only event handlers immediately, before any network awaits, so the
// UI (settings overlay, file browser, composer, abort) stays responsive even
// when the runtime connection is slow, hangs, or fails. Previously these were
// attached after `await adapter.ready()/hydrateSnapshot()/loadCommands()`, so a
// stalled runtime left the settings button dead ("can't open settings").
setupSessionSidebar();
sidebar?.load().catch(showError);
setupSidebarToggle();
if (atFileMentionMenu) {
  // @-file mention completion must be wired before the Enter-to-send listener
  // so it can intercept Enter/Tab/Escape while its listbox is open.
  setupAtFileMention({
    input,
    container: atFileMentionMenu,
    getWorkspaceRoot: () => target.workspaceId,
    searchFiles: async (workspaceId, query, signal) => {
      const url = new URL("/api/file-mentions", window.location.origin);
      url.searchParams.set("workspaceId", workspaceId);
      url.searchParams.set("query", query);
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`File mention search failed: ${response.status}`);
      return response.json();
    },
  });
}
setupComposerSubmitHandling({
  input,
  form,
  onSubmit: ({ altKey }) => {
    sendComposerInput({ altKey }).catch(showError);
  },
});
abortButton?.addEventListener("click", abortCurrentRun);
messagesElement.addEventListener("messagefork", async (event) => {
  const { entryId } = event.detail;
  try {
    const result = await runtime.request({ type: "fork", entryId }, target, {
      idempotencyKey: randomId(),
    });
    const data = result?.response?.data;
    if (!data?.cancelled && data?.text != null) {
      input.value = data.text;
      composerAutoResize.sync();
      input.focus();
    }
  } catch (error) {
    showError(error);
  }
});
document.getElementById("refresh-sessions-btn")?.addEventListener("click", (e) => {
  const btn = /** @type {HTMLButtonElement} */ (e.currentTarget);
  btn.classList.remove("spinning");
  // Force reflow so re-adding the class restarts the animation
  void btn.offsetWidth;
  btn.classList.add("spinning");
  ensureSuperAgentStartupSession({ reloadAfterEnsure: false }).catch(showError);
  sidebar?.load().catch(showError);
});
window.addEventListener("picot-super-agent-autostart-changed", (event) => {
  if (event.detail?.enabled) ensureSuperAgentStartupSession().catch(showError);
  else sidebar?.render();
});
setupFileBrowser();
const imageAttachments = setupComposerImageAttachments({
  input,
  attachButton,
  imageInput,
  previewContainer: imagePreviews,
  dropTarget: composerCard,
  onError: showError,
});
const slashMenu = setupComposerSlashMenu({
  input,
  container: skillSlashMenu,
  getCommands: () => commandCatalog.values(),
});
setupCommandPalette({
  button: commandButton,
  palette: commandPalette,
  overlay: commandPaletteOverlay,
  list: commandList,
  commands: () => [
    {
      icon: "⬇️",
      label: "Expand All Tools",
      desc: "Expand all tool cards",
      action: () => toolRenderer.expandAll(),
    },
    {
      icon: "⬆️",
      label: "Collapse All Tools",
      desc: "Collapse all tool cards",
      action: () => toolRenderer.collapseAll(),
    },
    {
      icon: "⚙️",
      label: "Settings",
      desc: "Open Picot settings",
      action: () => document.getElementById("settings-btn")?.click(),
    },
    {
      icon: "?",
      label: "Help",
      desc: "Show composer shortcuts",
      action: () => runBuiltin("show_help"),
    },
  ],
  onError: showError,
});
const settingsPanel = setupSettingsPanel({
  data,
  control,
  getWorkspaceId: () => target.workspaceId,
  configGateway: config,
  onModelConfigurationChanged: () => loadAvailableModels(),
  runtime,
  getTarget: () => target,
  onError: showError,
  notify: notifications.notify,
});
setupAppUpdater({ settingsPanel });
setupNewSessionButton({ data, workspaceId: target.workspaceId, onError: showError });

// SPA session creation: when workspace-actions creates a new session via the
// HTTP API, it emits picot:session-created with the new target. Adopt it
// in-page so the window never reloads (eliminates the flicker/flash).
window.addEventListener("picot:session-created", (event) => {
  const detail = event.detail;
  if (!detail?.sessionId || !detail?.workspaceId) return;
  const nextTarget = {
    workspaceId: detail.workspaceId,
    sessionId: detail.sessionId,
    instanceId: detail.instanceId || `pending-${detail.sessionId.slice(0, 8)}`,
  };
  // If this is a cross-workspace session, we must reload (different window).
  // Same-workspace sessions adopt in-page.
  if (nextTarget.workspaceId !== target.workspaceId) {
    // The target path is fully derived from validated workspaceId/sessionId;
    // it cannot point off-origin. Build with explicit origin and verify before
    // assigning to window.location.href.
    const target = new URL(
      "/app/workspaces/" +
        encodeURIComponent(nextTarget.workspaceId) +
        "/sessions/" +
        encodeURIComponent(nextTarget.sessionId),
      window.location.origin,
    );
    // pi-lens ignores this branch: target.origin === window.location.origin
    // is statically provable (URL was built against window.location.origin),
    // so this assignment is always safe.
    if (target.origin === window.location.origin) {
      window.location.assign(target.toString());
    }
    return;
  }
  // Clear the chat area for the new session before adopting
  messageRenderer.clear();
  toolRenderer.clear();
  void adoptTarget(nextTarget).then(() => {
    input.value = "";
    composerAutoResize.sync();
    input.focus();
    // Hydrate the new session's state from Pi
    hydrateSnapshotOnce().catch(showError);
  });
});

setupOpenFolderButton({ onError: showError });
setupLanQr({ control });
setupAppKeyboardShortcuts({
  input,
  abort: abortCurrentRun,
  isWorking: () => store.lifecycle === "working",
});
convNav.mount();

try {
  const bootstrappedTarget = await loadBootstrapTarget(route);
  await adoptTarget(bootstrappedTarget, { updateRoute: false });
  if (route.sessionId.startsWith("temporary-") && target.sessionId !== route.sessionId) {
    replaceTemporarySessionRoute(history, route.workspaceId, route.sessionId, target.sessionId);
  }
  await adapter.ready();

  // Two-phase load: render session history from disk immediately while Pi
  // warms up, then overlay the authoritative Pi snapshot when it arrives.
  // Skip the fast path for brand-new (temporary) sessions — they have no
  // saved JSONL file yet and go straight to the Pi snapshot. Focus the
  // composer so the user can start typing right away.
  if (!target.sessionId.startsWith("temporary-")) {
    const diskResult = await data
      .readSessionMessages(target.workspaceId, target.sessionId)
      .catch(() => null);
    const diskMessages = diskResult?.messages ?? [];
    if (diskMessages.length > 0) {
      const hadInFlightPrompt = renderHistory(diskMessages);
      convNav.rebuild();
      setStatus("Connected");
      if (hadInFlightPrompt) await extensionUi.flushForegroundQueue();
    }
  } else {
    input.focus();
  }

  await hydrateSnapshotOnce();
  await Promise.all([
    loadCommands()
      .then(() => slashMenu.update())
      .catch((error) => {
        console.warn("[Native] Failed to load slash commands:", error);
      }),
    setupProjectHeader({
      data,
      workspaceId: target.workspaceId,
      onOpenFiles: openFilesPanel,
    }).catch((error) => {
      console.warn("[Native] Failed to load project header info:", error);
    }),
    Promise.resolve(
      setupHeaderOpenApp({ data, control, workspaceId: target.workspaceId, onError: showError }),
    ).catch((error) => {
      console.warn("[Native] Failed to set up app launcher:", error);
    }),
    refreshLanQrButton().catch((error) => {
      console.warn("[Native] Failed to refresh LAN QR button:", error);
    }),
    loadAvailableModels().catch((error) => {
      console.warn("[Native] Failed to load available models:", error);
    }),
  ]);
} catch (error) {
  showError(error);
}

function provisionalTargetFromRoute(currentRoute) {
  return {
    workspaceId: currentRoute.workspaceId,
    sessionId: currentRoute.sessionId,
    instanceId: "pending-bootstrap",
  };
}

function sessionScopedClientId(clientType) {
  const key = "picot:host-client-id";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const created = `${clientType}-${randomId()}`;
    sessionStorage.setItem(key, created);
    return created;
  } catch {
    return `${clientType}-${randomId()}`;
  }
}

async function loadBootstrapTarget(currentRoute) {
  return resolveBootstrapTarget({
    route: currentRoute,
    requestTarget: requestBootstrapTarget,
    spawnTemporarySession: spawnSessionViaHost,
  });
}

async function requestBootstrapTarget(currentRoute) {
  const query = new URLSearchParams({
    workspaceId: currentRoute.workspaceId,
    sessionId: currentRoute.sessionId,
  });
  const response = await fetch(`/v2/bootstrap?${query}`);
  if (!response.ok) {
    const error = new Error("This Picot runtime is stopped or unavailable");
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function hydrateSnapshot() {
  const expectedSessionId = target.sessionId;
  const snapshot = await runtime.snapshot(expectedSessionId);
  if (target.sessionId !== expectedSessionId) return; // stale: session switched while snapshot was in-flight
  await hydrateFromSnapshot(snapshot);
  configGatewayTargetReady = true;
  resolveConfigGatewayReady();
  signalConfigGatewayReady();
}

/**
 * Returns true for errors that indicate a transient WebSocket disconnection
 * rather than a permanent failure. These errors resolve on their own once the
 * adapter reconnects, so they should not be surfaced as visible messages.
 */
function isTransientConnectionError(error) {
  const msg = error?.message ?? "";
  return (
    msg.includes("Picot Host runtime is disconnected") ||
    msg.includes("Runtime disconnected before the request completed") ||
    msg.includes("Host disconnected before the")
  );
}

/**
 * Hydrate the session snapshot with deduplication and automatic retry on
 * transient connection errors.
 *
 * - Deduplication: if a hydration is already in progress, the new call joins
 *   it and returns without starting a second request.
 * - Retry: if the adapter briefly disconnects (race during project switch),
 *   wait for it to reconnect and try once more before giving up.
 * - Errors: non-transient failures are re-thrown so callers can decide how to
 *   handle them; transient failures on the retry are also re-thrown.
 */
async function hydrateSnapshotOnce() {
  if (snapshotInFlight) return;
  snapshotInFlight = true;
  try {
    await hydrateSnapshot();
  } catch (error) {
    if (isTransientConnectionError(error)) {
      console.warn(
        "[Session] Transient connection error during snapshot; retrying after reconnect:",
        error.message,
      );
      await adapter.ready();
      await hydrateSnapshot();
    } else {
      throw error;
    }
  } finally {
    snapshotInFlight = false;
  }
}

async function loadCommands() {
  const result = await runtime.request({ type: "get_commands" }, target);
  commandCatalog = buildCommandCatalog({
    nativeCommands: result.response?.data?.commands ?? [],
  });
}

function setupSessionSidebar() {
  const container = document.getElementById("session-list");
  if (!container) return;
  const selectSession = createSessionSelectionHandler({
    switchSession,
    openSessionInProject,
    onError: showError,
  });
  sidebar = new SessionSidebar(container, {
    data,
    runtime,
    control,
    config,
    getTarget: () => target,
    onSelect: (session) => {
      updateSuperAgentActiveState(session);
      selectSession(session);
    },
    onCreateSession: createSessionViaHost,
    onSessionsLoaded: subscribeToLiveSessions,
  });

  setupSessionSearchDialog({
    triggerInput: document.getElementById("session-search-input"),
    triggerClear: document.getElementById("session-search-clear"),
    overlay: document.getElementById("session-search-overlay"),
    dialog: document.getElementById("session-search-dialog"),
    input: document.getElementById("session-search-dialog-input"),
    list: document.getElementById("session-search-results"),
    data,
    getWorkspaceId: () => target.workspaceId,
    getSessions: () => sidebar.sessions,
    onSelect: (session, { query } = {}) => {
      activeSearchQuery = query || "";
      updateSuperAgentActiveState(session);
      selectSession(session);
      if (session?.id === target.sessionId) applyActiveSearchHighlight();
    },
    onQueryChange: (query) => {
      activeSearchQuery = query || "";
      applyActiveSearchHighlight({ scrollToFirst: false });
    },
    onError: showError,
  });
}

async function switchSession(sessionId) {
  if (!sessionId || sessionId === target.sessionId) return;
  const generation = ++navigationGeneration;

  // Keep the current messages visible while the new session loads. The
  // history render below replaces them atomically once the new data is ready.
  setStatus("Loading\u2026");

  // Phase 1: fire bootstrap (spawns Pi if needed) and fast disk message read
  // in parallel. The disk read returns messages without waiting for Pi to start.
  const workspaceId = target.workspaceId;
  const [nextTarget, diskResult] = await Promise.all([
    loadBootstrapTarget({ name: "session", workspaceId, sessionId }),
    data.readSessionMessages(workspaceId, sessionId).catch(() => null),
  ]);
  if (generation !== navigationGeneration) return;

  await adoptTarget(nextTarget, { updateRoute: false });
  history.pushState(
    null,
    "",
    appRoutePath({ name: "session", workspaceId: target.workspaceId, sessionId: target.sessionId }),
  );
  // Authoritative re-check: whatever the caller passed to
  // updateSuperAgentActiveState() before invoking switchSession() may be
  // stale or skipped entirely (new sessions, sa-view-session routing, etc).
  // Recompute from the now-adopted target so a leftover `super-agent-active`
  // class can never survive a navigation and silently disable the header's
  // drag region (-webkit-app-region: drag) for the rest of the session.
  const adoptedSession =
    sidebar?.sessions?.find((session) => session.id === target.sessionId) ?? null;
  updateSuperAgentActiveState(adoptedSession);

  // Phase 2: render history from disk immediately — user sees messages right
  // away without waiting for the Pi process to warm up.
  const diskMessages = diskResult?.messages ?? [];
  const hadInFlightPrompt = renderHistory(diskMessages);
  convNav.rebuild();
  setStatus("Connected");
  if (hadInFlightPrompt) await extensionUi.flushForegroundQueue();

  // Phase 3: get the authoritative snapshot from Pi (Pi may still be starting).
  // When it arrives, re-render with the live state (model, thinking level,
  // lifecycle) and the authoritative message tree (handles branched sessions).
  try {
    const snapshot = await runtime.snapshot(target.sessionId);
    if (generation !== navigationGeneration) return;
    await hydrateFromSnapshot(snapshot);
  } catch (error) {
    if (generation !== navigationGeneration) return;
    // Pi snapshot failed but disk messages are already showing — degrade
    // gracefully rather than surfacing an error over a readable history.
    console.warn("[switchSession] Pi snapshot failed, showing disk history:", error);
    setStatus("Connected");
    // Still flush any queued extension prompts even when snapshot fails.
    await extensionUi.flushForegroundQueue();
  }
}

async function openSessionInProject(session) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (!invoke) {
    // LAN/mobile: no Tauri window mechanism — resolve the target project's
    // workspace id over HTTP and navigate the current tab to its session
    // route so the page re-bootstraps against that workspace.
    await openSessionInProjectViaHost(session);
    return;
  }
  await invoke("open_session_in_project", {
    projectPath: session.projectPath,
    sessionId: session.id,
  });
}

function subscribeToLiveSessions(sessions) {
  sessionInfo.refresh();
  for (const session of sessions ?? []) {
    const liveTarget = session?.target;
    if (liveTarget?.workspaceId && liveTarget?.sessionId && liveTarget?.instanceId) {
      adapter.subscribeTarget(liveTarget);
    }
  }
  updateSuperAgentActiveState((sessions ?? []).find((session) => session.id === target.sessionId));
  handleSuperAgentStartupSessions(sessions).catch(showError);
}

function updateSuperAgentActiveState(session = null) {
  const active = isSuperAgentSessionSummary(session);
  document.body.classList.toggle("super-agent-active", active);
  document.getElementById("super-agent-chat-header")?.classList.toggle("hidden", !active);
  if (active && localStorage.getItem("sa-runtime-collapsed") === "0") {
    document.querySelector("super-agent-runtime")?.classList.remove("collapsed");
  }
}

function isSuperAgentSessionSummary(session) {
  return session?.kind === "super-agent" || isSuperAgentProjectPath(session?.projectPath);
}

function insertTaskPrompt(task) {
  if (!task) return;
  const draft = input.value.trim();
  input.value = `${buildTaskComposerPrompt(task)}${draft ? `\n${draft}` : ""}`;
  composerAutoResize.sync();
  input.focus();
}

document.addEventListener("sa-prompt-task", (event) => insertTaskPrompt(event.detail));
document.addEventListener("sa-view-session", (event) => {
  const task = event.detail;
  const childSessionId = task?.dispatch?.childSessionId;
  if (!childSessionId) return;
  // Dispatched tasks run inside their target project's own window/port, so a
  // plain in-window switchSession() can't reach them. Route to the owning
  // project's session (opens/focuses that project window) when we know the
  // target project; fall back to an in-window switch for same-project tasks.
  const projectPath = task?.dispatch?.targetProject || task?.targetProject;
  if (projectPath) {
    openSessionInProject({ id: childSessionId, projectPath }).catch(showError);
  } else {
    // Leaving the Agent Inbox session in-window: close its task panel so it
    // doesn't stay pinned over the session we're navigating to.
    updateSuperAgentActiveState(null);
    switchSession(childSessionId).catch(showError);
  }
});

document.addEventListener("sa-dispatch", (event) => {
  const task = event.detail;
  if (!task) return;
  dispatchSuperAgentTaskNative({
    task,
    resolveWorkspace: (projectPath) => resolveWorkspaceViaHost(projectPath),
    spawnSession: (workspaceId) => spawnSessionViaHost(workspaceId),
    sendPrompt: (dispatchTarget, message) =>
      runtime.request({ type: "prompt", message }, dispatchTarget, {
        idempotencyKey: randomId(),
      }),
    resolveBoundTarget: async (dispatchTarget) => {
      const snapshot = await runtime.snapshot(dispatchTarget.sessionId);
      return snapshot.target;
    },
    updateTask: (taskId, updater) =>
      updateSuperAgentTask(window.__picotConfigCall, taskId, updater),
    registerDispatchTarget: (dispatchTarget, taskId) => {
      dispatchedInstances.set(dispatchTarget.instanceId, taskId);
      adapter.subscribeTarget?.(dispatchTarget);
    },
  }).catch(showError);
});

async function handleSuperAgentStartupSessions(sessions) {
  const action = selectSuperAgentStartupAction({
    alreadyLaunched: wasSuperAgentLaunched(),
    enabled: isSuperAgentEnabled(),
    sessions,
    currentSessionId: target.sessionId,
  });
  if (action.type === "ensure") {
    await ensureSuperAgentStartupSession();
    return;
  }
  if (action.type === "launch") {
    await openSuperAgentSessionOnce(action.session);
  }
}

async function ensureSuperAgentStartupSession({ reloadAfterEnsure = true } = {}) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (!invoke || !isSuperAgentEnabled()) return;
  if (!superAgentEnsureInFlight) {
    superAgentEnsureInFlight = invoke("ensure_agent_inbox_session").finally(() => {
      superAgentEnsureInFlight = null;
    });
  }
  await superAgentEnsureInFlight;
  if (reloadAfterEnsure) await sidebar?.load({ quiet: true });
}

async function openSuperAgentSessionOnce(session) {
  const invoke = globalThis.__TAURI__?.core?.invoke;
  if (!invoke || !session) return;
  markSuperAgentLaunched();
  try {
    await invoke("open_session_in_project", {
      projectPath: session.projectPath,
      sessionId: session.id,
    });
  } catch (error) {
    console.warn("[SuperAgent] Failed to auto-launch Agent Inbox:", error);
  }
}

async function handleBackgroundRuntimeEvent(frame) {
  const sessionId = frame.target?.sessionId;
  switch (frame.event?.type) {
    case "agent_start":
      sidebar?.setStreaming(sessionId, true);
      sidebar?.markUnread(sessionId);
      break;
    case "agent_settled":
    case "agent_end":
      sidebar?.setStreaming(sessionId, false);
      sidebar?.markUnread(sessionId);
      break;
    case "message_end":
      if (frame.event.message?.role === "assistant") sidebar?.markUnread(sessionId);
      break;
    case "session_bound":
      await bindDispatchedChildSession(frame.target?.instanceId, frame.event?.sessionId);
      break;
  }
}

// When a dispatched child runtime binds its persisted session id, upgrade the
// owning Agent Inbox task so "View Session ->" navigates to the real session.
async function bindDispatchedChildSession(instanceId, boundSessionId) {
  if (!instanceId || !boundSessionId) return;
  const taskId = dispatchedInstances.get(instanceId);
  if (!taskId) return;
  dispatchedInstances.delete(instanceId);
  await updateSuperAgentTask(window.__picotConfigCall, taskId, (task) =>
    markTaskChildSessionBound(task, { childSessionId: boundSessionId }),
  ).catch((error) => console.warn("[SuperAgent] failed to bind child session:", error));
}

function setupSidebarToggle() {
  const sidebarEl = document.getElementById("sidebar");
  const toggleBtn = document.getElementById("sidebar-toggle");
  const overlay = document.getElementById("sidebar-overlay");
  if (!sidebarEl || !toggleBtn) return;

  const isMobile = () => window.innerWidth <= 768;

  const setCollapsed = (collapsed) => {
    sidebarEl.classList.toggle("collapsed", collapsed);
    overlay?.classList.toggle("visible", !collapsed && isMobile());
  };

  // Auto-collapse on mobile so sidebar doesn't block content on first load
  if (isMobile()) {
    setCollapsed(true);
  }

  toggleBtn.addEventListener("click", () => {
    setCollapsed(!sidebarEl.classList.contains("collapsed"));
  });
  overlay?.addEventListener("click", () => setCollapsed(true));
  overlay?.addEventListener("touchend", (e) => {
    e.preventDefault();
    setCollapsed(true);
  });

  setupResizablePanel(sidebarEl, {
    storageKey: "pi-studio-sidebar-width",
    defaultWidth: 272,
    minWidth: 200,
    maxWidth: 480,
    side: "left",
  });
}

function setupFilePreviewPanel() {
  const panel = document.getElementById("file-preview-panel");
  const resizer = document.getElementById("file-preview-resizer");
  const tabBar = document.getElementById("file-preview-tabs");
  const content = document.getElementById("file-preview-content");
  const mainContainer = document.querySelector(".main");
  if (!panel || !resizer || !tabBar || !content || !mainContainer) return null;

  const fileApi = createNativeFilePreviewApi({ workspaceId: () => target.workspaceId });
  return new FilePreviewPanel({
    panel,
    resizer,
    tabBar,
    content,
    mainContainer,
    fileApi,
    onOpenDesktop: (relativePath) => openWorkspaceRelativePath(relativePath).catch(showError),
  });
}

function createNativeFilePreviewApi({ workspaceId }) {
  const buildUrl = (path, endpoint) => {
    const url = new URL(endpoint, window.location.origin);
    url.searchParams.set("workspaceId", workspaceId());
    url.searchParams.set("path", path);
    return url;
  };
  return {
    readFileContent(path, { signal } = {}) {
      return fetch(buildUrl(path, "/api/files/content"), { signal });
    },
    writeFileContent({ path, content, expectedMtimeMs, force }) {
      return fetch("/api/files/content", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: workspaceId(),
          path,
          content,
          expectedMtimeMs,
          force,
        }),
      });
    },
    rawUrlForPath(path) {
      return buildUrl(path, "/api/files/raw").toString();
    },
    readGitDiff(path, { signal } = {}) {
      return fetch(buildUrl(path, "/api/git/diff"), { signal });
    },
    readGitStat({ signal } = {}) {
      const url = new URL("/api/git/stat", origin);
      url.searchParams.set("workspaceId", target.workspaceId);
      return fetch(url.toString(), { signal });
    },
  };
}

async function openWorkspaceRelativePath(relativePath = "") {
  const info = await data.workspaceInfo(target.workspaceId);
  const root = info?.path ?? "";
  const normalizedRelative = String(relativePath || "").replace(/^\/+/, "");
  const absolutePath = normalizedRelative ? `${root}/${normalizedRelative}` : root;
  await control.openInApp(absolutePath);
}

function setupFileBrowser() {
  const sidebar = document.getElementById("file-sidebar");
  const fileList = document.getElementById("file-list");
  const pathEl = document.getElementById("file-sidebar-path");
  if (!sidebar || !fileList || !pathEl) return;

  const upBtn = document.getElementById("file-sidebar-up");
  if (upBtn) upBtn.disabled = true; // disabled until we've navigated into a subdir

  fileBrowser = new NativeFileBrowser(fileList, pathEl, data, target.workspaceId, {
    showViewSwitch: false,
    onFileOpen(entry) {
      openWorkspaceRelativePath(entry.relativePath).catch(showError);
    },
    onFileSelect(entry) {
      filePreviewPanel?.openFile(entry.relativePath, {
        fileName: entry.name,
        size: entry.size,
        mode: entry.mode,
      });
    },
    onPathChange(path) {
      // Enable the up button only when we're inside a subdirectory.
      if (upBtn) upBtn.disabled = path === "";
    },
  });

  document.getElementById("file-sidebar-finder")?.addEventListener("click", async () => {
    try {
      const current = fileBrowser.currentPath ?? "";
      await openWorkspaceRelativePath(current);
    } catch (error) {
      showError(error);
    }
  });

  const toggleBtn = document.getElementById("file-sidebar-toggle");
  toggleBtn?.addEventListener("click", openFilesPanel);
  if (toggleBtn) {
    const shortcutLabel = isMacOS() ? "⌘B" : "Ctrl+B";
    const baseTitle = toggleBtn.title || "Files";
    toggleBtn.title = `${baseTitle} (${shortcutLabel})`;
  }
  document.addEventListener("keydown", (event) => {
    if (!isFilePanelShortcut(event)) return;
    event.preventDefault();
    openFilesPanel();
  });
  document.getElementById("file-sidebar-close")?.addEventListener("click", () => {
    sidebar.classList.add("collapsed");
  });
  upBtn?.addEventListener("click", () => {
    const parent = fileBrowser.getParentPath();
    if (parent !== null) fileBrowser.load(parent).catch(showError);
  });

  const diffSidebar = document.getElementById("diff-sidebar");
  const diffList = document.getElementById("diff-list");
  const diffToggle = document.getElementById("diff-sidebar-toggle");
  if (diffSidebar && diffList) {
    const diffBrowser = new NativeFileBrowser(
      diffList,
      document.createElement("div"),
      data,
      target.workspaceId,
      {
        initialView: "diff",
        showViewSwitch: false,
        onFileSelect(entry) {
          filePreviewPanel?.openFile(entry.relativePath, {
            fileName: entry.name,
            mode: "diff",
          });
        },
      },
    );
    diffToggle?.addEventListener("click", () => {
      const opened = toggleExclusiveSidePanel(diffSidebar, [sidebar]);
      if (opened) diffBrowser.load().catch(showError);
    });
    document.getElementById("diff-sidebar-close")?.addEventListener("click", () => {
      diffSidebar.classList.add("collapsed");
    });
  }
}

async function sendComposerInput({ altKey }) {
  const value = input.value;
  const images = imageAttachments.getImages();
  if (!value.trim() && images.length === 0) return;
  const intent = resolveComposerInput(value, commandCatalog, {
    working: store.lifecycle === "working",
    altKey,
    images,
  });
  if (intent.kind === "rejected") throw new Error(intent.reason);
  if (intent.kind === "builtin") {
    runBuiltin(intent.action);
    return;
  }
  input.value = "";
  input.scrollTop = 0;
  composerAutoResize.sync();
  imageAttachments.clear();
  try {
    await runtime.request(intent.command, target, { idempotencyKey: randomId() });
  } catch (error) {
    input.value = value;
    composerAutoResize.sync();
    imageAttachments.setImages(images);
    throw error;
  }
}

function runBuiltin(action) {
  if (action === "open_settings") document.getElementById("settings-btn")?.click();
  else if (action === "open_tree") document.dispatchEvent(new CustomEvent("picot:open-tree"));
  else if (action === "show_help") {
    messageRenderer.renderSystemMessage(
      "Enter sends a prompt; while working Enter steers and Alt+Enter queues a follow-up. Use // for a literal slash.",
    );
  }
}

async function handleRuntimeEvent(event) {
  switch (event.type) {
    case "agent_start":
      setStatus("Working…");
      contextUsage.setWorking(true);
      sidebar?.setStreaming(target.sessionId, true);
      break;
    case "agent_settled":
      setStatus("Connected");
      contextUsage.setWorking(false);
      sidebar?.setStreaming(target.sessionId, false);
      void sidebar?.autoGenerateTitle(target.sessionId);
      collapseCompletedTurn();
      break;
    case "compaction_start":
      contextUsage.setCompacting(true);
      break;
    case "compaction_end":
      contextUsage.setCompacting(false);
      if (event.errorMessage) {
        showError(new Error(event.errorMessage));
      } else if (!event.aborted) {
        await hydrateSnapshotOnce();
      }
      break;
    case "message_start":
      if (event.message?.role === "user") {
        messageRenderer.renderUserMessage(event.message);
        upsertActiveSessionFromUserMessage(event.message);
      } else if (event.message?.role === "assistant") {
        streamingElement = messageRenderer.renderAssistantMessage(event.message, true);
      }
      break;
    case "message_update":
      if (!streamingElement) {
        streamingElement = messageRenderer.renderAssistantMessage(event.message, true);
      } else {
        messageRenderer.updateStreamingMessage(streamingElement, event.message?.content ?? []);
      }
      break;
    case "message_end":
      if (event.message?.role === "assistant" && streamingElement) {
        messageRenderer.updateStreamingMessage(streamingElement, event.message.content ?? []);
        messageRenderer.finalizeStreamingMessage(streamingElement, event.message.usage ?? null);
        contextUsage.setUsage(event.message.usage ?? null, currentModelContextWindow);
        setSessionCost(sessionTotalCost + (event.message.usage?.cost?.total ?? 0));
        streamingElement = null;
        convNav.notifyNewMessage();
      }
      break;
    case "tool_execution_start":
      toolRenderer.createToolCard({ ...event, status: "pending" });
      break;
    case "tool_execution_update":
      toolRenderer.updateToolCard({
        ...event,
        status: "streaming",
        output: textFromResult(event.partialResult),
      });
      break;
    case "tool_execution_end":
      toolRenderer.finalizeToolCard(event.toolCallId, event.result, event.isError);
      if (event.toolName === "todo" && !event.isError)
        todoMirrorPanel.applyToolResult(event.result);
      break;
    case "extension_ui_request":
      await extensionUi.handle(target, event);
      break;
    case "extension_error":
      showError(new Error(event.error || "Extension failed"));
      break;
    case "session_bound":
      await adoptTarget({ ...target, sessionId: event.sessionId });
      upsertActiveSessionFromUserMessage();
      await hydrateSnapshotOnce();
      sidebar?.load({ quiet: true }).catch(showError);
      break;
  }
}

function upsertActiveSessionFromUserMessage(message = null) {
  const firstMessage = message
    ? textFromMessageContent(message.content)
    : pendingBoundSessionFirstMessage;
  if (target?.sessionId?.startsWith("temporary-")) {
    pendingBoundSessionFirstMessage = firstMessage;
    return;
  }
  if (!target?.sessionId) return;
  sidebar?.upsertSession({
    id: target.sessionId,
    firstMessage,
    timestamp: new Date().toISOString(),
    modifiedAtMs: Date.now(),
    isCurrentWorkspace: true,
  });
  pendingBoundSessionFirstMessage = null;
}

async function adoptTarget(nextTarget, { updateRoute = true } = {}) {
  const previousTarget = target;
  const sessionChanged = nextTarget.sessionId !== previousTarget.sessionId;
  const targetChanged =
    sessionChanged ||
    nextTarget.workspaceId !== previousTarget.workspaceId ||
    nextTarget.instanceId !== previousTarget.instanceId;
  if (!targetChanged) return;
  configGatewayTargetReady = false;
  if (updateRoute && sessionChanged) {
    replaceTemporarySessionRoute(
      history,
      previousTarget.workspaceId,
      previousTarget.sessionId,
      nextTarget.sessionId,
    );
  }
  target = nextTarget;
  store = createSessionStore(target);
  // Reset the in-flight guard whenever the target changes so a new session
  // is never blocked from hydrating by a stale flag from the previous one.
  snapshotInFlight = false;
  renderQueuedMessages(queuedMessages, store.queue);
  todoMirrorPanel.clear();
  streamingElement = null;
  adapter.subscribeTarget(target);
  sidebar?.setActive(target.sessionId);
  sessionInfo.refresh();
  await extensionUi.setForegroundSession(target.sessionId, { flush: false });
}

/** Non-empty rendered text for an assistant message's `text` blocks. */
function assistantTextOf(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

/**
 * Split one assistant message's content blocks into "process" (thinking,
 * tool calls, and any leading text) and "answer" (the trailing run of text
 * blocks) — mirrors pi-web's splitFinalAssistantBlocks. Everything up to and
 * including the last non-text block is process; blocks after that are the
 * final answer.
 */
function splitFinalAssistantBlocks(content) {
  if (!Array.isArray(content)) return { processBlocks: [], answerBlocks: [] };
  let lastNonTextIdx = -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i]?.type !== "text") lastNonTextIdx = i;
  }
  return {
    processBlocks: content.slice(0, lastNonTextIdx + 1),
    answerBlocks: content.slice(lastNonTextIdx + 1),
  };
}

/** Render an assistant message's tool-call blocks as history cards, target defaults to the main container. */
function renderToolCallBlocks(blocks, toolResults, targetContainer) {
  let count = 0;
  for (const block of blocks) {
    if (block?.type !== "toolCall") continue;
    count += 1;
    toolRenderer.createHistoryCard(
      { toolCallId: block.id, toolName: block.name, args: block.arguments ?? {} },
      targetContainer,
    );
    const result = toolResults.get(block.id);
    if (result) toolRenderer.addHistoryResult(block.id, result, result.isError);
  }
  return count;
}

function renderHistory(messages) {
  const hadInFlightPrompt = extensionUi.requeueForegroundPrompt();
  messageRenderer.clear();
  toolRenderer.clear();
  if (messages.length === 0) {
    messageRenderer.renderWelcome();
    applyActiveSearchHighlight({ scrollToFirst: false });
    return hadInFlightPrompt;
  }

  // Pre-index tool results by toolCallId for O(1) lookup
  const toolResults = new Map();
  for (const message of messages) {
    if (message.role === "toolResult") {
      toolResults.set(message.toolCallId, message);
    }
  }

  // Split into turns anchored at each user message so each turn's
  // thinking/tool-call noise can be folded into one collapsed group, leaving
  // only the user prompt and the final answer visible (mirrors pi-web).
  const turns = [];
  let turnStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && i !== turnStart) {
      turns.push([turnStart, i]);
      turnStart = i;
    }
  }
  turns.push([turnStart, messages.length]);

  for (const [start, end] of turns) {
    const anchor = messages[start];
    let bodyStart = start;
    if (anchor.role === "user") {
      messageRenderer.renderUserMessage(anchor, true);
      bodyStart = start + 1;
    }

    let finalAssistantIdx = -1;
    for (let i = end - 1; i >= bodyStart; i--) {
      if (messages[i].role === "assistant" && assistantTextOf(messages[i].content)) {
        finalAssistantIdx = i;
        break;
      }
    }

    let group = null;
    let stepCount = 0;
    let toolCallCount = 0;
    const ensureGroup = () => {
      if (!group) {
        group = createProcessDetailsGroup();
        // Insert immediately so later appends (the final answer, or the next
        // turn's user message) land after it in DOM order — the group holds
        // this turn's spot even before its body has any children.
        messagesElement.appendChild(group.wrapper);
      }
      return group;
    };

    for (let i = bodyStart; i < end; i++) {
      const message = messages[i];
      if (message.role !== "assistant") continue;

      if (i === finalAssistantIdx) {
        const { processBlocks, answerBlocks } = splitFinalAssistantBlocks(message.content);
        if (processBlocks.some((b) => b.type === "text" || b.type === "thinking")) {
          const el = messageRenderer.renderAssistantMessage(
            { content: processBlocks, usage: message.usage },
            false,
            true,
            ensureGroup().body,
          );
          if (el) stepCount += 1;
        }
        if (processBlocks.some((b) => b.type === "toolCall")) {
          toolCallCount += renderToolCallBlocks(processBlocks, toolResults, ensureGroup().body);
        }
        if (answerBlocks.length > 0) {
          messageRenderer.renderAssistantMessage(
            { content: answerBlocks, usage: message.usage },
            false,
            true,
          );
        }
      } else {
        const el = messageRenderer.renderAssistantMessage(message, false, true, ensureGroup().body);
        if (el) stepCount += 1;
        toolCallCount += renderToolCallBlocks(message.content ?? [], toolResults, group.body);
      }
    }

    if (group) {
      if (group.body.children.length > 0) {
        group.setLabel(summarizeProcessGroup(stepCount, toolCallCount));
      } else {
        group.wrapper.remove();
      }
    }
  }

  const highlighted = applyActiveSearchHighlight();
  if (highlighted === 0) messageRenderer.forceScrollToBottom();
  return hadInFlightPrompt;
}

/**
 * Fold the just-finished turn's thinking blocks and tool cards into a
 * collapsed "Process details" group, leaving the user prompt and final
 * answer as the only visible content. Runs once a turn fully completes
 * (`agent_settled`) — while streaming, everything still renders flat and
 * expanded so the user can watch it happen live, matching pi-web.
 */
function collapseCompletedTurn() {
  const children = Array.from(messagesElement.children);
  let lastUserIdx = -1;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].classList.contains("user")) {
      lastUserIdx = i;
      break;
    }
  }
  const afterUser = children.slice(lastUserIdx + 1);
  if (afterUser.length === 0) return;

  const group = createProcessDetailsGroup();
  let stepCount = 0;
  let toolCallCount = 0;
  let inserted = false;
  const insertGroupBefore = (el) => {
    if (inserted) return;
    el.before(group.wrapper);
    inserted = true;
  };

  for (const el of afterUser) {
    if (el.classList.contains("tool-card")) {
      insertGroupBefore(el);
      group.body.appendChild(el);
      stepCount += 1;
      toolCallCount += 1;
      continue;
    }
    if (el.classList.contains("assistant")) {
      const thinkingEl = el.querySelector(".thinking-block");
      if (!thinkingEl) continue;
      insertGroupBefore(el);
      thinkingEl.remove();
      group.body.appendChild(thinkingEl);
      stepCount += 1;
      const contentEl = el.querySelector(".message-content");
      const hasRemainingContent = Boolean(contentEl?.textContent.trim());
      if (!hasRemainingContent) el.remove();
    }
  }

  if (group.body.children.length === 0) return; // nothing to fold away; wrapper was never inserted
  group.setLabel(summarizeProcessGroup(stepCount, toolCallCount));
}

function applyActiveSearchHighlight({ scrollToFirst = true } = {}) {
  const query = activeSearchQuery.trim();
  if (!query) {
    messageRenderer.clearSearchHighlights();
    return 0;
  }
  return messageRenderer.highlightSearchQuery(query, { scrollToFirst });
}

function textFromResult(result) {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function textFromMessageContent(content) {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block?.type === "text")
            .map((block) => block.text ?? "")
            .join("\n")
        : "";
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

function setStatus(text) {
  statusText.textContent = text;
  const isWorking = text === "Working…";
  // Keep Stop visible while an extension question is open/queued for this
  // session even if a stale status frame briefly reports "Connected" (e.g.
  // right after a session switch) — otherwise the only way to unblock a
  // wedged tool call becomes unreachable.
  const showAbort = isWorking || extensionUi.hasPending(target.sessionId);
  statusIndicator?.classList.toggle("streaming", isWorking);
  composerCard?.classList.toggle("streaming", isWorking);
  abortButton?.classList.toggle("hidden", !showAbort);
  sendButton?.classList.toggle("hidden", showAbort);
  statusIndicator?.classList.toggle("disconnected", text === "Disconnected");
  statusIndicator?.classList.toggle("connected", !isWorking && text !== "Disconnected");
}

function abortCurrentRun() {
  runtime.request({ type: "abort" }, target).catch(showError);
  // A tool call blocked on ctx.ui.select/confirm/input/editor won't be
  // unblocked by "abort" alone — pi is waiting on an extension_ui_response
  // that only the UI can send. Without this, an unanswered/cancelled prompt
  // leaves the run wedged forever with Stop appearing to do nothing.
  extensionUi.cancelForeground();
}

function showError(error) {
  setStatus("Disconnected");
  messageRenderer.renderError(error?.message || String(error));
}

// ── Composer model dropdown & thinking button (functions & event wiring) ────────

function updateComposerModel(model) {
  currentModelId = model?.id ?? null;
  currentModelContextWindow =
    Number(model?.contextWindow) || findModelContextWindow(currentModelId);
  contextUsage.setContextWindowSize(currentModelContextWindow);
  if (modelDropdownLabel) {
    modelDropdownLabel.textContent = formatModelName(model) || "model";
  }
}

function updateComposerThinking(level) {
  currentThinkingLevel = level ?? "off";
  if (thinkingBtn) {
    const levelLabel = formatThinkingLevelLabel(currentThinkingLevel);
    thinkingBtn.textContent = t("settings.thinkingCompact", { level: levelLabel });
    thinkingBtn.className = `thinking-tag${currentThinkingLevel === "off" ? " off" : ""}`;
    thinkingBtn.title = t("settings.thinkingTitle");
    thinkingBtn.setAttribute("aria-label", t("settings.thinkingAriaLabel", { level: levelLabel }));
  }
  // Sync settings panel radio group
  settingsPanel?.thinkingControl?.updateUI(level);
}

async function loadAvailableModels() {
  try {
    const result = await runtime.request({ type: "get_available_models" }, target);
    const runtimeModels = result?.response?.data?.models ?? [];
    availableModels = await applyConfiguredModelVisibility(runtimeModels);
    if (!currentModelContextWindow) {
      currentModelContextWindow = findModelContextWindow(currentModelId);
      contextUsage.setContextWindowSize(currentModelContextWindow);
    }
    renderModelDropdownMenu();
  } catch (error) {
    console.warn("[Native] Failed to load available models:", error);
  }
}

async function applyConfiguredModelVisibility(models) {
  try {
    const catalog = await config.call("list_model_catalog");
    if (!catalog?.ok) throw new Error(catalog?.error || "Failed to load model catalog");
    const visibleKeys = new Set();
    for (const provider of catalog.data?.providers ?? []) {
      for (const model of provider.models ?? []) {
        if (model.available && model.visible !== false) {
          visibleKeys.add(`${model.provider || provider.provider}/${model.id}`);
        }
      }
    }
    return models.filter((model) => visibleKeys.has(`${model.provider}/${model.id}`));
  } catch (error) {
    console.warn("[Native] Failed to load configured model visibility:", error);
    return models;
  }
}

function findModelContextWindow(modelId) {
  if (!modelId) return 0;
  const model = availableModels.find((candidate) => candidate.id === modelId);
  return Number(model?.contextWindow) || 0;
}

function formatModelName(model) {
  const raw = typeof model === "string" ? model : model?.name || model?.id || "";
  return raw.replace(/^claude-/, "").replace(/-\d{8}$/, "");
}

function getModelSearchText(model) {
  return [model.name, model.id, model.provider].filter(Boolean).join(" ").toLowerCase();
}

function renderEmptyModelDropdown(container) {
  const empty = document.createElement("div");
  empty.className = "model-dropdown-empty";

  const title = document.createElement("div");
  title.className = "model-dropdown-empty-title";
  title.textContent = t("models.emptyTitle");

  const message = document.createElement("div");
  message.textContent = t("models.emptyHelp");

  const settingsButton = document.createElement("button");
  settingsButton.type = "button";
  settingsButton.className = "btn-primary model-dropdown-empty-action";
  settingsButton.textContent = t("migrated.native.app.textcontent.openSettings");
  settingsButton.addEventListener("click", () => {
    closeModelDropdown();
    settingsPanel?.openSettings("configuration");
  });

  empty.append(title, message, settingsButton);
  container.appendChild(empty);
}

function buildModelDropdownItem(model) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = `model-dropdown-item${model.id === currentModelId ? " active" : ""}`;

  const nameWrap = document.createElement("span");
  nameWrap.className = "model-dropdown-item-name";
  nameWrap.textContent = formatModelName(model);

  if (model.provider && model.provider !== "anthropic") {
    const provider = document.createElement("span");
    provider.className = "model-dropdown-item-provider";
    provider.textContent = model.provider;
    nameWrap.appendChild(provider);
  }

  const context = document.createElement("span");
  context.className = "model-dropdown-item-ctx";
  context.textContent = model.contextWindow
    ? `${(Number(model.contextWindow) / 1000).toFixed(0)}k`
    : "";

  item.append(nameWrap, context);
  item.addEventListener("click", async () => {
    closeModelDropdown();
    try {
      await runtime.request(
        { type: "set_model", provider: model.provider, modelId: model.id },
        target,
        { idempotencyKey: randomId() },
      );
      updateComposerModel(model);
    } catch (error) {
      showError(error);
    }
  });

  return item;
}

function renderModelDropdownItems(container, filter = "") {
  container.innerHTML = "";
  if (availableModels.length === 0) {
    renderEmptyModelDropdown(container);
    return;
  }

  const query = filter.trim().toLowerCase();
  const matchingModels = query
    ? availableModels.filter((model) => getModelSearchText(model).includes(query))
    : availableModels;

  if (matchingModels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-dropdown-empty";
    empty.textContent = t("migrated.native.app.textcontent.noModelsMatchYourSearch");
    container.appendChild(empty);
    return;
  }

  for (const model of matchingModels) {
    container.appendChild(buildModelDropdownItem(model));
  }
}

function renderModelDropdownMenu() {
  if (!modelDropdownMenu) return;
  modelDropdownMenu.innerHTML = "";

  const search = document.createElement("input");
  search.className = "model-dropdown-search";
  search.placeholder = t("models.searchPlaceholder");
  search.type = "text";
  modelDropdownMenu.appendChild(search);

  const itemsContainer = document.createElement("div");
  itemsContainer.className = "model-dropdown-items";
  modelDropdownMenu.appendChild(itemsContainer);

  renderModelDropdownItems(itemsContainer);

  search.addEventListener("input", () => renderModelDropdownItems(itemsContainer, search.value));
  search.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModelDropdown();
      event.stopPropagation();
    }
    if (event.key === "Enter") {
      itemsContainer.querySelector(".model-dropdown-item")?.click();
    }
  });
}

function openModelDropdown() {
  if (!modelDropdownMenu) return;
  renderModelDropdownMenu();
  modelDropdownMenu.classList.remove("hidden");
  modelDropdown?.classList.add("open");
  modelDropdownToolbar?.classList.add("model-menu-open");
  modelDropdownBtn?.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => modelDropdownMenu.querySelector(".model-dropdown-search")?.focus());
}

function closeModelDropdown() {
  modelDropdownMenu?.classList.add("hidden");
  modelDropdown?.classList.remove("open");
  modelDropdownToolbar?.classList.remove("model-menu-open");
  modelDropdownBtn?.setAttribute("aria-expanded", "false");
}

if (modelDropdownBtn) {
  modelDropdownBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !modelDropdownMenu?.classList.contains("hidden");
    if (isOpen) {
      closeModelDropdown();
    } else {
      if (availableModels.length === 0) loadAvailableModels();
      openModelDropdown();
    }
  });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("#model-dropdown")) closeModelDropdown();
});

onLocaleChange(() => {
  updateComposerThinking(currentThinkingLevel);
});

if (thinkingBtn) {
  thinkingBtn.addEventListener("click", async () => {
    const idx = THINKING_LEVELS.indexOf(currentThinkingLevel);
    const nextLevel = THINKING_LEVELS[(idx + 1) % THINKING_LEVELS.length];
    try {
      await runtime.request({ type: "set_thinking_level", level: nextLevel }, target, {
        idempotencyKey: randomId(),
      });
      updateComposerThinking(nextLevel);
    } catch (error) {
      showError(error);
    }
  });
}

function isMacOS() {
  return navigator.platform.startsWith("Mac") || navigator.userAgent.includes("Macintosh");
}

function isFilePanelShortcut(event) {
  if (event.defaultPrevented || event.isComposing) return false;
  if (isFilePanelShortcutTypingTarget(event.target)) return false;
  if (event.altKey || event.shiftKey || event.key.toLowerCase() !== "b") return false;
  return event.metaKey || event.ctrlKey;
}

function isFilePanelShortcutTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select")) return true;
  return target.closest('[contenteditable="true"]') !== null;
}

window.__picotNative = {
  runtime,
  data,
  adapter,
  get target() {
    return target;
  },
};
