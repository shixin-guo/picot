import { reconcileSnapshotTarget } from "../session/bootstrap-target.js";
import { applyTheme, getCurrentTheme } from "../themes.js";
import { MessageRenderer } from "../ui/message-renderer.js";
import { ToolCardRenderer } from "../ui/tool-card.js";
import { HostDataGateway } from "./data-gateway.js";
import { showNativeDialog } from "./dialog.js";
import { ExtensionUiHost } from "./extension-ui-host.js";
import { NativeFileBrowser } from "./file-browser.js";
import { parseAppRoute, replaceTemporarySessionRoute } from "./router.js";
import { HostRuntimeAdapter, resolveHostWebSocketUrl } from "./runtime-adapter.js";
import { RuntimeGateway } from "./runtime-gateway.js";
import { createSessionStore, reduceSessionState } from "./session-store.js";
import { buildCommandCatalog, resolveComposerInput } from "./slash-commands.js";

const route = parseAppRoute(window.location.pathname);
if (route.name !== "session") throw new Error("Native Picot requires a session route");

applyTheme(getCurrentTheme());
document.body.dataset.runtime = "native";

const messagesElement = document.getElementById("messages");
const messageRenderer = new MessageRenderer(messagesElement);
const toolRenderer = new ToolCardRenderer(messagesElement);
const input = document.getElementById("message-input");
const form = document.getElementById("chat-form");
const abortButton = document.getElementById("abort-btn");
const statusText = document.getElementById("status-text");
const statusIndicator = document.getElementById("status-indicator");
let target = await loadBootstrapTarget(route);
let store = createSessionStore(target);
let commandCatalog = buildCommandCatalog({
  builtIns: [
    { name: "settings", description: "Open settings", action: "open_settings" },
    { name: "tree", description: "Open session tree", action: "open_tree" },
    { name: "help", description: "Show Picot help", action: "show_help" },
  ],
});
let streamingElement = null;

const adapter = new HostRuntimeAdapter({
  url: resolveHostWebSocketUrl(window),
  clientId: `desktop-${crypto.randomUUID()}`,
});
const runtime = new RuntimeGateway(adapter);
const data = new HostDataGateway(adapter);
const extensionUi = new ExtensionUiHost({
  runtime,
  showDialog: showNativeDialog,
  hooks: {
    notify: (request) => messageRenderer.renderSystemMessage(request.message || ""),
    status: (request) => setStatus(request.statusText || "Ready"),
    title: (request) => {
      if (request.title) document.title = request.title;
    },
    editorText: (request) => {
      input.value = request.text || "";
      input.focus();
    },
  },
});
await extensionUi.setForegroundSession(target.sessionId);

runtime.subscribe((frame) => {
  if (frame.type !== "runtime_event" || frame.target.instanceId !== target.instanceId) return;
  const previous = store;
  store = reduceSessionState(store, frame);
  if (!previous.snapshotRequired && store.snapshotRequired) {
    hydrateSnapshot().catch(showError);
    return;
  }
  handleRuntimeEvent(frame.event).catch(showError);
});
adapter.subscribeTarget(target);
adapter.connect();
await adapter.ready();
await hydrateSnapshot();
await loadCommands();
await renderSessionList();

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  sendComposerInput({ altKey: event.altKey }).catch(showError);
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  sendComposerInput({ altKey: false }).catch(showError);
});
abortButton?.addEventListener("click", () => {
  runtime.request({ type: "abort" }, target).catch(showError);
});
document.getElementById("refresh-sessions-btn")?.addEventListener("click", () => {
  renderSessionList().catch(showError);
});
setupFileBrowser();

async function loadBootstrapTarget(currentRoute) {
  const query = new URLSearchParams({
    workspaceId: currentRoute.workspaceId,
    sessionId: currentRoute.sessionId,
  });
  const response = await fetch(`/v2/bootstrap?${query}`);
  if (!response.ok) throw new Error("This Picot runtime is stopped or unavailable");
  return response.json();
}

async function hydrateSnapshot() {
  const snapshot = await runtime.snapshot(target.sessionId);
  await adoptTarget(reconcileSnapshotTarget(target, snapshot.target));
  store = reduceSessionState(store, snapshot);
  renderHistory(snapshot.state.messages ?? []);
  const pi = snapshot.state.pi ?? {};
  setStatus(pi.isStreaming ? "Working…" : "Ready");
}

async function loadCommands() {
  const result = await runtime.request({ type: "get_commands" }, target);
  commandCatalog = buildCommandCatalog({
    builtIns: [...commandCatalog.values()].filter((command) => command.type === "builtin"),
    nativeCommands: result.response?.data?.commands ?? [],
  });
}

async function renderSessionList() {
  const container = document.getElementById("session-list");
  if (!container) return;
  const response = await data.listSessions(target.workspaceId);
  container.replaceChildren();
  for (const session of response.sessions ?? []) {
    const item = document.createElement("div");
    item.className = "session-item";
    if (session.id === target.sessionId) item.classList.add("active");
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = session.name || session.firstMessage || "Untitled";
    const timestamp = document.createElement("div");
    timestamp.className = "session-meta";
    timestamp.textContent = session.timestamp || "";
    item.append(title, timestamp);
    container.append(item);
  }
  if (!container.hasChildNodes()) {
    const empty = document.createElement("div");
    empty.className = "session-loading";
    empty.textContent = "No saved sessions";
    container.append(empty);
  }
}

function setupFileBrowser() {
  const sidebar = document.getElementById("file-sidebar");
  const fileList = document.getElementById("file-list");
  const pathEl = document.getElementById("file-sidebar-path");
  if (!sidebar || !fileList || !pathEl) return;

  const browser = new NativeFileBrowser(fileList, pathEl, data, target.workspaceId);

  // The Host data plane has no "open file natively" operation yet, unlike
  // the legacy `/api/open` endpoint — hide the control instead of wiring a
  // button that would silently do nothing.
  document.getElementById("file-sidebar-finder")?.style.setProperty("display", "none");

  document.getElementById("file-sidebar-toggle")?.addEventListener("click", () => {
    const isCollapsed = sidebar.classList.toggle("collapsed");
    if (!isCollapsed && browser.currentPath === null) browser.load().catch(showError);
  });
  document.getElementById("file-sidebar-close")?.addEventListener("click", () => {
    sidebar.classList.add("collapsed");
  });
  document.getElementById("file-sidebar-up")?.addEventListener("click", () => {
    const parent = browser.getParentPath();
    if (parent !== null) browser.load(parent).catch(showError);
  });
}

async function sendComposerInput({ altKey }) {
  const value = input.value;
  if (!value.trim()) return;
  const intent = resolveComposerInput(value, commandCatalog, {
    working: store.lifecycle === "working",
    altKey,
  });
  if (intent.kind === "rejected") throw new Error(intent.reason);
  if (intent.kind === "builtin") {
    runBuiltin(intent.action);
    return;
  }
  input.value = "";
  try {
    await runtime.request(intent.command, target, { idempotencyKey: crypto.randomUUID() });
  } catch (error) {
    input.value = value;
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
      break;
    case "agent_settled":
      setStatus("Ready");
      break;
    case "message_start":
      if (event.message?.role === "user") messageRenderer.renderUserMessage(event.message);
      else if (event.message?.role === "assistant") {
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
        streamingElement = null;
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
      break;
    case "extension_ui_request":
      await extensionUi.handle(target, event);
      break;
    case "extension_error":
      showError(new Error(event.error || "Extension failed"));
      break;
    case "session_bound":
      await adoptTarget({ ...target, sessionId: event.sessionId });
      break;
  }
}

async function adoptTarget(nextTarget) {
  if (nextTarget.sessionId === target.sessionId) return;
  replaceTemporarySessionRoute(history, target.workspaceId, target.sessionId, nextTarget.sessionId);
  target = nextTarget;
  store = { ...store, target: { ...nextTarget } };
  adapter.subscribeTarget(target);
  await extensionUi.setForegroundSession(target.sessionId);
}

function renderHistory(messages) {
  messageRenderer.clear();
  toolRenderer.clear();
  if (messages.length === 0) {
    messageRenderer.renderWelcome();
    return;
  }
  for (const message of messages) {
    if (message.role === "user") messageRenderer.renderUserMessage(message, true);
    if (message.role === "assistant") messageRenderer.renderAssistantMessage(message, false, true);
  }
}

function textFromResult(result) {
  return (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function setStatus(text) {
  statusText.textContent = text;
  statusIndicator?.classList.toggle("active", text !== "Ready");
}

function showError(error) {
  messageRenderer.renderError(error?.message || String(error));
}

window.__picotNative = {
  runtime,
  data,
  adapter,
  get target() {
    return target;
  },
};
