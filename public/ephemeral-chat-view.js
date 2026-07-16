// ABOUTME: Element-scoped chat view for one ephemeral runtime: messages, tools,
// ABOUTME: composer, dialogs, and usage — reusing the shared render helpers.

import { setupVoiceInput } from "./app-voice-input.js";
import { DialogHandler } from "./dialogs.js";
import { t } from "./i18n.js";
import { MessageRenderer } from "./message-renderer.js";
import { ToolCardRenderer } from "./tool-card.js";

/**
 * Builds an isolated DOM tree for one ephemeral chat and projects the runtime's
 * render state into it. Side Chat enables tools; Quick Chat does not. Multiple
 * views can stay alive while only one is visible.
 */
export class EphemeralChatView {
  constructor({ runtime, kind, toolsEnabled }) {
    this.runtime = runtime;
    this.kind = kind || "side-chat";
    this.toolsEnabled = toolsEnabled !== false;
    this.destroyed = false;
    this._interactionLocked = false;

    const doc = globalThis.document;
    this._doc = doc;

    this._root = doc.createElement("div");
    this._root.className = "ephemeral-chat-view";
    this._root.setAttribute("role", "tabpanel");

    this._messagesEl = doc.createElement("div");
    this._messagesEl.className = "ephemeral-messages";
    this._root.appendChild(this._messagesEl);

    if (this.toolsEnabled) {
      this._toolsEl = doc.createElement("div");
      this._toolsEl.className = "ephemeral-tools";
      this._root.appendChild(this._toolsEl);
    }

    this._usageEl = doc.createElement("div");
    this._usageEl.className = "ephemeral-usage";
    this._root.appendChild(this._usageEl);

    this._dialogContainer = doc.createElement("div");
    this._dialogContainer.className = "ephemeral-dialog-container hidden";
    this._root.appendChild(this._dialogContainer);

    // Composer
    this._composer = doc.createElement("div");
    this._composer.className = "ephemeral-composer";
    this._textarea = doc.createElement("textarea");
    this._textarea.className = "ephemeral-input";
    this._textarea.placeholder = t("ephemeral.placeholder");
    this._textarea.rows = 1;
    this._composer.appendChild(this._textarea);

    this._sendBtn = doc.createElement("button");
    this._sendBtn.type = "button";
    this._sendBtn.className = "ephemeral-send";
    this._sendBtn.dataset.role = "ephemeral-send";
    this._sendBtn.textContent = t("ephemeral.send");
    this._composer.appendChild(this._sendBtn);

    this._micBtn = doc.createElement("button");
    this._micBtn.type = "button";
    this._micBtn.className = "ephemeral-mic";
    this._micBtn.title = t("voice.voiceInput");
    this._composer.appendChild(this._micBtn);
    this._root.appendChild(this._composer);

    // Shared render helpers, each scoped to this view's containers.
    this.messageRenderer = new MessageRenderer(this._messagesEl);
    this.toolCardRenderer = this.toolsEnabled ? new ToolCardRenderer(this._toolsEl) : null;
    this.dialogHandler = new DialogHandler({
      container: this._dialogContainer,
      notificationContainer: this._messagesEl,
      send: (message) => {
        // The response routes back through the runtime's owner-scoped transport.
        this.runtime.respondToExtensionUi(message.id, message);
      },
    });

    this._destroyVoice = setupVoiceInput({ micBtn: this._micBtn, messageInput: this._textarea });

    this._onRenderState = (event) => this._render(event.detail);
    this._onExtensionUi = (event) => this._showExtensionDialog(event.detail.request);
    this._onKeyDown = (event) => this._handleKeyDown(event);
    this.runtime.addEventListener("renderstate", this._onRenderState);
    this.runtime.addEventListener("extensionuirequest", this._onExtensionUi);
    this._textarea.addEventListener("keydown", this._onKeyDown);
    this._onSendClick = () => {
      if (this.runtime.isStreaming) this.runtime.abort();
      else this._submit();
    };
    this._sendBtn.addEventListener("click", this._onSendClick);
  }

  get element() {
    return this._root;
  }

  activate() {
    this.runtime.acknowledgeVisible();
  }

  deactivate() {
    // Hiding the view does not destroy it.
  }

  focusLastMeaningfulControl() {
    if (!this.destroyed) this._textarea.focus();
  }

  setInteractionLocked(locked) {
    this._interactionLocked = Boolean(locked);
    this._textarea.disabled = this._interactionLocked;
    this._sendBtn.disabled = this._interactionLocked;
    this._micBtn.disabled = this._interactionLocked;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.runtime.removeEventListener("renderstate", this._onRenderState);
    this.runtime.removeEventListener("extensionuirequest", this._onExtensionUi);
    this._textarea.removeEventListener("keydown", this._onKeyDown);
    this._sendBtn.removeEventListener("click", this._onSendClick);
    this.messageRenderer?.destroy();
    this.toolCardRenderer?.destroy();
    this.dialogHandler?.destroy();
    this._destroyVoice?.();
    this._root.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _submit() {
    if (this.destroyed || this._interactionLocked) return;
    if (this.runtime.isStreaming) {
      this.runtime.abort();
      return;
    }
    const text = this._textarea.value.trim();
    if (!text) return;
    this.runtime.sendPrompt(text);
    this._textarea.value = "";
  }

  _handleKeyDown(event) {
    if (this.destroyed) return;
    if (event.key === "Escape" && this.runtime.isStreaming) {
      event.preventDefault();
      this.runtime.abort();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this._submit();
    }
  }

  _render(state) {
    if (this.destroyed || !state) return;
    this.messageRenderer.clear();
    for (const message of state.messages || []) {
      if (message.role === "user") {
        this.messageRenderer.renderUserMessage(message);
      } else if (message.role === "assistant") {
        this.messageRenderer.renderAssistantMessage(message);
      }
    }
    if (state.assistantDraft) {
      const streamingEl = this.messageRenderer.renderAssistantMessage(
        { content: state.assistantDraft.text || "" },
        true,
      );
      if (state.assistantDraft.thinking) {
        this.messageRenderer.updateStreamingThinking(streamingEl, state.assistantDraft.thinking);
      }
    }
    if (state.error) {
      this.messageRenderer.renderError(state.error);
    }

    if (this.toolCardRenderer) {
      this.toolCardRenderer.clear();
      for (const tool of state.tools || []) {
        this.toolCardRenderer.createToolCard(tool);
        this.toolCardRenderer.updateToolCard(tool);
      }
    }

    this._renderUsage(state.contextUsage);
    this._sendBtn.textContent = state.isStreaming ? t("ephemeral.abort") : t("ephemeral.send");
    this._sendBtn.setAttribute(
      "aria-label",
      state.isStreaming ? t("ephemeral.abort") : t("ephemeral.send"),
    );
  }

  _renderUsage(contextUsage) {
    if (!this._usageEl) return;
    const tokens = contextUsage?.used ?? contextUsage?.tokens;
    if (typeof tokens === "number") {
      this._usageEl.textContent = `${tokens} ${t("ephemeral.tokens")}`;
    } else {
      this._usageEl.textContent = "";
    }
  }

  _showExtensionDialog(request) {
    if (this.destroyed || !request) return;
    switch (request.method) {
      case "select":
        this.dialogHandler.showSelect(request);
        break;
      case "confirm":
        this.dialogHandler.showConfirm(request);
        break;
      case "input":
        this.dialogHandler.showInput(request);
        break;
      case "editor":
        this.dialogHandler.showEditor(request);
        break;
      default:
        break;
    }
  }
}
