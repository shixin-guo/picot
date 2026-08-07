// ABOUTME: Owns the Side Chat collection: quota, titles, transient-tab projection,
// ABOUTME: close flows, workspace-transition settlement, and rebind after reload.

import { t } from "../../i18n.js";
import { EphemeralChatRuntime } from "./ephemeral-chat-runtime.js";

const SIDE_CHAT_QUOTA = 1;
const MAX_TITLE_GRAPHEMES = 40;

/** Collapse whitespace and grapheme-safe-truncate a Side Chat title. */
export function normalizeSideChatTitle(text) {
  const collapsed = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  const graphemes = segmentGraphemes(collapsed);
  if (graphemes.length <= MAX_TITLE_GRAPHEMES) return collapsed;
  return `${graphemes.slice(0, MAX_TITLE_GRAPHEMES - 1).join("")}…`;
}

function segmentGraphemes(text) {
  try {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      return Array.from(new Intl.Segmenter().segment(text)).map((s) => s.segment);
    }
  } catch {
    // fall through
  }
  return Array.from(text);
}

export class SideChatManager {
  constructor({
    runtime,
    hostRequest,
    getWorkspaceId,
    filePreviewPanel,
    confirmDiscard,
    createView,
    getStartupProfile = async () => null,
  }) {
    this.runtime = runtime;
    this.hostRequest = hostRequest;
    this.getWorkspaceId = getWorkspaceId;
    this.filePreviewPanel = filePreviewPanel;
    this.confirmDiscard = confirmDiscard;
    this.createView = createView;
    this.getStartupProfile = getStartupProfile;
    this.createView = createView || (() => null);
    this.chats = new Map(); // instanceId -> { descriptor, runtime, view, title }
    this.order = [];
    this.activeId = null;
    this._creating = false;
    this._closingIds = new Set();
    this._locked = false;
    this._updateQuotaUi();
  }

  async create() {
    if (this._locked || this._creating || this.chats.size >= SIDE_CHAT_QUOTA) return null;
    this._creating = true;
    this._updateQuotaUi();
    // Show a loading tab immediately so the user sees feedback while pi
    // spins up (cold start takes several seconds). The tab is replaced by
    // the real Side Chat view once the descriptor arrives.
    const loadingId = `side-chat-loading-${Date.now()}`;
    const loadingElement = this._buildLoadingElement();
    this.filePreviewPanel.registerTransientTab({
      id: loadingId,
      title: t("ephemeral.startingSideChat"),
      fullTitle: t("ephemeral.startingSideChat"),
      status: "streaming",
      unread: false,
      contentElement: loadingElement,
      onActivate: () => {},
      onDeactivate: () => {},
      onRequestClose: () => {},
    });
    this.filePreviewPanel.activateContent({ kind: "transient", id: loadingId });
    this.filePreviewPanel.showPanel();
    try {
      const startupProfile = await this.getStartupProfile();
      const response = await this.hostRequest({
        operation: "ephemeral_create",
        kind: "side-chat",
        workspaceId: this.getWorkspaceId(),
        startupProfile,
      });
      const descriptor = response?.descriptor;
      if (!descriptor) {
        this.filePreviewPanel.unregisterTransientTab(loadingId);
        return null;
      }
      try {
        this._instantiate(descriptor, true, startupProfile);
        this.filePreviewPanel.unregisterTransientTab(loadingId);
      } catch (error) {
        await this._closeInstance(descriptor.instanceId, descriptor.generation).catch(() => {});
        this.filePreviewPanel.unregisterTransientTab(loadingId);
        throw error;
      }
      return descriptor;
    } catch (error) {
      this.filePreviewPanel.unregisterTransientTab(loadingId);
      throw error;
    } finally {
      this._creating = false;
      this._updateQuotaUi();
    }
  }

  _buildLoadingElement() {
    const doc = globalThis.document;
    const el = doc.createElement("div");
    el.className = "ephemeral-chat-loading";
    el.setAttribute("role", "status");
    el.setAttribute("aria-busy", "true");
    el.textContent = t("ephemeral.startingSideChat");
    return el;
  }

  /** Header button: create the first, restore the most recent, or collapse. */
  async openMostRecent() {
    if (this.chats.size === 0) return this.create();
    const last = this.order[this.order.length - 1];
    const isVisible =
      this.filePreviewPanel.panelOpen &&
      this.filePreviewPanel.activeContent?.kind === "transient" &&
      this.filePreviewPanel.activeContent.id === last;
    if (isVisible) {
      this.filePreviewPanel.hidePanel();
    } else if (last) {
      this.filePreviewPanel.activateContent({ kind: "transient", id: last });
    }
    return this.chats.get(last)?.descriptor || null;
  }

  async close(instanceId) {
    if (this._locked || this._closingIds.has(instanceId)) return false;
    const chat = this.chats.get(instanceId);
    if (!chat) return false;
    this._closingIds.add(instanceId);
    const risk = chat.runtime.getCloseRisk();
    try {
      if (risk.hasMessages || risk.streaming) {
        const decision = await this.confirmDiscard([risk], "side-chat");
        if (decision !== "discard") return false;
      }
      if (risk.streaming) chat.runtime.abort();
      try {
        await this._closeInstance(instanceId, chat.descriptor.generation);
      } catch {
        // Keep the tab intact if host cleanup failed.
        return false;
      }
      this._dispose(instanceId);
      this.filePreviewPanel.unregisterTransientTab(instanceId);
      this._updateQuotaUi();
      return true;
    } finally {
      this._closingIds.delete(instanceId);
    }
  }

  /** Reconstruct chats from an owner bootstrap descriptor list (creation order). */
  rebind(descriptors) {
    const incoming = new Map(
      (descriptors || []).map((descriptor) => [descriptor.instanceId, descriptor]),
    );
    for (const id of this.order.slice()) {
      if (!incoming.has(id)) {
        this._dispose(id);
        this.filePreviewPanel.unregisterTransientTab(id);
      }
    }
    for (const descriptor of descriptors || []) {
      const current = this.chats.get(descriptor.instanceId);
      if (current && current.descriptor.generation !== descriptor.generation) {
        this._dispose(descriptor.instanceId);
        this.filePreviewPanel.unregisterTransientTab(descriptor.instanceId);
      }
      if (!this.chats.has(descriptor.instanceId)) this._instantiate(descriptor, false);
    }
  }

  async prepareWorkspaceTransition() {
    if (this._locked) return false;
    this.setInteractionLocked(true);
    const risks = this.getCloseRisk().filter((risk) => risk.hasMessages || risk.streaming);
    if (risks.length > 0) {
      const decision = await this.confirmDiscard(risks, "workspace");
      if (decision !== "discard") {
        this.setInteractionLocked(false);
        return false;
      }
    }
    for (const risk of this.getCloseRisk()) {
      const chat = this.chats.get(risk.instanceId);
      if (!chat) continue;
      if (risk.streaming) chat.runtime.abort();
      try {
        await this._closeInstance(risk.instanceId, risk.generation);
      } catch {
        this.setInteractionLocked(false);
        return false;
      }
      this._dispose(risk.instanceId);
      this.filePreviewPanel.unregisterTransientTab(risk.instanceId);
    }
    this.setInteractionLocked(false);
    return true;
  }

  setInteractionLocked(locked) {
    this._locked = Boolean(locked);
    for (const chat of this.chats.values()) {
      chat.view?.setInteractionLocked?.(locked);
    }
  }

  getCloseRisk() {
    const risks = [];
    for (const id of this.order) {
      const chat = this.chats.get(id);
      if (chat) risks.push(chat.runtime.getCloseRisk());
    }
    return risks;
  }

  /** Host confirmed the window-close cleanup: drop everything without host calls. */
  cleanupAfterHostClose() {
    for (const id of this.order.slice()) {
      const chat = this.chats.get(id);
      // Spec §Lifecycle: abort streaming ephemeral chats before host cleanup.
      if (chat?.runtime?.isStreaming) chat.runtime.abort();
      this._dispose(id);
      this.filePreviewPanel.unregisterTransientTab(id);
    }
    this.order = [];
    this._closingIds.clear();
    this._locked = false;
    this._updateQuotaUi();
  }

  destroy() {
    for (const id of this.order.slice()) {
      const chat = this.chats.get(id);
      if (chat?.runtime?.isStreaming) chat.runtime.abort();
      this._dispose(id);
      this.filePreviewPanel.unregisterTransientTab(id);
    }
    this.order = [];
    this._closingIds.clear();
    this._locked = false;
    this._updateQuotaUi();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _instantiate(descriptor, activate = true, startupProfile = null) {
    const ephemeralTarget = {
      workspaceId: descriptor.workspaceId || descriptor.instanceId,
      sessionId: descriptor.instanceId,
      instanceId: descriptor.instanceId,
    };
    const runtime = new EphemeralChatRuntime({
      descriptor,
      runtime: this.runtime,
      target: ephemeralTarget,
    });
    // Subscribe to runtime events filtered for this instance.
    const unsubscribe = this.runtime.subscribe((frame) => {
      if (!frame) return;
      // Pi runtime events have a target field with instanceId; filter by it.
      const targetId = frame?.target?.instanceId || frame?.instanceId || "";
      if (targetId === descriptor.instanceId) {
        runtime.applySequencedEvent({ payload: frame });
      }
    });
    runtime.active = activate;
    runtime.unread = Boolean(descriptor.unread);
    runtime.addEventListener("titleprompt", (event) => {
      this._applyTitle(descriptor.instanceId, event.detail.text);
    });
    runtime.addEventListener("unreadchange", (event) => {
      const unread = Boolean(event.detail?.unread);
      this.filePreviewPanel.updateTransientTab(descriptor.instanceId, { unread });
      void this.hostRequest?.({
        operation: "ephemeral_update_ui",
        instanceId: descriptor.instanceId,
        generation: descriptor.generation,
        unread,
      });
    });
    runtime.addEventListener("renderstate", (event) => {
      this.filePreviewPanel.updateTransientTab(descriptor.instanceId, {
        status: event.detail?.isStreaming ? "streaming" : "ready",
      });
    });
    const view = this.createView(runtime);
    const title = descriptor.title || t("ephemeral.sideChat");
    this.chats.set(descriptor.instanceId, { descriptor, runtime, view, title, unsubscribe });
    this.order.push(descriptor.instanceId);
    this.filePreviewPanel.registerTransientTab({
      id: descriptor.instanceId,
      title,
      fullTitle: title,
      status: descriptor.state || "ready",
      unread: Boolean(descriptor.unread),
      contentElement: view?.element,
      onActivate: () => {
        this.activeId = descriptor.instanceId;
        runtime.acknowledgeVisible();
        view?.activate?.();
      },
      onDeactivate: () => {
        runtime.active = false;
        view?.deactivate?.();
        if (this.activeId === descriptor.instanceId) this.activeId = null;
      },
      onRequestClose: () => {
        void this.close(descriptor.instanceId);
      },
    });
    if (activate) {
      this.filePreviewPanel.activateContent({ kind: "transient", id: descriptor.instanceId });
      this.filePreviewPanel.showPanel();
      this.activeId = descriptor.instanceId;
    }
    // Both fresh and re-bound runtimes begin from an authoritative snapshot;
    // any broker events that arrive first remain queued until it is applied.
    runtime.requestSnapshot();
    // After the runtime's first snapshot is applied (renderstate fires), push
    // the inherited model + thinking level via WS. The host also sends
    // set_model via stdin at spawn time, but the runtime snapshot may race
    // ahead and show Pi's advisor-restored model. This WS set_model is the
    // authoritative path: it updates Pi's state and emits a fresh renderstate
    // with the correct model, so the view re-renders correctly.
    if (startupProfile?.provider && startupProfile?.modelId) {
      const applyOnce = () => {
        runtime.removeEventListener("renderstate", applyOnce);
        void runtime.setModel(startupProfile.provider, startupProfile.modelId).catch(() => {});
        if (startupProfile.thinkingLevel && startupProfile.thinkingLevel !== "off") {
          void runtime.setThinkingLevel(startupProfile.thinkingLevel).catch(() => {});
        }
      };
      runtime.addEventListener("renderstate", applyOnce);
    }
    this._updateQuotaUi();
  }

  _applyTitle(instanceId, rawText) {
    const chat = this.chats.get(instanceId);
    if (!chat) return;
    const title = normalizeSideChatTitle(rawText);
    if (!title) return;
    chat.title = title;
    chat.descriptor.title = title;
    this.filePreviewPanel.updateTransientTab(instanceId, {
      title,
      fullTitle: rawText.replace(/\s+/g, " ").trim(),
    });
    void this.hostRequest?.({
      operation: "ephemeral_update_ui",
      instanceId,
      generation: chat.descriptor.generation,
      title,
    });
  }

  _dispose(instanceId) {
    const chat = this.chats.get(instanceId);
    if (!chat) return;
    chat.unsubscribe?.();
    chat.runtime.destroy();
    chat.view?.destroy?.();
    this.chats.delete(instanceId);
    this.order = this.order.filter((id) => id !== instanceId);
    if (this.activeId === instanceId) this.activeId = null;
    this._updateQuotaUi();
  }

  _updateQuotaUi() {
    // The header button is the sole Side Chat entry point. Keep this method as
    // a state-refresh hook for callers that rebind or close a runtime.
  }

  async _closeInstance(instanceId, generation) {
    await this.hostRequest?.({
      operation: "ephemeral_close",
      instanceId,
      generation,
    });
  }
}
