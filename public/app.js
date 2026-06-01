/**
 * Main App - Ties everything together
 */

import { WebSocketClient } from './websocket-client.js';
import { StateManager } from './state.js';
import { MessageRenderer } from './message-renderer.js';
import { ToolCardRenderer } from './tool-card.js';
import { DialogHandler } from './dialogs.js';
import { SessionSidebar } from './session-sidebar.js';
import { themes, applyTheme, getCurrentTheme } from './themes.js';
import { FileBrowser } from './file-browser.js';
import {
  startNewProjectChat,
  openProjectWorkspace,
  openFolderAsWorkspace,
  startInWindowNewSession,
} from './workspace-actions.js';
import {
  clearSettingsSaveMessage,
  showSettingsSaveError,
  showSettingsSaveSuccess,
  setSettingsSaveButtonSaving,
} from './settings-save-status.js';

const fetchInstances = async () => {
  try {
    const res = await fetch('/api/instances');
    if (!res.ok) return [];
    const data = await res.json();
    return data.instances || [];
  } catch {
    return [];
  }
};
const getCurrentPort = () => {
  const fromTauri = window.tauriNative?.currentPort?.();
  if (typeof fromTauri === 'number') return fromTauri;
  const fromLocation = Number(location.port);
  return Number.isFinite(fromLocation) && fromLocation > 0 ? fromLocation : 47821;
};
const navigateInWindow = (url) => {
  window.location.href = url;
};

// ──────────────────────────────────────────────────────────────────────
// Instance-swap overlay
// ──────────────────────────────────────────────────────────────────────
// `+ New Session`, `start new chat`, `Open Project`, and `Open Folder`
// all end with `window.location.href = http://localhost:<newPort>/`,
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
    sessionStorage.setItem('pi-studio:swapping-instance', '1');
  } catch {}
  document.body.classList.add('swapping-instance');
  const overlay = document.getElementById('instance-swap-overlay');
  if (overlay) overlay.setAttribute('data-visible', 'true');
  const labelEl = document.getElementById('instance-swap-overlay-label');
  if (labelEl && typeof label === 'string' && label) labelEl.textContent = label;
  return hideSwapOverlay;
}

function hideSwapOverlay() {
  try {
    sessionStorage.removeItem('pi-studio:swapping-instance');
  } catch {}
  document.body.classList.remove('swapping-instance');
  const overlay = document.getElementById('instance-swap-overlay');
  if (overlay) overlay.setAttribute('data-visible', 'false');
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
  if (!document.body.classList.contains('swapping-instance')) return;
  const fade = () => {
    requestAnimationFrame(() => {
      const overlay = document.getElementById('instance-swap-overlay');
      if (overlay) overlay.setAttribute('data-visible', 'false');
      document.body.classList.remove('swapping-instance');
      try {
        sessionStorage.removeItem('pi-studio:swapping-instance');
      } catch {}
    });
  };
  const alreadyOpen = wsClient.ws && wsClient.ws.readyState === WebSocket.OPEN;
  if (alreadyOpen) {
    fade();
  } else {
    const onConnect = () => {
      wsClient.removeEventListener('connected', onConnect);
      fade();
    };
    wsClient.addEventListener('connected', onConnect);
  }
  setTimeout(() => {
    if (document.body.classList.contains('swapping-instance')) hideSwapOverlay();
  }, 5000);
}


// Initialize components
const wsUrl = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const wsClient = new WebSocketClient(wsUrl);
const state = new StateManager();
const messageRenderer = new MessageRenderer(document.getElementById('messages'));
const toolCardRenderer = new ToolCardRenderer(document.getElementById('messages'));
const dialogHandler = new DialogHandler(document.getElementById('dialog-container'), wsClient);

// Session sidebar
const sidebar = new SessionSidebar(
  document.getElementById('session-list'),
  handleSessionSelect,
  handleNewProjectChat
);

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const openFolderBtn = document.getElementById('open-folder-btn');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const sidebarOverlay = document.getElementById('sidebar-overlay');

const refreshSessionsBtn = document.getElementById('refresh-sessions-btn');
const sessionSearchInput = document.getElementById('session-search-input');
const typingIndicator = document.getElementById('typing-indicator');

const sessionCostEl = document.getElementById('session-cost');
const tokenUsageEl = document.getElementById('token-usage');
const scrollBottomBtn = document.getElementById('scroll-bottom-btn');
const scrollBottomBadge = document.getElementById('scroll-bottom-badge');
const messagesContainer = document.getElementById('messages');

// State tracking
let currentStreamingElement = null;
let currentStreamingText = '';
let sessionTotalCost = 0;
let lastInputTokens = 0;
let contextWindowSize = 0;  // fetched from model info
let originalTitle = document.title;
let hasFocus = true;
let unreadCount = 0;
let isScrolledUp = false;
let hasNewWhileScrolled = false;
let lastSentMessage = null; // Track to avoid duplicate rendering in mirror mode
let lastUsage = null; // Full usage object for context visualiser
let mirrorActiveSessionFile = null; // The live session file path from the TUI
let viewingActiveSession = true; // Whether we're viewing the live session or a historical one
let isMirrorMode = false; // Set when mirror_sync received
let liveInstances = []; // All running Pi Studio instances [{port, sessionFile, cwd}]
let workspaceLaunchInProgress = false;
// When true, the next message_end should trigger a sidebar reload so a freshly
// created (in-memory only) session shows up in the list as soon as it's persisted.
let pendingNewSessionRefresh = false;
// When set while streaming, holds the session filePath to switch to once the
// current agent run ends. The history is rendered immediately; pi gets the
// switch_session RPC only after agent_end so the running call is not aborted.
let pendingSessionSwitchPath = null;
let sessionsLoaded = false;
let deferredMirrorSync = null;
let lastRenderedWelcomeWorkspacePath = null;
// Concurrent session support: background WebSocket connections to sessions
// that are streaming while the user views a different session.
// Maps port -> { ws: WebSocket, sessionFile: string }
const backgroundConnections = new Map();
// Maps port -> sessionFile for each pi process we're tracking
const portSessionMap = new Map();
// The port that wsClient is currently connected to (the "foreground" session)
let foregroundPort = getCurrentPort();
wsClient.setRoutingContext({
  workspaceId: `workspace:${getCurrentWorkspacePath() || 'unknown'}`,
});

const workspaceIndicatorEl = document.createElement('div');
workspaceIndicatorEl.id = 'workspace-indicator';
workspaceIndicatorEl.className = 'pill workspace-indicator hidden';
workspaceIndicatorEl.title = '';
document.querySelector('.header-right')?.insertBefore(workspaceIndicatorEl, document.querySelector('.status'));

function updateWorkspaceIndicator(path = '') {
  const normalizedPath = typeof path === 'string' ? path.trim() : '';
  if (!normalizedPath) {
    workspaceIndicatorEl.classList.add('hidden');
    workspaceIndicatorEl.textContent = '';
    workspaceIndicatorEl.title = '';
    return;
  }
  workspaceIndicatorEl.classList.remove('hidden');
  workspaceIndicatorEl.textContent = normalizedPath;
  workspaceIndicatorEl.title = normalizedPath;
}

function syncWorkspaceIndicatorFromInstances() {
  const current = liveInstances.find((instance) => instance?.port === getCurrentPort());
  updateWorkspaceIndicator(current?.cwd || '');
}

function getCurrentWorkspacePath() {
  const current = liveInstances.find((instance) => instance?.port === getCurrentPort());
  return current?.cwd || '';
}

function renderWorkspaceWelcome({ force = false } = {}) {
  const workspacePath = getCurrentWorkspacePath();
  const welcomeVisible = Boolean(document.querySelector('.welcome'));
  if (!force && welcomeVisible && lastRenderedWelcomeWorkspacePath === workspacePath) {
    return;
  }
  messageRenderer.renderWelcome({ workspacePath });
  lastRenderedWelcomeWorkspacePath = workspacePath;
}

function hasAnySessionsLoaded() {
  return Array.isArray(sidebar.projects)
    && sidebar.projects.some((project) => Array.isArray(project.sessions) && project.sessions.length > 0);
}

function setWorkspaceLaunchInProgress(inProgress) {
  workspaceLaunchInProgress = inProgress;
  if (openFolderBtn) {
    openFolderBtn.disabled = inProgress;
    openFolderBtn.setAttribute('aria-busy', inProgress ? 'true' : 'false');
    openFolderBtn.title = inProgress ? 'Opening workspace...' : 'Open folder as workspace';
  }
}

// File browser
const fileSidebar = document.getElementById('file-sidebar');
const fileSidebarToggle = document.getElementById('file-sidebar-toggle');
const fileSidebarClose = document.getElementById('file-sidebar-close');
const fileSidebarUp = document.getElementById('file-sidebar-up');
const fileList = document.getElementById('file-list');
const fileSidebarPath = document.getElementById('file-sidebar-path');
const fileBrowser = new FileBrowser(fileList, fileSidebarPath, messageInput);
const isTauriRuntime = Boolean(window.tauriNative?.isTauri || window.__TAURI__?.core?.invoke);

if (!isTauriRuntime) {
  messageRenderer.renderError('This app is Tauri-only. Please launch it from the Tauri desktop app.');
}

fileSidebarToggle.addEventListener('click', () => {
  const isCollapsed = fileSidebar.classList.toggle('collapsed');
  if (!isCollapsed && !fileBrowser.currentPath) {
    fileBrowser.load(); // Load session cwd
  }
  localStorage.setItem('pi-studio-file-sidebar', isCollapsed ? 'closed' : 'open');
});

fileSidebarClose.addEventListener('click', () => {
  fileSidebar.classList.add('collapsed');
  localStorage.setItem('pi-studio-file-sidebar', 'closed');
});

fileSidebarUp.addEventListener('click', () => {
  const parent = fileBrowser.getParentPath();
  if (parent) fileBrowser.load(parent);
});

document.getElementById('file-sidebar-finder').addEventListener('click', () => {
  if (fileBrowser.currentPath) {
    fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath: fileBrowser.currentPath }),
    });
  }
});

// Restore file sidebar state
if (localStorage.getItem('pi-studio-file-sidebar') === 'open') {
  fileSidebar.classList.remove('collapsed');
  fileBrowser.load();
}


// ═══════════════════════════════════════
// Focus tracking for tab title notifications
// ═══════════════════════════════════════

window.addEventListener('focus', () => {
  hasFocus = true;
  unreadCount = 0;
  document.title = originalTitle;
});





window.addEventListener('blur', () => {
  hasFocus = false;
});

// Reconnect WebSocket when returning to the app (iOS suspends WS connections)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wsClient.ws?.readyState !== WebSocket.OPEN) {
    console.log('[App] Returning to app, reconnecting...');
    wsClient.forceReconnect();
  }
});

// ═══════════════════════════════════════
// Scroll-to-bottom button + new message indicator
// ═══════════════════════════════════════

messagesContainer.addEventListener('scroll', () => {
  const threshold = 150;
  const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  isScrolledUp = !atBottom;
  
  if (atBottom) {
    scrollBottomBtn.classList.add('hidden');
    scrollBottomBadge.classList.add('hidden');
    hasNewWhileScrolled = false;
  } else {
    scrollBottomBtn.classList.remove('hidden');
  }
});

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({ top: messagesContainer.scrollHeight, behavior: 'smooth' });
  scrollBottomBtn.classList.add('hidden');
  scrollBottomBadge.classList.add('hidden');
  hasNewWhileScrolled = false;
});

function showNewMessageBadge() {
  if (isScrolledUp) {
    hasNewWhileScrolled = true;
    scrollBottomBadge.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════
// WebSocket event handlers
// ═══════════════════════════════════════

wsClient.addEventListener('connected', () => {
  updateConnectionStatus('connected');
  // Fetch model context window size for token % display
  setTimeout(fetchContextWindow, 1000);

});

wsClient.addEventListener('disconnected', () => {
  updateConnectionStatus('disconnected');
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
    if (wsClient.connectionState !== 'open' && state.isStreaming) {
      state.setStreaming(false);
      showTypingIndicator(false);
      updateUI();
    }
  }, 3000);
});

wsClient.addEventListener('reconnectFailed', () => {
  updateConnectionStatus('disconnected');
  messageRenderer.renderError('Connection lost. Please refresh the page.');
});

wsClient.addEventListener('rpcEvent', (e) => {
  handleRPCEvent(e.detail);
});

wsClient.addEventListener('serverError', (e) => {
  messageRenderer.renderError(e.detail.message);
});

// Mirror mode: receive full state snapshot on connect
wsClient.addEventListener('mirrorSync', (e) => {
  handleMirrorSync(e.detail);
});

// ═══════════════════════════════════════
// RPC event handlers
// ═══════════════════════════════════════

function handleRPCEvent(event) {
  // While the user is previewing a different session, suppress all live
  // rendering so the history view isn't overwritten by streaming output.
  // agent_end still needs to fire so we can complete the deferred switch.
  if (pendingSessionSwitchPath && event.type !== 'agent_end') return;

  switch (event.type) {
    case 'agent_start':
      handleAgentStart();
      break;
    case 'agent_end':
      handleAgentEnd();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      if (pendingNewSessionRefresh) {
        pendingNewSessionRefresh = false;
        sidebar.loadSessions().catch(() => {});
        // Retry after a short delay in case pi hasn't flushed the session file yet
        setTimeout(() => sidebar.loadSessions({ quiet: true }).catch(() => {}), 1000);
        pollInstances().catch(() => {});
      }
      break;
    case 'tool_execution_start':
      handleToolExecutionStart(event);
      break;
    case 'tool_execution_update':
      handleToolExecutionUpdate(event);
      break;
    case 'tool_execution_end':
      handleToolExecutionEnd(event);
      break;
    case 'auto_compaction_start':
      handleCompactionStart();
      break;
    case 'auto_compaction_end':
      handleCompactionEnd(event);
      break;
    case 'extension_ui_request':
      handleExtensionUIRequest(event);
      break;
    case 'extension_error':
      messageRenderer.renderError(`Extension error: ${event.error}`);
      break;
    case 'session_name':
      // Auto-title: update sidebar with new session name
      if (event.name) {
        const activeItem = document.querySelector('.session-item.active .session-title');
        if (activeItem) activeItem.textContent = event.name;
      }
      break;
  }
}

function handleCompactionStart() {
  const el = document.createElement('div');
  el.className = 'system-message compaction-message';
  el.id = 'compaction-indicator';
  el.innerHTML = '<span class="compaction-spinner">⟳</span> Compacting context…';
  messagesContainer.appendChild(el);
  scrollToBottom();
}

function handleCompactionEnd(event) {
  const indicator = document.getElementById('compaction-indicator');
  if (indicator) {
    const summary = event.summary ? ` — ${event.summary}` : '';
    indicator.innerHTML = `✓ Context compacted${summary}`;
    indicator.classList.add('compaction-done');
  }
  // Reset token tracking — next message will update
  lastInputTokens = 0;
  updateTokenUsage();
  hideCompactButton();
}

function getCurrentLiveSessionFile() {
  const port = getCurrentPort();
  const inst = liveInstances.find((i) => i?.port === port);
  return inst?.sessionFile || mirrorActiveSessionFile || null;
}

function handleAgentStart() {
  state.setStreaming(true);
  showTypingIndicator(true);
  updateUI();
  const live = getCurrentLiveSessionFile();
  if (live) sidebar.setStreaming(live, true);
}

function handleAgentEnd() {
  state.setStreaming(false);
  showTypingIndicator(false);
  currentStreamingElement = null;
  currentStreamingText = '';
  updateUI();

  // Deferred session switch: user clicked a history session while streaming.
  // Now that the agent run is done, tell pi to switch — no abort needed.
  if (pendingSessionSwitchPath) {
    const targetPath = pendingSessionSwitchPath;
    pendingSessionSwitchPath = null;
    const live = getCurrentLiveSessionFile();
    if (live) sidebar.setStreaming(live, false);
    window.tauriNative.switchSession(targetPath).catch((e) => {
      messageRenderer.renderError(`Failed to switch session: ${e}`);
    });
    return;
  }

  const live = getCurrentLiveSessionFile();
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

let currentStreamingThinking = '';

// ─── Concurrent session background connections ─────────────────────────────
// When the user switches sessions while one is streaming, we keep a lightweight
// WebSocket listener on the old process port so its streaming events continue
// updating the sidebar (green dot, unread badge) without interrupting the user.

function addBackgroundConnection(port, sessionFile) {
  if (backgroundConnections.has(port)) return;
  const bgWs = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  bgWs.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'event') return;
    const ev = msg.event;
    if (ev.type === 'agent_start') {
      sidebar.setStreaming(sessionFile, true);
    } else if (ev.type === 'agent_end') {
      sidebar.setStreaming(sessionFile, false);
      if (sessionFile !== sidebar.activeSessionFile) sidebar.markUnread(sessionFile);
      removeBackgroundConnection(port);
      sidebar.loadSessions({ quiet: true }).catch(() => {});
    }
  };
  bgWs.onclose = () => backgroundConnections.delete(port);
  backgroundConnections.set(port, { ws: bgWs, sessionFile });
  portSessionMap.set(port, sessionFile);
}

function removeBackgroundConnection(port) {
  const conn = backgroundConnections.get(port);
  if (conn) {
    conn.ws.close();
    backgroundConnections.delete(port);
  }
}

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingThinking = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
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
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

function getAssistantText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text || '')
    .join('\n');
}

function getAssistantThinking(message) {
  if (!Array.isArray(message?.content)) return '';
  return message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking || '')
    .join('\n');
}

function ensureStreamingAssistantElement(message = null) {
  if (currentStreamingElement) return currentStreamingElement;
  currentStreamingText = getAssistantText(message);
  currentStreamingThinking = getAssistantThinking(message);
  currentStreamingElement = messageRenderer.renderAssistantMessage(
    { content: '' },
    true
  );
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
  if (message?.role === 'assistant') {
    ensureStreamingAssistantElement(message);
  }

  if (assistantMessageEvent.type === 'thinking_delta') {
    currentStreamingThinking = getAssistantThinking(message) || (currentStreamingThinking + assistantMessageEvent.delta);
    if (currentStreamingElement) {
      messageRenderer.updateStreamingThinking(currentStreamingElement, currentStreamingThinking);
    }
  } else if (assistantMessageEvent.type === 'text_delta') {
    currentStreamingText = getAssistantText(message) || (currentStreamingText + assistantMessageEvent.delta);
    if (currentStreamingElement) {
      messageRenderer.updateStreamingMessage(
        currentStreamingElement,
        currentStreamingText
      );
    }
  }
}

function handleMessageEnd(message) {
  if (!currentStreamingElement && message?.role === 'assistant') {
    ensureStreamingAssistantElement(message);
  }
  if (currentStreamingElement) {
    // Pass usage info for cost display
    const usage = message?.usage || null;
    // Pass thinking content so finalize can render the thinking block
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, usage, currentStreamingThinking);
    currentStreamingElement = null;
    currentStreamingThinking = '';

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
    status: 'pending',
  });

  toolCardRenderer.createToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionUpdate(event) {
  const { toolCallId, partialResult } = event;
  const output = formatToolOutput(partialResult);

  state.updateToolExecution(toolCallId, {
    status: 'streaming',
    output,
  });

  toolCardRenderer.updateToolCard(state.getToolExecution(toolCallId));
}

function handleToolExecutionEnd(event) {
  const { toolCallId, result, isError } = event;
  const output = formatToolOutput(result);

  state.updateToolExecution(toolCallId, {
    status: isError ? 'error' : 'complete',
    output,
    isError,
  });

  toolCardRenderer.finalizeToolCard(toolCallId, result, isError);
}

function handleExtensionUIRequest(event) {
  switch (event.method) {
    case 'select':
      dialogHandler.showSelect(event);
      break;
    case 'confirm':
      dialogHandler.showConfirm(event);
      break;
    case 'input':
      dialogHandler.showInput(event);
      break;
    case 'editor':
      dialogHandler.showEditor(event);
      break;
    case 'notify':
      dialogHandler.showNotification(event);
      break;
    default:
      console.warn('[App] Unknown extension UI method:', event.method);
  }
}

function formatToolOutput(result) {
  if (!result) return '';

  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        return JSON.stringify(block);
      })
      .join('\n');
  }

  return JSON.stringify(result, null, 2);
}

// ═══════════════════════════════════════
// Input handling — textarea with auto-resize
// ═══════════════════════════════════════

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

messageInput.addEventListener('keydown', (e) => {
  // IME composition uses Enter to confirm candidates; never send during composition.
  const isImeComposing = e.isComposing || e.keyCode === 229;
  if (isImeComposing) return;

  // Enter sends, Shift+Enter inserts newline
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
messageInput.addEventListener('input', () => {
  messageInput.style.height = 'auto';
  messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
});

// ═══════════════════════════════════════
// Image attachment
// ═══════════════════════════════════════

const attachBtn = document.getElementById('attach-btn');
const imageInput = document.getElementById('image-input');
const imagePreviews = document.getElementById('image-previews');
let pendingImages = []; // Array of { data: base64, mimeType: string }

// Max dimension — resize images larger than this to reduce token cost & avoid API limits
const MAX_IMAGE_DIM = 2048;
const VALID_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function processImageFile(file) {
  return new Promise((resolve, reject) => {
    // Validate mime type
    const mimeType = VALID_MIME_TYPES.includes(file.type) ? file.type : 'image/png';

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Resize if too large
        let { width, height } = img;
        if (width > MAX_IMAGE_DIM || height > MAX_IMAGE_DIM) {
          const scale = MAX_IMAGE_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        // Output as PNG for screenshots/diagrams, JPEG for photos
        const outputMime = (mimeType === 'image/jpeg') ? 'image/jpeg' : 'image/png';
        const quality = (outputMime === 'image/jpeg') ? 0.85 : undefined;
        const dataUrl = canvas.toDataURL(outputMime, quality);
        const base64 = dataUrl.split(',')[1];

        if (!base64) {
          reject(new Error('Failed to encode image'));
          return;
        }

        resolve({ data: base64, mimeType: outputMime });
      };
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addImageFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      const img = await processImageFile(file);
      pendingImages.push(img);
    } catch (e) {
      console.error('[Pi Studio] Image processing failed:', e);
    }
  }
  renderImagePreviews();
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  addImageFiles(imageInput.files);
  imageInput.value = '';
});

// Drag & drop on input
messageInput.addEventListener('dragover', (e) => { e.preventDefault(); });
messageInput.addEventListener('drop', (e) => {
  e.preventDefault();
  addImageFiles(e.dataTransfer.files);
});

// Paste images
messageInput.addEventListener('paste', (e) => {
  const files = [];
  for (const item of e.clipboardData.items) {
    if (!item.type.startsWith('image/')) continue;
    files.push(item.getAsFile());
  }
  if (files.length) addImageFiles(files);
});

function renderImagePreviews() {
  imagePreviews.innerHTML = '';
  if (pendingImages.length === 0) {
    imagePreviews.classList.add('hidden');
    return;
  }
  imagePreviews.classList.remove('hidden');
  pendingImages.forEach((img, i) => {
    const el = document.createElement('div');
    el.className = 'image-preview';
    el.innerHTML = `
      <img src="data:${img.mimeType};base64,${img.data}" />
      <button class="image-preview-remove" data-index="${i}">✕</button>
    `;
    el.querySelector('.image-preview-remove').addEventListener('click', () => {
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

function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;

  messageInput.value = '';
  messageInput.style.height = 'auto';

  const cmd = {
    type: 'prompt',
    message,
  };

  if (pendingImages.length > 0) {
    cmd.images = pendingImages.map(img => {
      console.log(`[Pi Studio] Sending image: mimeType=${img.mimeType}, dataLen=${img.data?.length}`);
      return {
        type: 'image',
        data: img.data,
        mimeType: img.mimeType || 'image/png',
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
  wsClient.send(cmd);
}

const queuedMessagesEl = document.getElementById('queued-messages');

function renderQueuedMessages() {
  queuedMessagesEl.innerHTML = '';
  if (messageQueue.length === 0) {
    queuedMessagesEl.classList.add('hidden');
    return;
  }
  queuedMessagesEl.classList.remove('hidden');
  messageQueue.forEach((cmd, i) => {
    const el = document.createElement('div');
    el.className = 'queued-msg';
    el.innerHTML = `
      <span class="queued-msg-label">Queued</span>
      <span class="queued-msg-text">${escapeHtml(cmd.message)}</span>
      <button class="queued-msg-cancel" title="Cancel">×</button>
    `;
    el.querySelector('.queued-msg-cancel').addEventListener('click', () => {
      messageQueue.splice(i, 1);
      renderQueuedMessages();
    });
    queuedMessagesEl.appendChild(el);
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function flushQueue() {
  if (messageQueue.length > 0 && !state.isStreaming) {
    const cmd = messageQueue.shift();
    messageRenderer.renderUserMessage({ content: cmd.message, images: cmd.images });
    renderQueuedMessages();
    wsClient.send(cmd);
  }
}

abortBtn.addEventListener('click', () => {
  abortCurrentRun();
});

// ═══════════════════════════════════════
// Command Palette
// ═══════════════════════════════════════

const commandBtn = document.getElementById('command-btn');
const commandPalette = document.getElementById('command-palette');
const commandPaletteOverlay = document.getElementById('command-palette-overlay');
const commandList = document.getElementById('command-list');

const commands = [
  { icon: '🗜️', label: 'Compact', desc: 'Compact context to save tokens', action: () => rpcCommand({ type: 'compact' }, 'Compacting...') },
  { icon: '📋', label: 'Export HTML', desc: 'Export session as HTML file', action: () => rpcExportHtml() },
  { icon: '📊', label: 'Session Stats', desc: 'Show session statistics', action: () => showSessionStats() },
  { icon: '⬇️', label: 'Expand All Tools', desc: 'Expand all tool cards', action: () => toolCardRenderer.expandAll() },
  { icon: '⬆️', label: 'Collapse All Tools', desc: 'Collapse all tool cards', action: () => toolCardRenderer.collapseAll() },

];

function openCommandPalette() {
  commandList.innerHTML = '';
  commands.forEach(cmd => {
    const el = document.createElement('div');
    el.className = 'command-item';
    el.innerHTML = `
      <div class="command-icon">${cmd.icon}</div>
      <div>
        <div class="command-label">${cmd.label}</div>
        <div class="command-desc">${cmd.desc}</div>
      </div>
    `;
    el.addEventListener('click', () => {
      closeCommandPalette();
      cmd.action();
    });
    commandList.appendChild(el);
  });
  commandPalette.classList.remove('hidden');
  commandPaletteOverlay.classList.remove('hidden');
}

function closeCommandPalette() {
  commandPalette.classList.add('hidden');
  commandPaletteOverlay.classList.add('hidden');
}

commandBtn.addEventListener('click', openCommandPalette);
commandPaletteOverlay.addEventListener('click', closeCommandPalette);

async function rpcCommand(cmd, statusMsg) {
  try {
    if (statusMsg) statusText.textContent = statusMsg;
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await resp.json();
    if (data.success) {
      statusText.textContent = 'Done';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 2000);
    } else {
      statusText.textContent = data.error || 'Failed';
      setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
    }
    return data;
  } catch (e) {
    statusText.textContent = 'Error';
    setTimeout(() => { statusText.textContent = 'Connected'; }, 3000);
  }
}

async function rpcExportHtml() {
  const data = await rpcCommand({ type: 'export_html' }, 'Exporting...');
  if (data?.success && data.data?.path) {
    statusText.textContent = `Exported: ${data.data.path}`;
    setTimeout(() => { statusText.textContent = 'Connected'; }, 4000);
  }
}

async function showSessionStats() {
  const data = await rpcCommand({ type: 'get_session_stats' }, 'Loading stats...');
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
    messageRenderer.renderSystemMessage(lines.join('\n'));
  }
}

// ═══════════════════════════════════════
// Model Picker
// ═══════════════════════════════════════

const modelDropdown = document.getElementById('model-dropdown');
const modelDropdownBtn = document.getElementById('model-dropdown-btn');
const modelDropdownLabel = document.getElementById('model-dropdown-label');
const modelDropdownMenu = document.getElementById('model-dropdown-menu');
const thinkingBtn = document.getElementById('thinking-btn');
function updateThinkingBtn() {
  thinkingBtn.textContent = currentThinkingLevel;
  thinkingBtn.classList.toggle('off', currentThinkingLevel === 'off');
}
let currentModelId = '';
let availableModels = [];
let currentThinkingLevel = 'off';

async function fetchModelInfo() {
  try {
    const [modelsResp, stateResp] = await Promise.all([
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_available_models' }) }),
      fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'get_state' }) }),
    ]);
    const modelsData = await modelsResp.json();
    const stateData = await stateResp.json();

    if (modelsData.success && modelsData.data?.models) {
      availableModels = modelsData.data.models;
    }
    if (stateData.success && stateData.data?.model) {
      currentModelId = stateData.data.model.id || '';
      updateModelLabel();

      const model = availableModels.find(m => m.id === currentModelId);
      if (model?.contextWindow) {
        contextWindowSize = model.contextWindow;
        updateTokenUsage();
      }
    }
    if (stateData.success && stateData.data?.thinkingLevel) {
      currentThinkingLevel = stateData.data.thinkingLevel;
      updateThinkingBtn();
    }
  } catch (e) {
    // ignore
  }
}

function updateModelLabel() {
  const shortName = currentModelId.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  modelDropdownLabel.textContent = shortName || 'model';
}

function toggleModelDropdown() {
  const isOpen = !modelDropdownMenu.classList.contains('hidden');
  if (isOpen) {
    closeModelDropdown();
  } else {
    openModelDropdown();
  }
}

function openModelDropdown() {
  modelDropdownMenu.innerHTML = '';

  // Search input
  const search = document.createElement('input');
  search.className = 'model-dropdown-search';
  search.placeholder = 'Search models…';
  search.type = 'text';
  modelDropdownMenu.appendChild(search);

  // Items container
  const itemsContainer = document.createElement('div');
  itemsContainer.className = 'model-dropdown-items';
  modelDropdownMenu.appendChild(itemsContainer);

  function renderItems(filter) {
    itemsContainer.innerHTML = '';
    const query = (filter || '').toLowerCase();
    // Empty-state: no API keys configured anywhere. Surface this loudly
    // instead of leaving the dropdown blank — empty dropdowns look like
    // a hung load, not a setup problem.
    if (availableModels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'model-dropdown-empty';
      empty.innerHTML = `
        <div style="padding:14px;color:var(--text-dim);font-size:12px;line-height:1.5">
          <div style="font-weight:600;color:var(--text-primary);margin-bottom:6px">No models available</div>
          <div>No API keys configured. Set a key in Settings &rarr; Authentication.</div>
          <button type="button" class="btn-primary" style="margin-top:10px">Open Settings</button>
        </div>`;
      empty.querySelector('button').addEventListener('click', () => {
        closeModelDropdown();
        openSettings().then(() => selectSettingsTab('auth')).catch(() => {});
      });
      itemsContainer.appendChild(empty);
      return;
    }
    availableModels.forEach(m => {
      const shortName = m.id.replace(/-\d{8}$/, '');
      const providerStr = m.provider || '';
      if (query && !shortName.toLowerCase().includes(query) && !providerStr.toLowerCase().includes(query)) return;

      const el = document.createElement('div');
      el.className = `model-dropdown-item${m.id === currentModelId ? ' active' : ''}`;
      const ctxK = m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}k` : '';
      const providerLabel = m.provider && m.provider !== 'anthropic' ? `<span class="model-dropdown-item-provider">${m.provider}</span>` : '';
      el.innerHTML = `<span>${shortName}${providerLabel}</span><span class="model-dropdown-item-ctx">${ctxK}</span>`;
      el.addEventListener('click', async () => {
        closeModelDropdown();
        const display = m.id.replace(/^claude-/, '').replace(/-\d{8}$/, '');
        await rpcCommand({ type: 'set_model', provider: m.provider, modelId: m.id }, `Switching to ${display}...`);
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

  renderItems('');

  search.addEventListener('input', () => renderItems(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModelDropdown(); e.stopPropagation(); }
    if (e.key === 'Enter') {
      const first = itemsContainer.querySelector('.model-dropdown-item');
      if (first) first.click();
    }
  });

  modelDropdownMenu.classList.remove('hidden');
  modelDropdown.classList.add('open');
  requestAnimationFrame(() => search.focus());
}

function closeModelDropdown() {
  modelDropdownMenu.classList.add('hidden');
  modelDropdown.classList.remove('open');
}

modelDropdownBtn.addEventListener('click', toggleModelDropdown);

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!modelDropdown.contains(e.target)) {
    closeModelDropdown();
  }
});

// Thinking level button — cycles through levels
thinkingBtn.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' }, 'Cycling thinking...');
  if (data?.success && data.data?.level) {
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// ═══════════════════════════════════════
// Keyboard shortcuts
// ═══════════════════════════════════════

document.addEventListener('keydown', (e) => {
  // Escape — Abort streaming, or close sidebar on mobile
  if (e.key === 'Escape') {
    // Close palettes/panels first
    if (!settingsPanel.classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (!commandPalette.classList.contains('hidden')) {
      closeCommandPalette();
      return;
    }
    if (!modelDropdownMenu.classList.contains('hidden')) {
      closeModelDropdown();
      return;
    }

    if (state.isStreaming) {
      abortCurrentRun();
    } else if (!sidebarEl.classList.contains('collapsed') && window.innerWidth <= 768) {
      toggleSidebar();
    }
  }

  // / — Focus message input (when not already in an input)
  if (e.key === '/' && !isInInput()) {
    e.preventDefault();
    messageInput.focus();
  }

  // Cmd+N (macOS) / Ctrl+N (Windows/Linux) — Start a new chat session in
  // the current workspace. Mirrors the header "+ New Session" button.
  // We intentionally do NOT gate on isInInput() so the shortcut works
  // even while the user is typing in the composer. Shift/Alt are excluded
  // so we don't shadow Cmd+Shift+N (reserved for future "new window").
  if (
    (e.key === 'n' || e.key === 'N') &&
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey
  ) {
    e.preventDefault();
    newSession().catch((err) => {
      messageRenderer.renderError(`Failed to start new session: ${err}`);
    });
  }
});

function isInInput() {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
}

// ═══════════════════════════════════════
// Sidebar
// ═══════════════════════════════════════

function isMobile() {
  return window.innerWidth <= 768;
}

function updateSidebarToggleIcon() {
  sidebarToggle.textContent = '☰';
}

function toggleSidebar() {
  sidebarEl.classList.toggle('collapsed');
  sidebarOverlay.classList.toggle('visible', !sidebarEl.classList.contains('collapsed') && isMobile());
  updateSidebarToggleIcon();
}

sidebarToggle.addEventListener('click', toggleSidebar);

sidebarOverlay.addEventListener('click', () => {
  sidebarEl.classList.add('collapsed');
  sidebarOverlay.classList.remove('visible');
  updateSidebarToggleIcon();
});



refreshSessionsBtn.addEventListener('click', () => {
  if (isMobile()) {
    location.reload();
    return;
  }
  refreshSessionsBtn.classList.add('spinning');
  sidebar.loadSessions().then(() => {
    setTimeout(() => refreshSessionsBtn.classList.remove('spinning'), 600);
    if (isMirrorMode) updateMirrorLiveIndicator();
  });
});

// Swipe from left edge to open sidebar on mobile
(function initSwipeGesture() {
  let touchStartX = 0;
  let touchStartY = 0;
  let tracking = false;

  document.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Only track swipes starting within 20px of left edge
    if (touch.clientX < 20 && isMobile() && sidebarEl.classList.contains('collapsed')) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      tracking = true;
    }
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);
    // If vertical movement dominates, cancel
    if (dy > dx) {
      tracking = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartX;
    if (dx > 60) {
      sidebarEl.classList.remove('collapsed');
      sidebarOverlay.classList.add('visible');
    }
  }, { passive: true });
})();

// Session search
sessionSearchInput.addEventListener('input', () => {
  sidebar.setSearchQuery(sessionSearchInput.value);
});

/**
 * Reset the chat surface to a fresh "new session" view inside the current window.
 * Clears renderers/state, unmarks the active sidebar item and refreshes the list
 * so the newly created session shows up once pi writes its first message to disk.
 */
async function resetUiForNewSession() {
  state.reset();
  messageRenderer.clear();
  toolCardRenderer.clear();
  renderWorkspaceWelcome();
  sidebar.clearActive();
  mirrorActiveSessionFile = null;
  viewingActiveSession = true;
  updateMirrorInputState();

  // Mark that the next assistant turn should refresh the sidebar, since pi
  // doesn't persist a brand-new session to disk until the first message round-trip.
  pendingNewSessionRefresh = true;

  pollInstances().catch(() => {});
  sidebar.loadSessions().catch(() => {});
}

async function newSession() {
  if (window.tauriNative) {
    // Default behavior is process-efficient: create the new chat in-place on
    // the current pi process. Only spawn a dedicated process when a parallel
    // task is actually running.
    await startInWindowNewSession({
      tauriNative: window.tauriNative,
      getCurrentCwd: getCurrentWorkspacePath,
      getCurrentPort,
      fetchInstances,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      shouldSpawnParallel: () => state.isStreaming,
      onInPlaceSessionCreated: () => {
        resetUiForNewSession().catch(() => {});
      },
      renderError: (message) => messageRenderer.renderError(message),
    });
    return;
  }

  // Browser/dev fallback: classic in-place "new session" against the same
  // pi process (no Tauri windows available in this mode).
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();
  await switchSession(null);
  sidebar.clearActive();

  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
  if (!isMobile()) messageInput.focus();
}

async function handleNewProjectChat(project) {
  if (workspaceLaunchInProgress) return;
  setWorkspaceLaunchInProgress(true);
  try {
    // Prefer reuse: same project + no active parallel run => in-place
    // new_session on current process. Spawn dedicated process only when
    // a parallel run is active.
    const launched = await startNewProjectChat({
      project,
      tauriNative: window.tauriNative,
      getCurrentPort,
      getCurrentCwd: getCurrentWorkspacePath,
      shouldSpawnParallel: () => state.isStreaming,
      onInPlaceSessionCreated: () => {
        resetUiForNewSession().catch(() => {});
      },
      fetchInstances,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      renderError: (message) => messageRenderer.renderError(message),
    });
    if (!launched) return;

    if (isMobile()) {
      sidebarEl.classList.add('collapsed');
      sidebarOverlay.classList.remove('visible');
    }
  } finally {
    setWorkspaceLaunchInProgress(false);
  }
}

async function handleSessionSelect(session, project) {
  sidebar.setActive(session.filePath);
  sessionTotalCost = 0;
  lastInputTokens = 0;
  updateCostDisplay();
  updateTokenUsage();

  // In Tauri: switch session via RPC command to the current pi instance
  if (window.tauriNative && session.filePath) {
    // ── Case 1: Target session is already running on a background process ──
    // Promote it to foreground without spawning anything new.
    const bgEntry = [...backgroundConnections.entries()]
      .find(([, c]) => c.sessionFile === session.filePath);
    if (bgEntry) {
      const [bgPort] = bgEntry;
      // Move current foreground to background if it is still streaming
      if (state.isStreaming) {
        const currentSF = portSessionMap.get(foregroundPort);
        if (currentSF) addBackgroundConnection(foregroundPort, currentSF);
      }
      removeBackgroundConnection(bgPort);
      foregroundPort = bgPort;
      portSessionMap.set(bgPort, session.filePath);
      wsClient.disconnect();
      wsClient.url = `ws://127.0.0.1:${bgPort}/ws`;
      wsClient.forceReconnect();
      clearMessageQueue();
      state.reset();
      // Restore streaming state if A's task is still running in the background.
      // state.reset() clears isStreaming, but pi won't re-emit agent_start for
      // an in-progress run, so we have to recover the flag from sidebar state.
      if (sidebar.isStreaming(session.filePath)) {
        state.setStreaming(true);
        showTypingIndicator(true);
      }
      updateUI();
      messageRenderer.clear();
      toolCardRenderer.clear();
      if (session && project) {
        messageRenderer.renderSystemMessage('Loading session…');
        const dirName = project?.dirName;
        const file = session.file;
        if (dirName && file) {
          try {
            const res = await fetch(`/api/sessions/${dirName}/${file}`);
            const data = await res.json();
            messageRenderer.clear();
            renderSessionHistory(data.entries || []);
          } catch (e) {
            messageRenderer.renderError(`Failed to load session: ${e}`);
          }
        }
      }
      if (isMobile()) {
        sidebarEl.classList.add('collapsed');
        sidebarOverlay.classList.remove('visible');
      }
      return;
    }

    // ── Case 2: Currently streaming — try concurrent spawn ──
    if (state.isStreaming) {
      if (window.tauriNative.spawnSessionProcess) {
        let targetPort = null;
        try {
          const cwd = getCurrentWorkspacePath();
          targetPort = await window.tauriNative.spawnSessionProcess(session.filePath, cwd);
        } catch (e) {
          console.error('[App] Failed to spawn session process, falling back to deferred switch:', e);
        }
        if (targetPort != null) {
          // Move current foreground session to a background connection
          const currentSF = portSessionMap.get(foregroundPort);
          if (currentSF) addBackgroundConnection(foregroundPort, currentSF);
          // Switch foreground to new dedicated process
          foregroundPort = targetPort;
          portSessionMap.set(targetPort, session.filePath);
          wsClient.disconnect();
          wsClient.url = `ws://127.0.0.1:${targetPort}/ws`;
          wsClient.forceReconnect();
          clearMessageQueue();
          state.reset();
          updateUI();
          messageRenderer.clear();
          toolCardRenderer.clear();
          if (session && project) {
            messageRenderer.renderSystemMessage('Loading session…');
            const dirName = project?.dirName;
            const file = session.file;
            if (dirName && file) {
              try {
                const res = await fetch(`/api/sessions/${dirName}/${file}`);
                const data = await res.json();
                messageRenderer.clear();
                renderSessionHistory(data.entries || []);
              } catch (e) {
                messageRenderer.renderError(`Failed to load session: ${e}`);
              }
            }
          }
          if (isMobile()) {
            sidebarEl.classList.add('collapsed');
            sidebarOverlay.classList.remove('visible');
          }
          return;
        }
      }
      // Fallback: defer the switch until the current agent run ends.
      // This preserves the old safe behavior when spawn is unavailable or fails.
      pendingSessionSwitchPath = session.filePath;
      updateUI();
      messageRenderer.clear();
      toolCardRenderer.clear();
      if (session && project) {
        messageRenderer.renderSystemMessage('Loading session…');
        const dirName = project?.dirName;
        const file = session.file;
        if (dirName && file) {
          try {
            const res = await fetch(`/api/sessions/${dirName}/${file}`);
            const data = await res.json();
            messageRenderer.clear();
            renderSessionHistory(data.entries || []);
          } catch (e) {
            messageRenderer.renderError(`Failed to load session: ${e}`);
          }
        }
      }
      if (isMobile()) {
        sidebarEl.classList.add('collapsed');
        sidebarOverlay.classList.remove('visible');
      }
      return;
    }

    // ── Case 3: Not streaming — normal session switch ──
    // Pre-load the target session's UI so the frontend doesn't wait on pi to
    // send a session_switch event (which carries no payload and was a no-op).
    state.reset();
    updateUI();
    messageRenderer.clear();
    toolCardRenderer.clear();
    if (session && project) {
      messageRenderer.renderSystemMessage('Loading session…');
      const dirName = project?.dirName;
      const file = session.file;
      if (dirName && file) {
        try {
          const res = await fetch(`/api/sessions/${dirName}/${file}`);
          const data = await res.json();
          messageRenderer.clear();
          renderSessionHistory(data.entries || []);
        } catch (e) {
          messageRenderer.renderError(`Failed to load session: ${e}`);
        }
      }
    }
    try {
      await window.tauriNative.switchSession(session.filePath);
    } catch (e) {
      messageRenderer.renderError(`Failed to switch session: ${e}`);
    }
    if (isMobile()) {
      sidebarEl.classList.add('collapsed');
      sidebarOverlay.classList.remove('visible');
    }
    return;
  }

  await switchSession(session.filePath, session, project);

  // Close sidebar on mobile after selecting
  if (isMobile()) {
    sidebarEl.classList.add('collapsed');
    sidebarOverlay.classList.remove('visible');
  }
}

async function switchSession(sessionFile, session = null, project = null) {
  try {
    state.reset();
    messageRenderer.clear();
    toolCardRenderer.clear();

    if (sessionFile && session) {
      messageRenderer.renderSystemMessage('Loading session...');

      const dirName = project?.dirName;
      const file = session.file;
      console.log('[App] Loading history:', { dirName, file, sessionFile });

      if (dirName && file) {
        try {
          const res = await fetch(`/api/sessions/${dirName}/${file}`);
          console.log('[App] History fetch status:', res.status);
          const data = await res.json();
          console.log('[App] History entries:', data.entries?.length || 0);

          messageRenderer.clear();
          renderSessionHistory(data.entries || []);
        } catch (e) {
          console.error('[App] History fetch error:', e);
        }
      } else {
        console.log('[App] Skipped history load: dirName or file missing');
      }
    } else {
      renderWorkspaceWelcome();
    }

    // In mirror mode, check if this session is live on any instance
    if (isMirrorMode) {
      // Check if this session is live on a different instance
      const otherInstance = liveInstances.find(i => i.sessionFile === sessionFile && i.port !== new URL(wsClient.url).port * 1);
      if (otherInstance) {
        // Reconnect to the other instance
        const newUrl = `ws://${location.hostname}:${otherInstance.port}/ws`;
        console.log(`[App] Switching to instance on port ${otherInstance.port}`);
        wsClient.disconnect();
        wsClient.url = newUrl;
        wsClient.forceReconnect();
        mirrorActiveSessionFile = sessionFile;
        viewingActiveSession = true;
        updateMirrorInputState();
        return;
      }

      // Check if this is the active session on the current instance
      viewingActiveSession = sessionFile === mirrorActiveSessionFile;
      updateMirrorInputState();

      if (viewingActiveSession) {
        // Re-request live state from the extension
        wsClient.send({ type: 'mirror_sync_request' });
      }
    } else {
      const res = await fetch('/api/sessions/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionFile }),
      });

      if (!res.ok) {
        const err = await res.json();
        messageRenderer.renderError(`Failed to switch session: ${err.error}`);
      }
    }
  } catch (error) {
    console.error('[App] Failed to switch session:', error);
    messageRenderer.renderError('Failed to switch session');
  }
}

// ═══════════════════════════════════════
// Mirror mode sync
// ═══════════════════════════════════════

function handleMirrorSync(data) {
  if (!sessionsLoaded) {
    deferredMirrorSync = data;
    return;
  }

  console.log('[Mirror] Received state snapshot:', data.entries?.length, 'entries');
  isMirrorMode = true;

  // Track the active session
  mirrorActiveSessionFile = data.sessionFile || null;
  if (data.sessionFile) portSessionMap.set(foregroundPort, data.sessionFile);
  wsClient.setRoutingContext({
    workspaceId: data.workspaceId || `workspace:${getCurrentWorkspacePath() || 'unknown'}`,
    sessionId: data.sessionId || data.sessionFile || null,
  });
  viewingActiveSession = true;
  state.setStreaming(Boolean(data.isStreaming));
  showTypingIndicator(Boolean(data.isStreaming));
  updateMirrorInputState();
  updateMirrorLiveIndicator();
  updateUI();

  // Update model display
  if (data.model) {
    currentModelId = data.model.id || '';
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
    renderSessionHistory(data.entries);
  } else {
    renderWorkspaceWelcome();
  }

  updateCostDisplay();
  updateTokenUsage();
}

// Mark sessions in the sidebar with a green dot only when actively streaming
function updateMirrorLiveIndicator() {
  document.querySelectorAll('.session-item').forEach(el => {
    el.classList.toggle('mirror-live', sidebar.streamingFiles.has(el.dataset.filePath));
  });
}

// Poll for running instances to mark all live sessions
async function pollInstances() {
  try {
    const res = await fetch('/api/instances');
    if (res.ok) {
      const data = await res.json();
      liveInstances = data.instances || [];
      updateMirrorLiveIndicator();
      syncWorkspaceIndicatorFromInstances();
      if (document.querySelector('.welcome')) {
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

  const inputArea = document.querySelector('.input-area');
  if (viewingActiveSession) {
    messageInput.disabled = false;
    messageInput.placeholder = 'Message...';
    inputArea?.classList.remove('mirror-readonly');
  } else {
    messageInput.disabled = true;
    messageInput.placeholder = 'Viewing historical session (read-only)';
    inputArea?.classList.add('mirror-readonly');
  }
}

// ═══════════════════════════════════════
// Session history rendering
// ═══════════════════════════════════════

function renderSessionHistory(entries) {
  console.log(`[History] Rendering ${entries.length} entries`);
  let userCount = 0, assistantCount = 0, toolCardCount = 0, toolResultCount = 0;

  for (const entry of entries) {
    if (entry.type !== 'message') continue;

    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === 'image')
            .map((b) => ({ data: b.source?.data || b.data || '', mimeType: b.source?.media_type || b.media_type || 'image/png' }))
        : [];
      if (content || images.length > 0) {
        userCount++;
        messageRenderer.renderUserMessage({ content: content || '', images: images.length > 0 ? images : undefined }, true);
      }
    } else if (msg.role === 'assistant') {
      const textBlocks = (msg.content || []).filter((b) => b.type === 'text');
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === 'thinking');
      const toolCalls = (msg.content || []).filter((b) => b.type === 'toolCall');

      // Build content blocks for rendering
      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === 'text' || block.type === 'thinking') {
          contentBlocks.push(block);
        }
      }

      const text = textBlocks.map((b) => b.text).join('\n');

      if (text || thinkingBlocks.length > 0) {
        assistantCount++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true
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
        console.log(`[History] Tool card created: ${tc.name}`, card?.offsetHeight, card?.innerHTML?.substring(0, 100));
      }
    } else if (msg.role === 'toolResult') {
      toolResultCount++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError
      );
    }
  }

  console.log(`[History] Done: ${userCount} users, ${assistantCount} assistants, ${toolCardCount} tools, ${toolResultCount} results`);
  console.log(`[History] DOM tool-card count:`, document.querySelectorAll('.tool-card').length);
  console.log(`[History] DOM thinking-block count:`, document.querySelectorAll('.thinking-block').length);

  updateCostDisplay();
  updateTokenUsage();
  fetchContextWindow();

  // Jump to bottom instantly (no smooth scroll animation)
  const messagesEl = document.getElementById('messages');
  messagesEl.style.scrollBehavior = 'auto';
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Restore smooth scrolling after a frame
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = '';
    });
  });
}

// ═══════════════════════════════════════
// UI helpers
// ═══════════════════════════════════════

function showTypingIndicator(show) {
  typingIndicator.classList.toggle('hidden', !show);
}

function abortCurrentRun() {
  wsClient.send({ type: 'abort' });
  messageRenderer.renderError('Aborted by user');
  showTypingIndicator(false);

  // In some abort paths, backend agent_end can be delayed or missing.
  // Optimistically unlock input so users can continue immediately.
  if (state.isStreaming) {
    state.setStreaming(false);
    currentStreamingElement = null;
    currentStreamingText = '';
    currentStreamingThinking = '';
    updateUI();
  }
}

function updateCostDisplay() {
  if (sessionTotalCost > 0) {
    sessionCostEl.textContent = `$${sessionTotalCost.toFixed(4)} (sub)`;
    sessionCostEl.classList.add('visible');
  } else {
    sessionCostEl.classList.remove('visible');
  }
}

function updateTokenUsage() {
  if (lastInputTokens > 0 && contextWindowSize > 0) {
    const pct = Math.round((lastInputTokens / contextWindowSize) * 100);
    tokenUsageEl.textContent = `${pct}%`;
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
    if (pct >= 80) {
      tokenUsageEl.classList.add('critical');
    } else if (pct >= 60) {
      tokenUsageEl.classList.add('warning');
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
    tokenUsageEl.classList.add('visible');
    tokenUsageEl.classList.remove('warning', 'critical');
  }
}

function showCompactButton() {
  if (document.getElementById('compact-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'compact-btn';
  btn.className = 'compact-btn';
  btn.textContent = 'Compact';
  btn.title = 'Context is over 80% — compact to save tokens';
  btn.addEventListener('click', () => {
    rpcCommand({ type: 'compact' }, 'Compacting...');
    hideCompactButton();
  });
  // Insert next to token usage in header
  tokenUsageEl.parentElement.insertBefore(btn, tokenUsageEl.nextSibling);
}

function hideCompactButton() {
  const btn = document.getElementById('compact-btn');
  if (btn) btn.remove();
}

async function fetchContextWindow() {
  // Delegate to fetchModelInfo which also updates the model button
  await fetchModelInfo();
}

let tailscaleUrl = '';

function updateConnectionStatus(status) {
  statusIndicator.className = `status-indicator ${status}`;

  if (status === 'connected') {
    statusText.textContent = tailscaleUrl ? 'Connected • TS' : 'Connected';
    statusText.title = tailscaleUrl || '';
    // Fetch tailscale info on first connect
    if (!tailscaleUrl) {
      fetch('/api/health').then(r => r.json()).then(data => {
        if (data.tailscaleUrl) {
          tailscaleUrl = data.tailscaleUrl;
          statusText.textContent = 'Connected • TS';
          statusText.title = tailscaleUrl;
        }
      }).catch(() => {});
    }
  } else if (status === 'disconnected') {
    statusText.textContent = 'Disconnected';
  }
}

function updateUI() {
  const isStreaming = state.isStreaming;

  if (isStreaming) {
    statusIndicator.classList.add('streaming');
    statusIndicator.classList.remove('connected');
    statusText.textContent = 'Working...';
  } else {
    statusIndicator.classList.remove('streaming');
    statusIndicator.classList.add('connected');
    statusText.textContent = 'Connected';
  }

  messageInput.disabled = false;
  sendBtn.disabled = false;

  if (isStreaming) {
    abortBtn.classList.remove('hidden');
    sendBtn.classList.add('hidden');
  } else {
    abortBtn.classList.add('hidden');
    sendBtn.classList.remove('hidden');
    flushQueue();
  }

  // Viewing a history session while original is still streaming —
  // block input until agent_end triggers the deferred switch_session.
  if (pendingSessionSwitchPath) {
    messageInput.disabled = true;
    sendBtn.disabled = true;
    abortBtn.classList.add('hidden');
    messageInput.placeholder = 'Waiting for current session to finish…';
  } else {
    messageInput.placeholder = 'Type a message... (Enter to send, Shift+Enter for newline)';
  }
}

// ═══════════════════════════════════════
// WebSocket session switch handler
// ═══════════════════════════════════════

wsClient.addEventListener('sessionSwitch', () => {
  console.log('[App] Session switched');
});

// ═══════════════════════════════════════
// Theme / Settings
// ═══════════════════════════════════════



const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');
const settingsNavItems = Array.from(document.querySelectorAll('.settings-nav-item'));
const settingsTabs = Array.from(document.querySelectorAll('.settings-tab'));
const themeGrid = document.getElementById('theme-grid');


const toggleAutoCompact = document.getElementById('toggle-auto-compact');
const btnThinkingLevel = document.getElementById('btn-thinking-level');
const toggleShowThinking = document.getElementById('toggle-show-thinking');
const piVersionValue = document.getElementById('setting-pi-version-value');
let piVersionCache = null;
let piVersionInflight = null;

function selectSettingsTab(tabKey = 'general') {
  settingsNavItems.forEach((item) => {
    item.classList.toggle('active', item.dataset.settingsTab === tabKey);
  });
  settingsTabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.settingsPanel === tabKey);
  });
  if (tabKey === 'configuration') {
    loadInlineConfigEditor();
    loadInlineModelsEditor();
  }
  if (tabKey === 'auth') {
    loadApiKeysPanel();
  }
}

function formatPiVersionError(err, fallback = 'unknown error') {
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
      if (window.tauriNative?.getPiVersion) {
        const version = await window.tauriNative.getPiVersion();
        if (version) {
          piVersionCache = version;
          piVersionValue.textContent = piVersionCache;
        } else {
          piVersionValue.textContent = 'Unavailable (empty version)';
        }
      } else {
        const data = await rpcCommand({ type: 'get_pi_version' });
        if (data?.success && data.data?.version) {
          piVersionCache = data.data.version;
          piVersionValue.textContent = piVersionCache;
        } else {
          const reason = formatPiVersionError(data?.error, 'version missing in response');
          console.error('[settings] failed to load pi version:', data);
          piVersionValue.textContent = `Unavailable (${reason})`;
        }
      }
    } catch (err) {
      const reason = formatPiVersionError(err);
      console.error('[settings] failed to load pi version:', err);
      piVersionValue.textContent = `Unavailable (${reason})`;
    } finally {
      piVersionInflight = null;
    }
  })();
}


// ═══════════════════════════════════════
// Auto-updater (Tauri-only)
// ═══════════════════════════════════════

const appVersionValue = document.getElementById('setting-app-version-value');
const updaterSection = document.getElementById('setting-updater-section');
const checkUpdatesBtn = document.getElementById('btn-check-updates');
const updateStatusRow = document.getElementById('setting-update-status-row');
const updateStatusEl = document.getElementById('setting-update-status');
const updateInstallRow = document.getElementById('setting-update-install-row');
const updateInstallLabel = document.getElementById('setting-update-install-label');
const installUpdateBtn = document.getElementById('btn-install-update');

const APP_VERSION = (() => {
  const meta = document.querySelector('meta[name="app-version"]');
  return meta?.content?.trim() || null;
})();

let pendingUpdate = null;
let updaterBusy = false;
const BETA_VERSION_RE = /-beta(?:[.-]|$)/i;
const NUMERIC_PRERELEASE_VERSION_RE = /-\d+(?:\.\d+)*$/;
let currentAppVersion = APP_VERSION;

function setUpdateStatus(message, tone = 'info') {
  if (!updateStatusRow || !updateStatusEl) return;
  if (!message) {
    updateStatusRow.hidden = true;
    updateStatusEl.textContent = '';
    updateStatusEl.dataset.tone = '';
    return;
  }
  updateStatusRow.hidden = false;
  updateStatusEl.textContent = message;
  updateStatusEl.dataset.tone = tone;
}

function showInstallButton(update) {
  if (!updateInstallRow || !updateInstallLabel || !installUpdateBtn) return;
  if (!update) {
    updateInstallRow.hidden = true;
    return;
  }
  updateInstallRow.hidden = false;
  const from = update.currentVersion ? ` (from ${update.currentVersion})` : '';
  updateInstallLabel.textContent = `Pi Studio ${update.version}${from}`;
  installUpdateBtn.disabled = false;
  installUpdateBtn.textContent = 'Download & install';
}

function isIgnoredPrereleaseVersion(version) {
  return BETA_VERSION_RE.test(String(version || '').trim());
}

function isLocalPrereleaseBuild(version) {
  return NUMERIC_PRERELEASE_VERSION_RE.test(String(version || '').trim());
}

async function loadAppVersion() {
  if (!appVersionValue) return;

  if (APP_VERSION) {
    appVersionValue.textContent = APP_VERSION;
    currentAppVersion = APP_VERSION;
    return APP_VERSION;
  }

  try {
    if (window.tauriNative?.getAppVersion) {
      const v = await window.tauriNative.getAppVersion();
      if (v) {
        appVersionValue.textContent = v;
        currentAppVersion = v;
        return v;
      }
    }
    const tauriApp = window.__TAURI__?.app;
    if (tauriApp?.getVersion) {
      const v = await tauriApp.getVersion();
      appVersionValue.textContent = v || 'unknown';
      currentAppVersion = v || 'unknown';
      return currentAppVersion;
    }
  } catch (err) {
    console.warn('[updater] unable to read app version:', err);
  }
  appVersionValue.textContent = 'unknown';
  currentAppVersion = 'unknown';
  return currentAppVersion;
}

// Pattern-match the most common Tauri updater errors so we can show a
// useful explanation instead of the raw "Could not fetch a valid release
// JSON from the remote" string. The plugin throws this for *any* of:
//   - endpoint returned 404 (no `latest.json` attached to the release yet)
//   - endpoint returned a manifest without an entry for our platform/arch
//   - `pubkey` is empty, so the signature couldn't even be parsed
// All three are common during initial setup, so we explain them inline
// rather than just dumping the error.
function explainUpdateError(rawMessage) {
  const msg = String(rawMessage || '');
  if (/Could not fetch a valid release JSON/i.test(msg)) {
    return (
      'No update manifest published yet. Either the latest GitHub release ' +
      "doesn't include `latest.json`, or it has no entry for this platform. " +
      'See docs/AUTO_UPDATER.md.'
    );
  }
  if (/pubkey|public key|signature/i.test(msg)) {
    return 'Updater public key is missing or the bundle signature is invalid. See docs/AUTO_UPDATER.md.';
  }
  return msg || 'Unknown updater error';
}

async function checkForUpdates({ silent = false } = {}) {
  if (updaterBusy) return null;

  if (isLocalPrereleaseBuild(currentAppVersion)) {
    if (!silent) {
      setUpdateStatus(
        `Pre-release build (${currentAppVersion}) — auto-update is disabled for this build.`,
        'info',
      );
    }
    pendingUpdate = null;
    showInstallButton(null);
    return null;
  }

  if (!window.tauriNative?.hasUpdater) {
    if (!silent) setUpdateStatus('Auto-updates are only available in the desktop app.', 'warn');
    if (updaterSection && !window.tauriNative) updaterSection.hidden = true;
    return null;
  }

  updaterBusy = true;
  if (checkUpdatesBtn) {
    checkUpdatesBtn.disabled = true;
    checkUpdatesBtn.textContent = 'Checking...';
  }
  if (!silent) setUpdateStatus('Checking for updates...', 'info');

  try {
    const update = await window.tauriNative.checkForUpdate();
    if (!update) {
      pendingUpdate = null;
      showInstallButton(null);
      setUpdateStatus("You're on the latest version.", 'ok');
      return null;
    }

    if (isIgnoredPrereleaseVersion(update.version)) {
      console.info('[updater] ignoring beta release:', update.version);
      pendingUpdate = null;
      showInstallButton(null);
      setUpdateStatus("You're on the latest stable version.", 'ok');
      return null;
    }

    pendingUpdate = update;
    showInstallButton(update);
    setUpdateStatus(`Update available: ${update.version}`, 'ok');
    return update;
  } catch (err) {
    const friendly = explainUpdateError(err?.message || err);
    console.warn('[updater] check failed:', err);
    if (!silent) {
      setUpdateStatus(friendly, 'warn');
    }
    return null;
  } finally {
    updaterBusy = false;
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = false;
      checkUpdatesBtn.textContent = 'Check now';
    }
  }
}

async function installPendingUpdate() {
  if (updaterBusy || !pendingUpdate) return;
  if (!window.tauriNative?.downloadAndInstallUpdate) return;

  updaterBusy = true;
  if (installUpdateBtn) {
    installUpdateBtn.disabled = true;
    installUpdateBtn.textContent = 'Downloading...';
  }
  if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;

  try {
    await window.tauriNative.downloadAndInstallUpdate((evt) => {
      if (evt.phase === 'started') {
        setUpdateStatus(
          evt.contentLength ? `Downloading ${(evt.contentLength / 1_048_576).toFixed(1)} MB...` : 'Downloading...',
          'info',
        );
      } else if (evt.phase === 'progress' && evt.contentLength) {
        const pct = Math.min(100, Math.round((evt.downloaded / evt.contentLength) * 100));
        if (installUpdateBtn) installUpdateBtn.textContent = `Downloading ${pct}%`;
      } else if (evt.phase === 'finished') {
        if (installUpdateBtn) installUpdateBtn.textContent = 'Installing...';
        setUpdateStatus('Installing...', 'info');
      }
    });

    setUpdateStatus('Update installed. Restarting...', 'ok');
    setTimeout(() => {
      window.tauriNative?.relaunchApp?.().catch((err) => {
        console.error('[updater] relaunch failed:', err);
        setUpdateStatus('Please restart Pi Studio to finish updating.', 'warn');
      });
    }, 600);
  } catch (err) {
    const msg = String(err?.message || err || 'unknown error');
    console.error('[updater] install failed:', err);
    setUpdateStatus(`Update failed: ${msg}`, 'error');
    if (installUpdateBtn) {
      installUpdateBtn.disabled = false;
      installUpdateBtn.textContent = 'Retry';
    }
  } finally {
    updaterBusy = false;
    if (checkUpdatesBtn) checkUpdatesBtn.disabled = false;
  }
}

let _isDevBuildCache = null;
async function isDevBuild() {
  if (_isDevBuildCache !== null) return _isDevBuildCache;
  try {
    _isDevBuildCache = !!(await window.tauriNative?.isDev?.());
  } catch {
    _isDevBuildCache = false;
  }
  return _isDevBuildCache;
}

async function initUpdaterUI() {
  if (!updaterSection) return;

  if (!window.tauriNative?.hasUpdater) {
    updaterSection.hidden = true;
    return;
  }

  const appVersion = await loadAppVersion();

  if (await isDevBuild()) {
    setUpdateStatus('Dev build — updates are checked only in packaged releases.', 'info');
    if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
    return;
  }

  if (isLocalPrereleaseBuild(appVersion)) {
    setUpdateStatus(`Pre-release build (${appVersion}) — auto-update is disabled for this build.`, 'info');
    if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
    if (installUpdateBtn) installUpdateBtn.disabled = true;
    showInstallButton(null);
    return;
  }

  checkUpdatesBtn?.addEventListener('click', () => {
    checkForUpdates({ silent: false });
  });
  installUpdateBtn?.addEventListener('click', () => {
    installPendingUpdate();
  });

  // Background check on startup (silent — only surfaces a status row if an
  // update is available or the user opens settings to retry).
  setTimeout(() => {
    checkForUpdates({ silent: true }).catch(() => {});
  }, 5_000);

  // Periodic check every 6 hours while the app is running.
  setInterval(() => {
    if (document.visibilityState === 'visible') {
      checkForUpdates({ silent: true }).catch(() => {});
    }
  }, 6 * 60 * 60 * 1000);
}

void initUpdaterUI();

function buildThemeGrid() {
  themeGrid.innerHTML = '';
  const current = getCurrentTheme();

  for (const [id, theme] of Object.entries(themes)) {
    const btn = document.createElement('button');
    btn.className = `theme-swatch${current === id ? ' active' : ''}`;
    const dots = (theme.colors || []).map(c => 
      `<span class="swatch-dot" style="background:${c}"></span>`
    ).join('');
    btn.innerHTML = `<span class="swatch-colors">${dots}</span>`;
    btn.addEventListener('click', () => {
      applyTheme(id);
      themeGrid.querySelectorAll('.theme-swatch').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
    });
    themeGrid.appendChild(btn);
  }
}

async function openSettings() {
  settingsPanel.classList.remove('hidden');
  messagesContainer.style.display = 'none';
  document.querySelector('.input-area').style.display = 'none';
  document.querySelector('.mode-link:first-child')?.classList.remove('active');
  selectSettingsTab('general');
  buildThemeGrid();
  if (piVersionValue) {
    piVersionValue.textContent = piVersionCache || 'Loading...';
  }
  setTimeout(() => {
    if (!settingsPanel.classList.contains('hidden')) loadPiVersion();
  }, 300);

  // Fetch current state for toggles
  try {
    const resp = await fetch('/api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'get_state' }),
    });
    const data = await resp.json();
    if (data.success && data.data) {
      const s = data.data;
      // Auto-compaction toggle
      toggleAutoCompact.className = `settings-toggle${s.autoCompactionEnabled ? ' on' : ''}`;
      // Thinking level
      btnThinkingLevel.textContent = s.thinkingLevel || 'off';
      currentThinkingLevel = s.thinkingLevel || 'off';
      updateThinkingBtn();
      // Session name
      inputSessionName.value = s.sessionName || '';
    }
  } catch (e) {
    // Silent
  }

  // Fetch auth state
  try {
    const authData = await rpcCommand({ type: 'get_auth' });
    if (authData?.success && authData.data?.configured) {
      authSection.style.display = '';
      toggleAuth.className = `settings-toggle${authData.data.enabled ? ' on' : ''}`;
    } else {
      authSection.style.display = 'none';
    }
  } catch {
    authSection.style.display = 'none';
  }
}

function closeSettings() {
  settingsPanel.classList.add('hidden');
  messagesContainer.style.display = '';
  document.querySelector('.input-area').style.display = '';
  document.querySelector('.mode-link:first-child')?.classList.add('active');
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsOverlay?.addEventListener('click', closeSettings);
settingsNavItems.forEach((item) => {
  item.addEventListener('click', () => {
    selectSettingsTab(item.dataset.settingsTab || 'general');
  });
});

// Auto-compaction toggle
toggleAutoCompact.addEventListener('click', async () => {
  const isOn = toggleAutoCompact.classList.contains('on');
  toggleAutoCompact.className = `settings-toggle${isOn ? '' : ' on'}`;
  await rpcCommand({ type: 'set_auto_compaction', enabled: !isOn });
});

// Thinking level cycle (settings panel button)
btnThinkingLevel.addEventListener('click', async () => {
  const data = await rpcCommand({ type: 'cycle_thinking_level' });
  if (data?.success && data.data?.level) {
    btnThinkingLevel.textContent = data.data.level;
    currentThinkingLevel = data.data.level;
    updateThinkingBtn();
  }
});

// Show thinking toggle (local pref)
const showThinking = localStorage.getItem('pi-studio-show-thinking') !== 'false';
toggleShowThinking.className = `settings-toggle${showThinking ? ' on' : ''}`;
if (!showThinking) document.body.classList.add('hide-thinking');

toggleShowThinking.addEventListener('click', () => {
  const isOn = toggleShowThinking.classList.contains('on');
  toggleShowThinking.className = `settings-toggle${isOn ? '' : ' on'}`;
  document.body.classList.toggle('hide-thinking', isOn);
  localStorage.setItem('pi-studio-show-thinking', !isOn);
});

// Auth toggle
const toggleAuth = document.getElementById('toggle-auth');
const authSection = document.getElementById('settings-auth-section');

toggleAuth.addEventListener('click', async () => {
  const isOn = toggleAuth.classList.contains('on');
  const data = await rpcCommand({ type: 'set_auth', enabled: !isOn });
  if (data?.success) {
    toggleAuth.className = `settings-toggle${!isOn ? ' on' : ''}`;
  }
});

// ═══════════════════════════════════════
// API Keys (Settings > Authentication)
// ═══════════════════════════════════════
//
// Writes ~/.pi/agent/auth.json via the embedded server's set_api_key /
// remove_api_key RPCs. Replaces the removed login-shell env-harvest path
// (see commit 8b1f5e4): GUI-launched Pi Studio does not inherit ANTHROPIC_API_KEY
// etc. from ~/.zshrc, so the dropdown was empty for users who only had keys
// in their shell. This panel gives them a one-time setup that sticks.
const apiKeysContainer = document.getElementById('settings-api-keys');

async function loadApiKeysPanel() {
  if (!apiKeysContainer) return;
  apiKeysContainer.innerHTML = '<div class="settings-api-keys-loading">Loading providers…</div>';
  const data = await rpcCommand({ type: 'list_auth_status' });
  if (!data?.success || !Array.isArray(data.data?.providers)) {
    // Surface the actual backend error (e.g. "Model registry not ready yet")
    // instead of a generic message, and offer a Retry. The most common cause
    // is opening the panel before pi's first session_start has populated the
    // shared ModelRegistry — a single retry usually succeeds.
    renderApiKeysPanelError(data?.error || 'Failed to load providers.');
    return;
  }
  renderApiKeysPanel(data.data.providers);
  // Refresh the model dropdown so a freshly-set key immediately shows up.
  fetchModelInfo();
}

function renderApiKeysPanelError(message) {
  apiKeysContainer.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'settings-api-keys-empty';
  const msg = document.createElement('div');
  msg.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Retry';
  retry.style.marginTop = '8px';
  retry.addEventListener('click', () => loadApiKeysPanel());
  wrap.appendChild(msg);
  wrap.appendChild(retry);
  apiKeysContainer.appendChild(wrap);
}

function renderApiKeysPanel(providers) {
  apiKeysContainer.innerHTML = '';
  if (providers.length === 0) {
    apiKeysContainer.innerHTML = '<div class="settings-api-keys-empty">No providers known.</div>';
    return;
  }
  for (const p of providers) {
    apiKeysContainer.appendChild(buildApiKeyRow(p));
  }
}

function buildApiKeyRow(p) {
  const row = document.createElement('div');
  row.className = 'api-key-row';
  row.dataset.provider = p.provider;

  const info = document.createElement('div');
  info.className = 'api-key-row-info';
  const name = document.createElement('div');
  name.className = 'api-key-row-name';
  name.textContent = p.displayName || p.provider;
  const status = document.createElement('div');
  status.className = `api-key-row-status${p.configured ? ' configured' : ''}`;
  status.textContent = describeAuthStatus(p);
  info.appendChild(name);
  info.appendChild(status);

  const actions = document.createElement('div');
  actions.className = 'api-key-row-actions';
  const setBtn = document.createElement('button');
  setBtn.type = 'button';
  setBtn.textContent = p.configured ? 'Update' : 'Set key';
  setBtn.addEventListener('click', () => openApiKeyEditor(row, p));
  actions.appendChild(setBtn);
  if (p.configured && p.source === 'stored') {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'danger';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeApiKey(p));
    actions.appendChild(removeBtn);
  }

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

function describeAuthStatus(p) {
  if (!p.configured) {
    return 'Not configured';
  }
  switch (p.source) {
    case 'stored': return 'Configured (auth.json)';
    case 'environment': return `From environment (${p.label || 'env var'})`;
    case 'runtime': return 'Runtime override';
    case 'fallback': return 'Custom provider';
    default: return 'Configured';
  }
}

function openApiKeyEditor(row, p) {
  // Replace the row with an inline editor; cancel restores the row.
  const editor = document.createElement('div');
  editor.className = 'api-key-editor';

  const title = document.createElement('div');
  title.className = 'api-key-row-name';
  title.textContent = `${p.displayName || p.provider} API key`;
  editor.appendChild(title);

  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Paste API key…';
  editor.appendChild(input);

  const err = document.createElement('div');
  err.className = 'api-key-editor-error';
  err.style.display = 'none';
  editor.appendChild(err);

  const actions = document.createElement('div');
  actions.className = 'api-key-editor-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = 'Save';
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  editor.appendChild(actions);

  row.replaceWith(editor);
  requestAnimationFrame(() => input.focus());

  const cancel = () => {
    editor.replaceWith(row);
  };
  cancelBtn.addEventListener('click', cancel);

  const save = async () => {
    const key = input.value.trim();
    if (!key) {
      err.textContent = 'Key cannot be empty.';
      err.style.display = '';
      return;
    }
    saveBtn.disabled = true;
    const resp = await rpcCommand(
      { type: 'set_api_key', provider: p.provider, apiKey: key },
      `Saving ${p.provider} key...`,
    );
    if (resp?.success) {
      loadApiKeysPanel();
    } else {
      err.textContent = resp?.error || 'Failed to save key.';
      err.style.display = '';
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
}

async function removeApiKey(p) {
  const ok = confirm(`Remove stored API key for ${p.displayName || p.provider}?`);
  if (!ok) return;
  const resp = await rpcCommand(
    { type: 'remove_api_key', provider: p.provider },
    `Removing ${p.provider} key...`,
  );
  if (resp?.success) {
    loadApiKeysPanel();
  }
}


// ═══════════════════════════════════════
// Agent Config Editor
// ═══════════════════════════════════════

const btnOpenConfig = document.getElementById('btn-open-config');
const inlineConfigPath = document.getElementById('inline-config-path');
const inlineConfigTextarea = document.getElementById('inline-config-textarea');
const inlineConfigError = document.getElementById('inline-config-error');
const inlineConfigSave = document.getElementById('inline-config-save');
const configEditorOverlay = document.getElementById('config-editor-overlay');
const configEditorModal = document.getElementById('config-editor-modal');
const configEditorClose = document.getElementById('config-editor-close');
const configEditorCancel = document.getElementById('config-editor-cancel');
const configEditorSave = document.getElementById('config-editor-save');
const configEditorTextarea = document.getElementById('config-editor-textarea');
const configEditorError = document.getElementById('config-editor-error');
const configEditorPath = document.getElementById('config-editor-path');

function openConfigEditor() {
  configEditorError.classList.add('hidden');
  configEditorTextarea.value = '';
  configEditorPath.textContent = '';
  configEditorModal.classList.remove('hidden');
  configEditorOverlay.classList.remove('hidden');

  fetch('/api/agent-config')
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        try {
          configEditorTextarea.value = JSON.stringify(JSON.parse(data.content), null, 2);
        } catch {
          configEditorTextarea.value = data.content;
        }
        configEditorPath.textContent = data.path || '';
      } else {
        showConfigError(data.error || 'Failed to load config');
      }
    })
    .catch(e => showConfigError(e.message));
}

function closeConfigEditor() {
  configEditorModal.classList.add('hidden');
  configEditorOverlay.classList.add('hidden');
}

function showConfigError(msg) {
  configEditorError.textContent = msg;
  configEditorError.classList.remove('hidden');
}

async function loadInlineConfigEditor() {
  if (!inlineConfigTextarea) return;
  inlineConfigError?.classList.add('hidden');
  inlineConfigTextarea.value = '';
  if (inlineConfigPath) inlineConfigPath.textContent = 'Loading...';
  try {
    const resp = await fetch('/api/agent-config');
    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to load config');
    }
    try {
      inlineConfigTextarea.value = JSON.stringify(JSON.parse(data.content), null, 2);
    } catch {
      inlineConfigTextarea.value = data.content;
    }
    if (inlineConfigPath) inlineConfigPath.textContent = data.path || '';
  } catch (e) {
    if (inlineConfigPath) inlineConfigPath.textContent = '';
    if (inlineConfigError) {
      inlineConfigError.textContent = e.message || String(e);
      inlineConfigError.classList.remove('hidden');
    }
  }
}

btnOpenConfig?.addEventListener('click', () => {
  closeSettings();
  openConfigEditor();
});

inlineConfigSave?.addEventListener('click', async () => {
  if (!inlineConfigTextarea) return;
  clearSettingsSaveMessage(inlineConfigError);
  const content = inlineConfigTextarea.value;
  try {
    JSON.parse(content);
  } catch (e) {
    showSettingsSaveError(inlineConfigError, `Invalid JSON: ${e.message}`);
    return;
  }
  setSettingsSaveButtonSaving(inlineConfigSave, true);
  try {
    const resp = await fetch('/api/agent-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to save config');
    }
    showSettingsSaveSuccess(inlineConfigError);
  } catch (e) {
    showSettingsSaveError(inlineConfigError, e.message || String(e));
  } finally {
    setSettingsSaveButtonSaving(inlineConfigSave, false);
  }
});

configEditorClose.addEventListener('click', closeConfigEditor);
configEditorCancel.addEventListener('click', closeConfigEditor);
configEditorOverlay.addEventListener('click', closeConfigEditor);

configEditorSave.addEventListener('click', async () => {
  configEditorError.classList.add('hidden');
  const content = configEditorTextarea.value;
  try {
    JSON.parse(content);
  } catch (e) {
    showConfigError('Invalid JSON: ' + e.message);
    return;
  }
  configEditorSave.disabled = true;
  try {
    const resp = await fetch('/api/agent-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await resp.json();
    if (data.success) {
      closeConfigEditor();
    } else {
      showConfigError(data.error || 'Failed to save config');
    }
  } catch (e) {
    showConfigError(e.message);
  } finally {
    configEditorSave.disabled = false;
  }
});

// ═══════════════════════════════════════
// LLM Providers (models.json) Editor
// ═══════════════════════════════════════
//
// Mirrors the agent-config editor above, but targets ~/.pi/agent/models.json —
// the file pi reads to discover custom providers and models (Ollama, vLLM,
// LM Studio, OpenAI-compat proxies, OpenRouter routing overrides, etc). See
// docs/models.md in the embedded pi runtime for the full schema.
//
// Save flow:
//  - Validate JSON on the client so users see syntax errors inline.
//  - PUT to /api/models-config which writes the file AND calls
//    modelRegistry.refresh(), so the model picker updates immediately
//    without restarting the workspace.

const inlineModelsPath = document.getElementById('inline-models-path');
const inlineModelsTextarea = document.getElementById('inline-models-textarea');
const inlineModelsError = document.getElementById('inline-models-error');
const inlineModelsSave = document.getElementById('inline-models-save');
const inlineModelsInsertExample = document.getElementById('inline-models-insert-example');
const modelsConfigDocsLink = document.getElementById('models-config-docs-link');

const MODELS_JSON_EXAMPLE = `{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
`;

function showInlineModelsError(message) {
  showSettingsSaveError(inlineModelsError, message);
}

function clearInlineModelsError() {
  clearSettingsSaveMessage(inlineModelsError);
}

async function loadInlineModelsEditor() {
  if (!inlineModelsTextarea) return;
  clearInlineModelsError();
  inlineModelsTextarea.value = '';
  if (inlineModelsPath) inlineModelsPath.textContent = 'Loading...';
  try {
    const resp = await fetch('/api/models-config');
    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to load models.json');
    }
    try {
      inlineModelsTextarea.value = JSON.stringify(JSON.parse(data.content), null, 2);
    } catch {
      inlineModelsTextarea.value = data.content;
    }
    if (inlineModelsPath) inlineModelsPath.textContent = data.path || '';
  } catch (e) {
    if (inlineModelsPath) inlineModelsPath.textContent = '';
    showInlineModelsError(e.message || String(e));
  }
}

inlineModelsSave?.addEventListener('click', async () => {
  if (!inlineModelsTextarea) return;
  clearInlineModelsError();
  const content = inlineModelsTextarea.value;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    showInlineModelsError(`Invalid JSON: ${e.message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    showInlineModelsError('models.json must be a JSON object.');
    return;
  }
  if ('providers' in parsed && (typeof parsed.providers !== 'object' || Array.isArray(parsed.providers))) {
    showInlineModelsError("'providers' must be an object.");
    return;
  }
  setSettingsSaveButtonSaving(inlineModelsSave, true);
  try {
    const resp = await fetch('/api/models-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await resp.json();
    if (!data.success) {
      throw new Error(data.error || 'Failed to save models.json');
    }
    showSettingsSaveSuccess(inlineModelsError);
    // Refresh the model picker so newly-defined models appear immediately.
    try { fetchModelInfo?.(); } catch {}
  } catch (e) {
    showInlineModelsError(e.message || String(e));
  } finally {
    setSettingsSaveButtonSaving(inlineModelsSave, false);
  }
});

inlineModelsInsertExample?.addEventListener('click', () => {
  if (!inlineModelsTextarea) return;
  // Only overwrite if the textarea is empty or just whitespace/empty
  // providers — never clobber existing user content.
  const current = inlineModelsTextarea.value.trim();
  if (current && current !== '{}' && current !== '{\n  "providers": {}\n}') {
    if (!confirm('Replace current content with the Ollama example?')) return;
  }
  inlineModelsTextarea.value = MODELS_JSON_EXAMPLE;
  clearInlineModelsError();
});

modelsConfigDocsLink?.addEventListener('click', (e) => {
  e.preventDefault();
  // Hand the docs URL off to the OS default browser via /api/open. The
  // endpoint shells out to `open <arg>` on macOS, which transparently
  // handles both file paths and https URLs. Falls back to window.open
  // when the embedded server is not running.
  const url = 'https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md';
  fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filePath: url }),
  })
    .then((r) => { if (!r.ok) throw new Error('open failed'); })
    .catch(() => { window.open(url, '_blank'); });
});

// Restore saved theme
const savedTheme = getCurrentTheme();
applyTheme(savedTheme);

// ═══════════════════════════════════════
// Context Window Visualiser
// ═══════════════════════════════════════

const contextViz = document.getElementById('context-viz');
const contextBar = document.getElementById('context-bar');
const contextLegend = document.getElementById('context-legend');
const contextVizUsed = document.getElementById('context-viz-used');
const contextVizTotal = document.getElementById('context-viz-total');


function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function updateContextViz() {
  if (!lastUsage || !contextWindowSize) return;

  const input = lastUsage.input || 0;
  const cacheRead = lastUsage.cacheRead || 0;
  const cacheWrite = lastUsage.cacheWrite || 0;
  const output = lastUsage.output || 0;
  const total = contextWindowSize;

  // Input tokens include cache — break it down
  // "input" from API = fresh (uncached) input tokens
  // "cacheRead" = tokens served from cache (system prompt, earlier messages)
  const freshInput = input;
  const totalUsed = freshInput + cacheRead;
  const free = Math.max(0, total - totalUsed);

  const segments = [
    { key: 'cache', label: 'Cached', tokens: cacheRead, color: 'cache' },
    { key: 'messages', label: 'Input', tokens: freshInput, color: 'messages' },
    { key: 'free', label: 'Available', tokens: free, color: 'free' },
  ];

  // Build bar
  contextBar.innerHTML = '';
  for (const seg of segments) {
    if (seg.tokens <= 0) continue;
    const pct = (seg.tokens / total) * 100;
    const el = document.createElement('div');
    el.className = `context-bar-segment ${seg.color}`;
    el.style.width = `${pct}%`;
    el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
    contextBar.appendChild(el);
  }

  // Build legend
  contextLegend.innerHTML = '';
  for (const seg of segments) {
    const item = document.createElement('div');
    item.className = 'context-legend-item';
    item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
    contextLegend.appendChild(item);
  }

  // Footer
  const pct = Math.round((totalUsed / total) * 100);
  contextVizUsed.textContent = `${pct}% used`;
  contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
}

// Toggle on click
tokenUsageEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const isHidden = contextViz.classList.contains('hidden');
  if (isHidden) {
    updateContextViz();
    contextViz.classList.remove('hidden');
  } else {
    contextViz.classList.add('hidden');
  }
});

// Close on click outside
document.addEventListener('click', (e) => {
  if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
    contextViz.classList.add('hidden');
  }
});

// ═══════════════════════════════════════
// Voice Input
// ═══════════════════════════════════════

const micBtn = document.getElementById('mic-btn');
let recognition = null;
let isRecording = false;

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-AU';

  let finalTranscript = '';
  let interimTranscript = '';

  recognition.addEventListener('result', (e) => {
    interimTranscript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalTranscript += e.results[i][0].transcript;
      } else {
        interimTranscript += e.results[i][0].transcript;
      }
    }
    // Show live transcription in the input
    messageInput.value = finalTranscript + interimTranscript;
    messageInput.dispatchEvent(new Event('input'));
  });

  recognition.addEventListener('end', () => {
    if (isRecording) {
      // Stopped unexpectedly — clean up
      stopRecording();
    }
  });

  recognition.addEventListener('error', (e) => {
    console.error('[Voice] Error:', e.error);
    stopRecording();
  });

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  function startRecording() {
    finalTranscript = messageInput.value; // Append to existing text
    interimTranscript = '';
    isRecording = true;
    micBtn.classList.add('recording');
    micBtn.title = 'Stop recording';
    recognition.start();
    messageInput.focus();
  }

  function stopRecording() {
    isRecording = false;
    micBtn.classList.remove('recording');
    micBtn.title = 'Voice input';
    try { recognition.stop(); } catch {}
    // Commit final transcript
    messageInput.value = finalTranscript;
    messageInput.dispatchEvent(new Event('input'));
    messageInput.focus();
  }
} else {
  // No speech recognition support — hide mic button
  micBtn.style.display = 'none';
}



// ═══════════════════════════════════════
// Initialize
// ═══════════════════════════════════════

// On mobile, collapse model bar above input
if (isMobile()) {
  sidebarEl.classList.add('collapsed');

  const mobileBar = document.getElementById('mobile-model-bar');

  // Start collapsed
  mobileBar.classList.add('collapsed');

  // Toggle via chevron
  const contextToggle = document.getElementById('mobile-context-toggle');
  contextToggle.addEventListener('click', () => {
    mobileBar.classList.toggle('collapsed');
    contextToggle.classList.toggle('flipped', !mobileBar.classList.contains('collapsed'));
  });
}

// Make the Pi Studio icon in sidebar switch back to chat
document.querySelector('.mode-link:first-child')?.addEventListener('click', () => {
  closeSettings();
});

// ═══════════════════════════════════════
// Open Folder as workspace
// ═══════════════════════════════════════

openFolderBtn?.addEventListener('click', async () => {
  if (workspaceLaunchInProgress) return;
  setWorkspaceLaunchInProgress(true);
  try {
    await openFolderAsWorkspace({
      tauriNative: window.tauriNative,
      fetchInstances,
      getCurrentPort,
      navigate: navigateInWindow,
      onBeforeSwap: onBeforeInstanceSwap,
      renderError: (message) => messageRenderer.renderError(message),
    });
  } finally {
    setWorkspaceLaunchInProgress(false);
  }
});

wsClient.connect();
dismissBootSwapOverlayWhenReady();
renderWorkspaceWelcome();
sidebar.loadSessions().then(() => {
  sessionsLoaded = true;
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

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Dismiss mobile splash screen
const splash = document.getElementById('mobile-splash');
if (splash) {
  requestAnimationFrame(() => {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 300);
  });
}

console.log('🚀 Pi Studio initialized');
