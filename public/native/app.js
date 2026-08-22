import { createCompactCoordinator } from "../compact-coordinator.js";
import { FilePreviewPanel } from "../file-preview-panel.js";
import { initI18n, onLocaleChange, t } from "../i18n.js";
import { reconcileSnapshotTarget } from "../session/bootstrap-target.js";
import { SessionUiStateStore } from "../session-ui-state.js";
import { dispatchSuperAgentTaskNative } from "../super-agent/native-dispatch.js";
import { isSuperAgentProjectPath } from "../super-agent/session.js";
import { isSuperAgentEnabled } from "../super-agent/settings.js";
import { selectSuperAgentStartupAction } from "../super-agent/startup-flow.js";
import { buildTaskComposerPrompt, markTaskChildSessionBound } from "../super-agent/task-state.js";
import { updateSuperAgentTask } from "../super-agent/task-store.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { buildAtMentionValue, setupAtFileMention } from "../ui/at-file-mention.js";
import { ConvNav } from "../ui/conv-nav.js";
import { createHeaderStatusBar } from "../ui/header-status-bar.js";
import { setupMessagesInsets } from "../ui/layout-insets.js";
import { MessageRenderer } from "../ui/message-renderer.js";
import {
  captureExpandedProcessGroups,
  createProcessDetailsGroup,
  summarizeProcessGroup,
} from "../ui/process-group.js";
import { setupResizablePanel } from "../ui/resizable-panel.js";
import { ToolCardRenderer } from "../ui/tool-card.js";
import { setupComposerAutoResize } from "./composer/composer-autoresize.js";
import { setupComposerImageAttachments } from "./composer/composer-images.js";
import { setupComposerSlashMenu } from "./composer/composer-slash-menu.js";
import { setupComposerSubmitHandling } from "./composer/composer-submit.js";
import { renderQueuedMessages } from "./composer/queued-messages.js";
import { buildCommandCatalog, resolveComposerInput } from "./composer/slash-commands.js";
import { setupCommandPalette } from "./extensions/command-palette.js";
import { CustomUiPanel } from "./extensions/custom-ui-panel.js";
import { showNativeDialog } from "./extensions/dialog.js";
import { ExtensionUiHost } from "./extensions/extension-ui-host.js";
import { ExtensionWidgets } from "./extensions/extension-widgets.js";
import { showInlineExtensionPrompt } from "./extensions/inline-extension-prompt.js";
import { setupAppUpdater } from "./features/app-updater.js";
import { createFilePreviewFollow } from "./features/file-preview-follow.js";
import { setupGitPanel } from "./features/git-panel-integration.js";
import { refreshLanQrButton, setupLanQr } from "./features/lan-qr.js";
import { resolveRemoteAuth } from "./features/remote-auth.js";
import {
  isRpivTodoCommandNotify,
  isRpivTodoWidgetRequest,
  RpivTodoMirrorPanel,
} from "./features/rpiv-todo-mirror.js";
import { setupTerminalPanel } from "./features/terminal-panel-integration.js";
import { createNotificationCenter } from "./notifications/notification-center.js";
import {
  createNativeTaskNotificationSender,
  createTaskCompletionNotifications,
} from "./notifications/task-completion-notifications.js";
import { setupSessionInfo } from "./session/session-info.js";
import { createSessionSelectionHandler } from "./session/session-navigation.js";
import { setupSessionSearchDialog } from "./session/session-search-dialog.js";
import { SessionSidebar } from "./session/session-sidebar.js";
import { createSessionStore, reduceSessionState } from "./session/session-store.js";
import { setupSettingsPanel } from "./settings/settings-panel.js";
import { resolveBootstrapTarget } from "./transport/bootstrap-target.js";
import { ConfigGateway, consumeConfigResponseFrame } from "./transport/config-gateway.js";
import {
  setupConfigGatewayConnectionListener,
  signalConfigGatewayReady,
} from "./transport/config-gateway-readiness.js";
import { HostControlGateway } from "./transport/control-gateway.js";
import { HostDataGateway } from "./transport/data-gateway.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "./transport/runtime-adapter.js";
import { routeRuntimeFrame } from "./transport/runtime-frame-routing.js";
import { RuntimeGateway } from "./transport/runtime-gateway.js";
import { setupAppKeyboardShortcuts } from "./utils/keyboard-shortcuts.js";
import { randomId } from "./utils/random-id.js";
import { appRoutePath, parseAppRoute, replaceTemporarySessionRoute } from "./utils/router.js";
import { findLatestAssistantUsage, setupContextUsage } from "./workspace/context-usage.js";
import { toggleExclusiveSidePanel } from "./workspace/exclusive-side-panel.js";
import { NativeFileBrowser } from "./workspace/file-browser.js";
import { setupHeaderOpenApp } from "./workspace/header-open-app.js";
import { setupProjectHeader } from "./workspace/project-header.js";
import { createSessionStatus } from "./workspace/session-status.js";
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
// Status lives in its own module so hooks can fire while this file is paused
// on a later `await` without hitting TDZ on `let statusKind`.
const sessionStatus = createSessionStatus({ t });
const { applyHostStatus, renderStatus, setStatus } = sessionStatus;
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
const sendNativeTaskNotification = createNativeTaskNotificationSender({
  invoke: globalThis.__TAURI__?.core?.invoke,
});
const taskCompletionNotifications = createTaskCompletionNotifications({
  resolveTask: (notificationTarget) =>
    sidebar?.sessions?.find(
      (session) =>
        session.id === notificationTarget?.sessionId &&
        session.workspaceId === notificationTarget?.workspaceId,
    ) ?? null,
  title: (task) => task?.name || task?.firstMessage || t("settings.taskCompleteTitle"),
  body: () => t("settings.taskCompleteMessage"),
  showNotification: sendNativeTaskNotification,
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
let atFileMention = null;
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

function formatThinkingLevelLabel(level) {
  const normalizedLevel = level || "off";
  const key = `settings.thinkingLevels.${normalizedLevel}`;
  const label = t(key);
  return label === key ? normalizedLevel : label;
}
let currentThinkingLevel = "off";
let currentModelId = null;

// Session UI state: persists per-session model + thinking level and input draft
// so switching between sessions restores the composer state. Profiles live in
// the native host (SessionUiProfileStore) keyed by the runtime session id;
// drafts stay window-memory because they are not worth serialising.
const sessionUiState = new SessionUiStateStore({
  profileClient: {
    load: () => {
      const sessionId = target.sessionId;
      if (!sessionId || sessionId === "pending-bootstrap") return Promise.resolve(null);
      return runtime.sendHostRequest
        ? runtime
            .sendHostRequest({
              operation: "session_ui_profile_load",
              expectedSessionId: sessionId,
            })
            .then((response) => response?.profile ?? null)
        : fetch("/v2/host", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operation: "session_ui_profile_load",
              expectedSessionId: sessionId,
            }),
          })
            .then(async (response) => {
              if (!response.ok) return null;
              const data = await response.json();
              return data?.profile ?? null;
            })
            .catch(() => null);
    },
    save: (profile) => {
      const sessionId = target.sessionId;
      if (!sessionId || sessionId === "pending-bootstrap") return Promise.resolve(null);
      const payload = {
        operation: "session_ui_profile_save",
        expectedSessionId: sessionId,
        ...profile,
      };
      return runtime.sendHostRequest
        ? runtime.sendHostRequest(payload).then((response) => response?.profile ?? profile)
        : fetch("/v2/host", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
            .then(async (response) => {
              if (!response.ok) return profile;
              const data = await response.json();
              return data?.profile ?? profile;
            })
            .catch(() => profile);
    },
  },
});
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
let liveProcessGroup = null;
let sidebar = null;
let agentInboxNavSelectSession = null;
// Sidebar loading starts before bootstrap/runtime awaits complete. Keep every
// state slot used by its callbacks initialized above that startup boundary so
// a fast session-list response cannot hit a temporal dead zone.
let agentInboxNavSession = null;
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
let diskHistoryFallback = null;

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
const customUiPanel = new CustomUiPanel({
  runtime,
  getTarget: () => target,
  onError: showError,
});
const extensionWidgets = new ExtensionWidgets({
  aboveEditor: document.getElementById("extension-widgets-above"),
  belowEditor: document.getElementById("extension-widgets-below"),
});
const contextUsage = setupContextUsage();
const compactContextButton = document.getElementById("compact-context-btn");
const filePreviewPanel = setupFilePreviewPanel();
const filePreviewFollow = createFilePreviewFollow({
  panel: filePreviewPanel,
  getWorkspacePath: async () => {
    try {
      const response = await data.workspaceInfo(target.workspaceId);
      return response?.info?.path ?? "";
    } catch {
      return "";
    }
  },
});
const gitPanel = setupGitPanel({
  runtime,
  getTarget: () => target,
  container: document.getElementById("git-panel"),
  fileSidebar: document.getElementById("file-sidebar"),
  fileList: document.getElementById("file-list"),
  filePreviewPanel,
  onError: showError,
});

// Owned by setupFileBrowser() once the sidebar DOM is ready. Kept at module
// scope so openFilesPanel() can refresh it after expanding the sidebar.
let fileBrowser = null;

/**
 * Expand the file sidebar, switch to the Files tab, and (when newly opened)
 * load the workspace root. Wired to #file-sidebar-toggle and Cmd/Ctrl+B.
 */
function openFilesPanel() {
  const sidebar = document.getElementById("file-sidebar");
  if (!sidebar) return;
  const opened = toggleExclusiveSidePanel(sidebar, [document.getElementById("diff-sidebar")]);
  gitPanel?.setTab("files");
  if (opened && fileBrowser?.currentPath === null) fileBrowser.load().catch(showError);
}

const sessionCostEl = document.getElementById("session-cost");

// Header status bar: aggregates session token/cost totals from session
// stats + live completions. Token in/out render on the combined
// token-usage pill; this bar only owns cost and publishes totals.
let headerStatusBar = null;
if (sessionCostEl) {
  headerStatusBar = createHeaderStatusBar({
    sessionCostEl,
    t,
    onTotalsChange: (totals) => contextUsage.setSessionTotals(totals),
  });
}

let sessionTotalCost = 0;

// Hydrate the header status bar from authoritative get_session_stats.
// The aggregate (output/cost) comes only from the server's tally, not
// from client-side message walking — repeated mirror syncs and history
// replay would otherwise inflate the totals.
let statsHydrationGeneration = 0;
function activeSessionFileForStatusBar() {
  const sessions = sidebar?.sessions ?? [];
  return (
    sessions.find((s) => s.id === target.sessionId)?.filePath ??
    sessions.find((s) => s.projectPath === store.cwd)?.filePath ??
    null
  );
}
async function hydrateHeaderSessionStats() {
  if (!headerStatusBar) return;
  const generation = ++statsHydrationGeneration;
  try {
    const frame = await runtime.request({ type: "get_session_stats" }, target);
    // runtime.request resolves with the full runtime_response frame; the pi
    // result lives in frame.response.
    const result = frame?.response ?? frame;
    if (!result?.success || !result?.data) return;
    if (generation !== statsHydrationGeneration) return;
    if (!result.data.sessionFile) return;
    const activeSessionFile = activeSessionFileForStatusBar();
    if (activeSessionFile && result.data.sessionFile !== activeSessionFile) return;
    headerStatusBar.hydrateSessionStats({
      sessionFile: result.data.sessionFile,
      tokens: result.data.tokens,
      cost: result.data.cost,
    });
  } catch {
    // Aggregate hydration is best-effort; the current-context path still works.
  }
}

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

// Compact coordinator: a single state machine that distinguishes the RPC
// acknowledgement from Pi's actual compaction_start/compaction_end lifecycle
// events. This prevents duplicate requests and ensures the UI only returns to
// idle when compaction truly completes (or fails).
const compactCoordinator = createCompactCoordinator({
  send: async () => {
    const frame = await runtime.request({ type: "compact" }, target, {
      idempotencyKey: randomId(),
    });
    // runtime.request resolves with the full runtime_response frame; the pi
    // compact result lives in frame.response. Extract it so the coordinator
    // sees { success, data } rather than the transport envelope.
    return frame?.response ?? { success: false };
  },
  onState: (state) => {
    contextUsage.setCompacting(state === "requested" || state === "running");
  },
});

async function requestManualCompaction() {
  if (
    !contextUsage.canCompact ||
    store.lifecycle === "working" ||
    store.compaction?.status === "running" ||
    compactCoordinator.busy
  )
    return;
  await compactCoordinator.request();
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
      // Custom extension UI panels (ctx.ui.custom) are bridged over notify too;
      // they render as an overlay rather than a transcript entry.
      if (customUiPanel.consumeNotify(request)) return;
      // rpiv-todo's /todos command emits a centered notify transcript. Picot
      // already mirrors the same state natively, so expand the panel instead
      // of rendering a duplicate system message. When nothing is mirrored (the
      // panel stays hidden, e.g. "No todos yet"), fall through and render the
      // message so /todos is never a silent no-op.
      if (isRpivTodoCommandNotify(request.message) && todoMirrorPanel.hasVisibleTasks) {
        todoMirrorPanel.expand();
        return;
      }
      messageRenderer.renderSystemMessage(request.message || "");
    },
    status: (request) => applyHostStatus(request.statusText),
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
      // Everything else falls back to the generic renderer, so an extension
      // that publishes a status panel is not silently dropped.
      extensionWidgets.apply(request);
    },
  },
});
sessionStatus.bind({
  abortButton,
  composerCard,
  getSessionId: () => target.sessionId,
  hasPending: (sessionId) => extensionUi.hasPending(sessionId),
  sendButton,
  statusIndicator,
  statusText,
});
await extensionUi.setForegroundSession(target.sessionId, { flush: false });
await extensionUi.flushForegroundQueue();

function summarizeMessageRoles(messages) {
  const counts = {};
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role || "unknown";
    counts[role] = (counts[role] || 0) + 1;
  }
  return counts;
}

function summarizeElementBox(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    tag: element.tagName?.toLowerCase() ?? null,
    id: element.id || null,
    className: String(element.className || ""),
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    position: style.position,
    zIndex: style.zIndex,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    top: Math.round(rect.top),
    left: Math.round(rect.left),
  };
}

function summarizeMessagesDom() {
  if (!messagesElement) return null;
  const style = getComputedStyle(messagesElement);
  const rect = messagesElement.getBoundingClientRect();
  const firstChildren = Array.from(messagesElement.children)
    .slice(0, 5)
    .map((child) => ({
      className: String(child.className || ""),
      textLength: child.textContent?.trim().length ?? 0,
      textPreview: (child.textContent || "").trim().slice(0, 80),
      box: summarizeElementBox(child),
    }));
  const centerX = Math.round(rect.left + rect.width / 2);
  const centerY = Math.round(rect.top + Math.min(rect.height / 2, 160));
  const elementAtCenter = document.elementFromPoint(centerX, centerY);
  return {
    bodyClass: document.body.className || null,
    bodyRuntime: document.body.dataset.runtime || null,
    url: window.location.href,
    messages: summarizeElementBox(messagesElement),
    main: summarizeElementBox(document.querySelector(".main")),
    workspaceContent: summarizeElementBox(document.querySelector(".workspace-content")),
    inputArea: summarizeElementBox(document.querySelector(".input-area")),
    superAgentRuntime: summarizeElementBox(document.querySelector("super-agent-runtime")),
    childCount: messagesElement.children.length,
    firstChildClass: messagesElement.firstElementChild?.className ?? null,
    userCount: messagesElement.querySelectorAll(".message.user, .user").length,
    assistantCount: messagesElement.querySelectorAll(".message.assistant, .assistant").length,
    toolCardCount: messagesElement.querySelectorAll(".tool-card").length,
    processGroupCount: messagesElement.querySelectorAll(".process-details").length,
    hasWelcome: Boolean(messagesElement.querySelector(".welcome")),
    scrollTop: Math.round(messagesElement.scrollTop),
    scrollHeight: messagesElement.scrollHeight,
    clientHeight: messagesElement.clientHeight,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    overflowY: style.overflowY,
    elementAtCenter: summarizeElementBox(elementAtCenter),
    firstChildren,
  };
}

function logMessagesDom(label, extra = {}) {
  console.info(`[SESSION-LOAD] ${label}`, extra);
  console.info(`[SESSION-LOAD] ${label} dom-json`, JSON.stringify(summarizeMessagesDom()));
}

function chooseHydrationMessages(snapshotMessages, reason) {
  const messages = Array.isArray(snapshotMessages) ? snapshotMessages : [];
  const fallbackMatches = diskHistoryFallback?.sessionId === target.sessionId;
  const fallbackCount = fallbackMatches ? diskHistoryFallback.messages.length : 0;
  const source = fallbackMatches && messages.length < fallbackCount ? "disk-fallback" : "snapshot";
  console.info("[SESSION-LOAD] hydrate message source", {
    reason,
    currentSessionId: target.sessionId,
    snapshotCount: messages.length,
    snapshotRoles: summarizeMessageRoles(messages),
    fallbackSessionId: diskHistoryFallback?.sessionId ?? null,
    fallbackCount,
    fallbackMatches,
    source,
  });
  return source === "disk-fallback" ? diskHistoryFallback.messages : messages;
}

const hydrateFromSnapshot = async (snapshot) => {
  console.info("[SESSION-LOAD] hydrate snapshot received", {
    currentSessionId: target.sessionId,
    snapshotTarget: snapshot?.target ?? null,
    snapshotCount: Array.isArray(snapshot?.state?.messages) ? snapshot.state.messages.length : null,
  });
  await adoptTarget(reconcileSnapshotTarget(target, snapshot.target));
  store = reduceSessionState(store, snapshot);
  const messages = chooseHydrationMessages(snapshot.state.messages, "snapshot");
  renderHistory(messages);
  todoMirrorPanel.hydrateFromMessages(messages);
  renderQueuedMessages(queuedMessages, store.queue);
  convNav.rebuild();
  const pi = snapshot.state.pi ?? {};
  setStatus(pi.isStreaming ? "working" : "connected");
  contextUsage.setWorking(Boolean(pi.isStreaming));
  if (pi.isStreaming) showLiveProcessIndicator();
  contextUsage.setCompacting(snapshot.state.compaction?.status === "running");
  updateComposerModel(pi.model ?? null);
  updateComposerThinking(pi.thinkingLevel ?? "off");
  contextUsage.setUsage(findLatestAssistantUsage(messages), currentModelContextWindow);
  setSessionCost(computeTotalCostFromMessages(messages));
  // Hydrate header status bar from authoritative get_session_stats
  hydrateHeaderSessionStats();
  // Flush queued extension prompts after rendering is settled so inline cards
  // are not immediately destroyed by a subsequent renderHistory() clear.
  await extensionUi.flushForegroundQueue();
  logMessagesDom("hydrate snapshot rendered", {
    sessionId: target.sessionId,
    renderedCount: messages.length,
  });
  requestAnimationFrame(() => {
    logMessagesDom("hydrate snapshot rendered after frame", {
      sessionId: target.sessionId,
      renderedCount: messages.length,
    });
  });
};

runtime.subscribe((frame) => {
  if (frame.type !== "runtime_event") return;
  taskCompletionNotifications.handleRuntimeFrame(frame);
  const previous = store;
  const routed = routeRuntimeFrame({
    frame,
    target,
    store,
    consumeConfigResponse: (candidate) => consumeConfigResponseFrame(config, candidate),
    reduceForeground: reduceSessionState,
  });
  if (routed.kind === "background" || routed.kind === "consumed-background") {
    if (routed.kind === "background") handleBackgroundRuntimeEvent(frame).catch(showError);
    return;
  }
  store = routed.store;
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
  if (routed.kind === "consumed-foreground") return;
  handleRuntimeEvent(frame.event).catch(showError);
});
setupConfigGatewayConnectionListener({
  adapter,
  isReady: () => configGatewayTargetReady,
  onDisconnected: () => setStatus("disconnected"),
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
  atFileMention = setupAtFileMention({
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
messagesElement.addEventListener("previewfile", (event) => {
  const path = event.detail?.path;
  if (path) void filePreviewFollow.openPath(path).catch(showError);
});
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
  else {
    setAgentInboxNavSession(null);
    sidebar?.render();
  }
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
  onRestarted: () => window.location.reload(),
  onThinkingLevelChanged: (level, changedTarget) => {
    if (changedTarget?.sessionId === target.sessionId) updateComposerThinking(level);
  },
});
setupAppUpdater({ settingsPanel });
setupNewSessionButton({ workspaceId: target.workspaceId, onError: showError });

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
  const initialLoadStartedAt = performance.now();
  console.info("[SESSION-LOAD] initial load started", { sessionId: route.sessionId });
  const bootstrapStartedAt = performance.now();
  const bootstrappedTarget = await loadBootstrapTarget(route);
  console.info("[SESSION-LOAD] initial bootstrap completed", {
    sessionId: bootstrappedTarget.sessionId,
    elapsedMs: Math.round(performance.now() - bootstrapStartedAt),
  });
  await adoptTarget(bootstrappedTarget, { updateRoute: false });
  // The eager sidebar request above can race bootstrap and observe a
  // temporarily empty host session index. Re-check once registration is
  // complete so startup and cross-project navigation converge without a
  // manual refresh.
  sidebar?.load({ quiet: true }).catch(showError);
  if (route.sessionId.startsWith("temporary-") && target.sessionId !== route.sessionId) {
    replaceTemporarySessionRoute(history, route.workspaceId, route.sessionId, target.sessionId);
  }
  const hostReadyStartedAt = performance.now();
  await adapter.ready();
  console.info("[SESSION-LOAD] initial Host connection ready", {
    elapsedMs: Math.round(performance.now() - hostReadyStartedAt),
    totalElapsedMs: Math.round(performance.now() - initialLoadStartedAt),
  });

  // Two-phase load: render session history from disk immediately while Pi
  // warms up, then overlay the authoritative Pi snapshot when it arrives.
  // Skip the fast path for brand-new (temporary) sessions — they have no
  // saved JSONL file yet and go straight to the Pi snapshot. Focus the
  // composer so the user can start typing right away.
  if (!target.sessionId.startsWith("temporary-")) {
    const diskResult = await data
      .readSessionMessages(target.workspaceId, target.sessionId)
      .catch((error) => {
        console.warn("[SESSION-LOAD] initial disk history failed", error);
        return null;
      });
    const diskMessages = diskResult?.messages ?? [];
    diskHistoryFallback =
      diskMessages.length > 0 ? { sessionId: target.sessionId, messages: diskMessages } : null;
    console.info("[SESSION-LOAD] initial disk fallback updated", {
      sessionId: target.sessionId,
      messageCount: diskMessages.length,
      roles: summarizeMessageRoles(diskMessages),
    });
    if (diskMessages.length > 0) {
      const renderStartedAt = performance.now();
      const hadInFlightPrompt = renderHistory(diskMessages);
      convNav.rebuild();
      console.info("[SESSION-LOAD] initial disk history rendered", {
        sessionId: target.sessionId,
        messageCount: diskMessages.length,
        elapsedMs: Math.round(performance.now() - renderStartedAt),
        totalElapsedMs: Math.round(performance.now() - initialLoadStartedAt),
      });
      setStatus("connected");
      if (hadInFlightPrompt) await extensionUi.flushForegroundQueue();
    }
  } else {
    diskHistoryFallback = null;
    console.info("[SESSION-LOAD] initial disk fallback skipped for temporary session", {
      sessionId: target.sessionId,
    });
    input.focus();
  }

  const snapshotStartedAt = performance.now();
  await hydrateSnapshotOnce();
  console.info("[SESSION-LOAD] initial Pi snapshot hydrated", {
    sessionId: target.sessionId,
    elapsedMs: Math.round(performance.now() - snapshotStartedAt),
    totalElapsedMs: Math.round(performance.now() - initialLoadStartedAt),
  });
  await Promise.all([
    loadCommands()
      .then(() => slashMenu.update())
      .catch((error) => {
        console.warn("[Native] Failed to load slash commands:", error);
      }),
    setupProjectHeader({
      data,
      workspaceId: target.workspaceId,
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
  agentInboxNavSelectSession = selectSession;
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
    onAgentInboxSessionChange: setAgentInboxNavSession,
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
  const switchStartedAt = performance.now();
  console.info("[SESSION-LOAD] session switch started", { sessionId, generation });

  // Keep the current messages visible while the new session loads. The
  // history render below replaces them atomically once the new data is ready.
  setStatus("loading");

  // Phase 1: fire bootstrap (spawns Pi if needed) and fast disk message read
  // in parallel. The disk read returns messages without waiting for Pi to start.
  const workspaceId = target.workspaceId;
  const bootstrapPromise = loadBootstrapTarget({ name: "session", workspaceId, sessionId }).then(
    (nextTarget) => {
      console.info("[SESSION-LOAD] switch bootstrap completed", {
        sessionId,
        generation,
        elapsedMs: Math.round(performance.now() - switchStartedAt),
      });
      return nextTarget;
    },
  );
  const [nextTarget, diskLoad] = await Promise.all([
    bootstrapPromise,
    data
      .readSessionMessages(workspaceId, sessionId)
      .then((result) => {
        if (generation !== navigationGeneration) return { result, hadInFlightPrompt: false };
        const diskMessages = result?.messages ?? [];
        diskHistoryFallback =
          diskMessages.length > 0 ? { sessionId, messages: diskMessages } : null;
        console.info("[SESSION-LOAD] switch disk fallback updated", {
          sessionId,
          messageCount: diskMessages.length,
          roles: summarizeMessageRoles(diskMessages),
        });
        const renderStartedAt = performance.now();
        const hadInFlightPrompt = renderHistory(diskMessages);
        convNav.rebuild();
        console.info("[SESSION-LOAD] switch disk history rendered", {
          sessionId,
          generation,
          messageCount: diskMessages.length,
          elapsedMs: Math.round(performance.now() - renderStartedAt),
          totalElapsedMs: Math.round(performance.now() - switchStartedAt),
        });
        return { result, hadInFlightPrompt };
      })
      .catch((error) => {
        console.warn("[SESSION-LOAD] switch disk history failed", error);
        return { result: null, hadInFlightPrompt: false };
      }),
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

  // Phase 2: disk history was rendered by the parallel read as soon as it
  // arrived, without waiting for the Pi process to finish bootstrapping.
  setStatus("connected");
  if (diskLoad.hadInFlightPrompt) {
    await extensionUi.flushForegroundQueue();
  }

  // Phase 3: get the authoritative snapshot from Pi (Pi may still be starting).
  // When it arrives, re-render with the live state (model, thinking level,
  // lifecycle) and the authoritative message tree (handles branched sessions).
  try {
    const snapshotStartedAt = performance.now();
    const snapshot = await runtime.snapshot(target.sessionId);
    if (generation !== navigationGeneration) return;
    await hydrateFromSnapshot(snapshot);
    console.info("[SESSION-LOAD] switch Pi snapshot hydrated", {
      sessionId: target.sessionId,
      generation,
      elapsedMs: Math.round(performance.now() - snapshotStartedAt),
      totalElapsedMs: Math.round(performance.now() - switchStartedAt),
    });
  } catch (error) {
    if (generation !== navigationGeneration) return;
    // Pi snapshot failed but disk messages are already showing — degrade
    // gracefully rather than surfacing an error over a readable history.
    console.warn("[switchSession] Pi snapshot failed, showing disk history:", error);
    setStatus("connected");
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

function updateSuperAgentActiveState(session = null, { openRuntimePanel = false } = {}) {
  const active = isSuperAgentSessionSummary(session);
  document.body.classList.toggle("super-agent-active", active);
  document.getElementById("super-agent-chat-header")?.classList.toggle("hidden", !active);
  updateAgentInboxNavActive();

  // Selecting/restoring the Agent Inbox session should not automatically open
  // the task runtime panel: on narrow windows it can squeeze the chat column to
  // an unreadable sliver. Explicit runtime opens (`sa-open-runtime`) opt in.
  if (active && !openRuntimePanel) {
    document.querySelector("super-agent-runtime")?.classList.add("collapsed");
    console.info("[SESSION-LOAD] Agent Inbox active; runtime panel kept collapsed", {
      sessionId: target.sessionId,
    });
  }
}

function setAgentInboxNavSession(session) {
  agentInboxNavSession = session;
  const button = document.getElementById("sidebar-agent-inbox-btn");
  button?.classList.toggle("hidden", !session);
  updateAgentInboxNavActive();
}

function updateAgentInboxNavActive() {
  const button = document.getElementById("sidebar-agent-inbox-btn");
  button?.classList.toggle("active", document.body.classList.contains("super-agent-active"));
}

function openAgentInboxNav({ openRuntimePanel = false } = {}) {
  if (!agentInboxNavSession) return;
  updateSuperAgentActiveState(agentInboxNavSession, { openRuntimePanel });
  const selected = agentInboxNavSelectSession?.(agentInboxNavSession);
  if (selected && typeof selected.catch === "function") selected.catch(showError);
}

document.getElementById("sidebar-agent-inbox-btn")?.addEventListener("click", () => {
  openAgentInboxNav();
});

document.addEventListener("sa-open-agent-inbox", (event) => {
  openAgentInboxNav({ openRuntimePanel: event.detail?.openRuntimePanel === true });
});

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
      if (frame.event.message?.role === "assistant") {
        sidebar?.markUnread(sessionId);
      }
      break;
    case "session_bound":
      await bindDispatchedChildSession(frame.target?.instanceId, frame.event?.sessionId);
      break;
    case "session_info_changed":
      sidebar?.setSessionName(sessionId, frame.event.name);
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

  // File/Git sidebar — right-edge panel, drag handle on the left side.
  // Uses the native --panel-width CSS variable (same as super-agent runtime
  // panel). Width persists to localStorage under a separate key.
  const fileSidebarEl = document.getElementById("file-sidebar");
  setupResizablePanel(fileSidebarEl, {
    storageKey: "pi-studio-file-sidebar-width",
    defaultWidth: 260,
    minWidth: 200,
    maxWidth: 500,
    side: "right",
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

  const refreshBtn = document.getElementById("file-sidebar-refresh");
  const toggleHiddenBtn = document.getElementById("file-sidebar-toggle-hidden");

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
    onMention(entry) {
      if (!atFileMention) return;
      const isDirectory = entry.kind === "directory" || entry.isDirectory;
      const value = buildAtMentionValue(entry.relativePath, isDirectory);
      input.focus();
      atFileMention.insert(value, isDirectory);
      composerAutoResize.sync();
    },
    onPathChange(path) {
      // Enable the up button only when we're inside a subdirectory.
      if (upBtn) upBtn.disabled = path === "";
    },
    onShowHiddenChange(showHidden) {
      toggleHiddenBtn?.setAttribute("aria-pressed", String(showHidden));
    },
  });

  refreshBtn?.addEventListener("click", () => fileBrowser?.refresh()?.catch(showError));
  toggleHiddenBtn?.addEventListener("click", () => {
    fileBrowser?.setShowHidden(!fileBrowser.showHidden)?.catch(showError);
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
  const diffToggle = document.getElementById("diff-sidebar-toggle");
  diffToggle?.addEventListener("click", () => {
    // Header Git button: open the File/Git sidebar and switch to the Git tab,
    // instead of the legacy diff-sidebar panel.
    const fileSidebarEl = document.getElementById("file-sidebar");
    const opened = toggleExclusiveSidePanel(fileSidebarEl, [diffSidebar]);
    if (opened) gitPanel?.setTab("git");
  });
  document.getElementById("diff-sidebar-close")?.addEventListener("click", () => {
    diffSidebar.classList.add("collapsed");
  });
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
      setStatus("working");
      contextUsage.setWorking(true);
      sidebar?.setStreaming(target.sessionId, true);
      break;
    case "agent_settled":
      setStatus("connected");
      contextUsage.setWorking(false);
      sidebar?.setStreaming(target.sessionId, false);
      hideLiveProcessIndicator();
      collapseCompletedTurn({ markDone: true });
      break;
    case "session_info_changed":
      sidebar?.setSessionName(target.sessionId, event.name);
      break;
    case "compaction_start":
      compactCoordinator.started();
      break;
    case "compaction_end": {
      const succeeded =
        !event.errorMessage && !event.error && !event.aborted && event.result !== null;
      compactCoordinator.ended({
        success: succeeded,
        error: event.errorMessage || event.error,
      });
      if (!succeeded) {
        const error = event.errorMessage || event.error;
        if (error) showError(new Error(error));
      } else {
        // Pi has replaced its context; the old aggregate is stale. Re-hydrate
        // from the authoritative get_session_stats.
        await hydrateSnapshotOnce();
        hydrateHeaderSessionStats();
      }
      break;
    }
    case "message_start":
      if (event.message?.role === "user") {
        messageRenderer.renderUserMessage(event.message);
        upsertActiveSessionFromUserMessage(event.message);
      } else if (event.message?.role === "assistant") {
        showLiveProcessIndicator();
        streamingElement = messageRenderer.renderAssistantMessage(event.message, true);
      }
      break;
    case "message_update":
      if (!streamingElement) {
        showLiveProcessIndicator();
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
        headerStatusBar?.applyLiveUsage?.(event.message.usage ?? null);
        streamingElement = null;
        convNav.notifyNewMessage();
      }
      break;
    case "tool_execution_start":
      toolRenderer.createToolCard({ ...event, status: "pending" });
      filePreviewFollow.onToolStart(event);
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
      void filePreviewFollow.onToolEnd(event).catch(showError);
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
  // Widgets and any open custom-UI panel belong to the session that published
  // them; carrying them across a switch would show another session's state.
  extensionWidgets.clear();
  customUiPanel.close({ notifyExtension: false });
  filePreviewFollow.clear();
  streamingElement = null;
  liveProcessGroup = null;
  adapter.subscribeTarget(target);
  sidebar?.setActive(target.sessionId);
  // When the workspace changes, the cached session list is stale — reload it
  // so the sidebar reflects the new project's sessions. Same-workspace
  // session switches skip this (the list is already current). Without this
  // the sidebar never populated after bootstrap, because the initial
  // sidebar.load() at startup runs before the workspace is resolved.
  if (nextTarget.workspaceId !== previousTarget.workspaceId) {
    sidebar?.load().catch(showError);
  }
  sessionInfo.refresh();
  headerStatusBar?.reset?.();
  // Re-hydrate the aggregate stats for the new session.
  hydrateHeaderSessionStats();
  setSessionCost(0);
  // Save the outgoing session's draft and restore the incoming session's
  if (previousTarget.sessionId && previousTarget.sessionId !== "pending-bootstrap") {
    sessionUiState.saveDraft(previousTarget.sessionId, input.value);
  }
  // Restore model/thinking for the new session
  const restoredProfile = await sessionUiState.loadProfile();
  if (restoredProfile) {
    updateComposerModel({ id: restoredProfile.modelId });
    updateComposerThinking(restoredProfile.thinkingLevel);
  }
  // Restore input draft for the new session
  const draft = sessionUiState.loadDraft(nextTarget.sessionId);
  input.value = draft || "";
  composerAutoResize.sync();
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
  console.info("[SESSION-LOAD] renderHistory start", {
    sessionId: target.sessionId,
    messageCount: messages.length,
    roles: summarizeMessageRoles(messages),
    existingChildCount: messagesElement?.children?.length ?? null,
  });
  const hadInFlightPrompt = extensionUi.requeueForegroundPrompt();
  const expandedProcessGroups = captureExpandedProcessGroups(messagesElement);
  messageRenderer.clear();
  toolRenderer.clear();
  liveProcessGroup = null;
  if (messages.length === 0) {
    messageRenderer.renderWelcome();
    applyActiveSearchHighlight({ scrollToFirst: false });
    logMessagesDom("renderHistory empty", {
      sessionId: target.sessionId,
    });
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

  let processGroupIndex = 0;
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
        group = createProcessDetailsGroup({
          expanded: expandedProcessGroups.has(processGroupIndex),
        });
        processGroupIndex += 1;
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
        // A turn that ends on this message with no trailing answer text is
        // incomplete (the run was cut off mid tool-use, e.g. a dropped
        // connection). Surface the assistant's leading narration instead of
        // silently folding it into "Process details" with nothing visible.
        const isUnterminatedTurn = answerBlocks.length === 0 && i === messages.length - 1;
        if (isUnterminatedTurn) {
          const leadingText = processBlocks.filter((b) => b.type === "text");
          if (leadingText.length > 0) {
            messageRenderer.renderAssistantMessage(
              { content: leadingText, usage: message.usage, timestamp: message.timestamp },
              false,
              true,
            );
          }
          const remainingProcessBlocks = processBlocks.filter((b) => b.type !== "text");
          if (remainingProcessBlocks.some((b) => b.type === "thinking")) {
            const el = messageRenderer.renderAssistantMessage(
              { content: remainingProcessBlocks, usage: message.usage },
              false,
              true,
              ensureGroup().body,
            );
            if (el) stepCount += 1;
          }
          if (remainingProcessBlocks.some((b) => b.type === "toolCall")) {
            toolCallCount += renderToolCallBlocks(
              remainingProcessBlocks,
              toolResults,
              ensureGroup().body,
            );
          }
        } else {
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
        }
        if (answerBlocks.length > 0) {
          messageRenderer.renderAssistantMessage(
            { content: answerBlocks, usage: message.usage, timestamp: message.timestamp },
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
  logMessagesDom("renderHistory complete", {
    sessionId: target.sessionId,
    inputCount: messages.length,
    turnCount: turns.length,
    highlighted,
  });
  return hadInFlightPrompt;
}

/**
 * Fold the just-finished turn's thinking blocks and tool cards into a
 * collapsed "Process details" group, leaving the user prompt and final
 * answer as the only visible content. Runs once a turn fully completes
 * (`agent_settled`) — while streaming, everything still renders flat and
 * expanded so the user can watch it happen live, matching pi-web.
 */
function collapseCompletedTurn({ markDone = false } = {}) {
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
  if (markDone) group.markDone();
}

/**
 * Show a pulsing "Process details" placeholder right where the assistant's
 * response is about to appear, so there's an immediate live-thinking cue
 * (matching the shimmer other chat UIs use) even before
 * `collapseCompletedTurn` builds the real group. Idempotent — only the first
 * call in a turn actually inserts anything, so the indicator's position
 * (right before the assistant's first message) never moves mid-turn.
 */
function showLiveProcessIndicator() {
  if (liveProcessGroup) return;
  liveProcessGroup = createProcessDetailsGroup();
  liveProcessGroup.setLabel(t("messages.thinking"));
  liveProcessGroup.setStreaming(true);
  messagesElement.appendChild(liveProcessGroup.wrapper);
  messageRenderer.forceScrollToBottom();
}

function hideLiveProcessIndicator() {
  liveProcessGroup?.wrapper.remove();
  liveProcessGroup = null;
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

function abortCurrentRun() {
  runtime.request({ type: "abort" }, target).catch(showError);
  // A tool call blocked on ctx.ui.select/confirm/input/editor won't be
  // unblocked by "abort" alone — pi is waiting on an extension_ui_response
  // that only the UI can send. Without this, an unanswered/cancelled prompt
  // leaves the run wedged forever with Stop appearing to do nothing.
  extensionUi.cancelForeground();
}

function showError(error) {
  setStatus("disconnected");
  messageRenderer.renderError(error?.message || String(error));
}

// ── Composer model dropdown & thinking button (functions & event wiring) ────────

function updateComposerModel(model) {
  currentModelId = model?.id ?? null;
  // Persist the model change to session UI state
  sessionUiState
    .saveProfile({
      provider: "anthropic",
      modelId: currentModelId || "",
      thinkingLevel: currentThinkingLevel,
    })
    .catch(() => {});
  currentModelContextWindow =
    Number(model?.contextWindow) || findModelContextWindow(currentModelId);
  contextUsage.setContextWindowSize(currentModelContextWindow);
  if (modelDropdownLabel) {
    modelDropdownLabel.textContent = formatModelName(model) || "model";
  }
}

function updateComposerThinking(level) {
  currentThinkingLevel = level ?? "off";
  sessionUiState
    .saveProfile({
      provider: "anthropic",
      modelId: currentModelId || "",
      thinkingLevel: currentThinkingLevel,
    })
    .catch(() => {});
  if (thinkingBtn) {
    const levelLabel = formatThinkingLevelLabel(currentThinkingLevel);
    thinkingBtn.textContent = t("settings.thinkingCompact", { level: levelLabel });
    thinkingBtn.className = `thinking-tag${currentThinkingLevel === "off" ? " off" : ""}`;
    thinkingBtn.title = t("settings.thinkingTitle");
    thinkingBtn.setAttribute("aria-label", t("settings.thinkingAriaLabel", { level: levelLabel }));
  }
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
    // Provider credentials / models.json live on the Models tab since the
    // settings split; Advanced Configuration is the agent settings.json
    // editor and would land the user on the wrong page.
    settingsPanel?.openSettings("models");
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
      // Reconcile the thinking level after a model switch. pi 0.83's set_model
      // response is the Model object (no thinkingLevel field, see rpc.md); the
      // server's effective thinking level for the new model lives in get_state.
      const stateResult = await runtime.request({ type: "get_state" }, target);
      const level = stateResult?.response?.data?.thinkingLevel;
      if (level) updateComposerThinking(level);
    } catch (error) {
      showError(error);
    }
  });

  return item;
}

function renderModelDropdownItems(container, filter = "") {
  container.replaceChildren();
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
  modelDropdownMenu.replaceChildren();

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
  renderStatus();
});

if (thinkingBtn) {
  thinkingBtn.addEventListener("click", async () => {
    try {
      // Ask the server to cycle through the current model's supported levels
      // (cycle_thinking_level) instead of stepping a fixed client-side array —
      // the server skips levels the active model does not support.
      const result = await runtime.request({ type: "cycle_thinking_level" }, target);
      const level = result?.response?.data?.level;
      if (level) updateComposerThinking(level);
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
