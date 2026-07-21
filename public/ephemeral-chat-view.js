// ABOUTME: Element-scoped chat view for one ephemeral runtime: messages, tools,
// ABOUTME: composer, dialogs, and usage — reusing the shared render helpers.

import { setupVoiceInput } from "./app/voice-input.js";
import { setupComposerCommandMenu } from "./composer-command-menu.js";
import { setupComposerImageAttachments } from "./composer-image-attachments.js";
import { onLocaleChange, t } from "./i18n.js";
import { processImageFile, processImagePayload } from "./image-attachments.js";
import { DialogHandler } from "./ui/dialogs.js";
import { MessageRenderer } from "./ui/message-renderer.js";
import { ToolCardRenderer } from "./ui/tool-card.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const SVG_NS = "http://www.w3.org/2000/svg";

function appendIcon(doc, button, paths, { fill = "none", strokeWidth = "2" } = {}) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", fill);
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", strokeWidth);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  button.replaceChildren(svg);
}

function appendSendIcon(doc, button) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const line = doc.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", "12");
  line.setAttribute("y1", "19");
  line.setAttribute("x2", "12");
  line.setAttribute("y2", "5");
  const chevron = doc.createElementNS(SVG_NS, "polyline");
  chevron.setAttribute("points", "5 12 12 5 19 12");
  svg.append(line, chevron);
  button.replaceChildren(svg);
}

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
    this._messagesEl.className = "messages ephemeral-messages";
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

    // Composer mirrors the main chat's card and toolbar hierarchy. The scoped
    // classes avoid duplicate document IDs while deliberately reusing its style.
    this._composer = doc.createElement("div");
    this._composer.className = "composer-card ephemeral-composer";
    this._textarea = doc.createElement("textarea");
    this._textarea.className = "ephemeral-input";
    this._textarea.placeholder = t("ephemeral.placeholder");
    this._textarea.rows = 2;
    this._imagePreviews = doc.createElement("div");
    this._imagePreviews.className = "image-previews hidden";
    this._imageInput = doc.createElement("input");
    this._imageInput.type = "file";
    this._imageInput.multiple = true;
    this._imageInput.accept = "image/*";
    this._imageInput.classList.add("hidden");
    this._composer.append(this._imagePreviews, this._textarea, this._imageInput);

    const toolbar = doc.createElement("div");
    toolbar.className = "composer-toolbar";
    const toolbarLeft = doc.createElement("div");
    toolbarLeft.className = "composer-toolbar-left";
    toolbar.appendChild(toolbarLeft);
    const toolbarRight = doc.createElement("div");
    toolbarRight.className = "composer-toolbar-right";

    const attachBtn = doc.createElement("button");
    attachBtn.type = "button";
    attachBtn.className = "input-icon-btn ephemeral-attach";
    attachBtn.dataset.role = "ephemeral-attach";
    appendIcon(doc, attachBtn, ["M12 5v14", "M5 12h14"]);
    this._attachBtn = attachBtn;
    toolbarLeft.appendChild(attachBtn);

    this._commandBtn = doc.createElement("button");
    this._commandBtn.type = "button";
    this._commandBtn.className = "input-icon-btn ephemeral-command";
    this._commandBtn.dataset.role = "ephemeral-command";
    const commandsLabel = t("input.commands");
    this._commandBtn.title = commandsLabel;
    this._commandBtn.setAttribute("aria-label", commandsLabel);
    appendIcon(doc, this._commandBtn, [
      "M12 22v-5",
      "M9 8V2",
      "M15 8V2",
      "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z",
    ]);
    toolbarLeft.appendChild(this._commandBtn);

    this._modelDropdown = doc.createElement("div");
    this._modelDropdown.className = "model-dropdown";
    this._modelBtn = doc.createElement("button");
    this._modelBtn.type = "button";
    this._modelBtn.className = "model-dropdown-btn";
    this._modelBtn.dataset.role = "ephemeral-model";
    this._modelLabel = doc.createElement("span");
    this._modelLabel.className = "model-dropdown-label";
    this._modelBtn.appendChild(this._modelLabel);
    const chevron = doc.createElementNS(SVG_NS, "svg");
    chevron.classList.add("model-dropdown-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.setAttribute("width", "10");
    chevron.setAttribute("height", "6");
    chevron.setAttribute("viewBox", "0 0 10 6");
    chevron.setAttribute("fill", "none");
    const chevronPath = doc.createElementNS(SVG_NS, "path");
    chevronPath.setAttribute("d", "M1 1L5 5L9 1");
    chevronPath.setAttribute("stroke", "currentColor");
    chevronPath.setAttribute("stroke-width", "1.5");
    chevronPath.setAttribute("stroke-linecap", "round");
    chevronPath.setAttribute("stroke-linejoin", "round");
    chevron.appendChild(chevronPath);
    this._modelBtn.appendChild(chevron);
    this._modelMenu = doc.createElement("div");
    this._modelMenu.className = "model-dropdown-menu hidden";
    this._modelDropdown.append(this._modelBtn, this._modelMenu);
    toolbarRight.appendChild(this._modelDropdown);

    this._thinkingBtn = doc.createElement("button");
    this._thinkingBtn.type = "button";
    this._thinkingBtn.className = "thinking-tag off";
    this._thinkingBtn.dataset.role = "ephemeral-thinking";
    toolbarRight.appendChild(this._thinkingBtn);

    this._micBtn = doc.createElement("button");
    this._micBtn.type = "button";
    this._micBtn.className = "input-mic-btn ephemeral-mic";
    appendIcon(doc, this._micBtn, [
      "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
      "M19 10v2a7 7 0 0 1-14 0v-2",
      "M12 19v3",
    ]);
    toolbarRight.appendChild(this._micBtn);

    this._sendBtn = doc.createElement("button");
    this._sendBtn.type = "button";
    this._sendBtn.className = "ephemeral-send";
    this._sendBtn.dataset.role = "ephemeral-send";
    toolbarRight.appendChild(this._sendBtn);
    toolbar.appendChild(toolbarRight);
    this._composer.appendChild(toolbar);

    this._commandOverlay = doc.createElement("div");
    this._commandOverlay.className = "command-palette-overlay hidden";
    this._commandMenu = doc.createElement("div");
    this._commandMenu.className = "command-palette hidden";
    this._commandHeader = doc.createElement("div");
    this._commandHeader.className = "command-palette-header";
    this._commandHeader.textContent = t("input.commands");
    this._commandList = doc.createElement("div");
    this._commandList.className = "command-list";
    this._commandMenu.append(this._commandHeader, this._commandList);
    this._root.append(this._commandOverlay, this._commandMenu, this._composer);

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

    // Image attachments: attach button, native picker, paste/drop, previews.
    // Spec §Frontend Module Boundaries: any reused setup helper must return
    // an explicit cleanup function for the owning view.
    this._imageAttachments = setupComposerImageAttachments({
      doc,
      composerCard: this._composer,
      textarea: this._textarea,
      attachBtn: this._attachBtn,
      imageInput: this._imageInput,
      imagePreviews: this._imagePreviews,
      processImageFile,
      processImagePayload,
      pickImageFiles: this.runtime?.transport?.pickImageFiles?.bind(this.runtime.transport),
      getWorkspacePath: undefined,
      isNativeAvailable: () => Boolean(this.runtime?.transport?.capabilities?.native),
      t,
    });
    this._commandMenuController = setupComposerCommandMenu({
      button: this._commandBtn,
      menu: this._commandMenu,
      list: this._commandList,
      getCommands: () => this._sideCommands(),
      document: this._doc,
      overlay: this._commandOverlay,
    });

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
    this._onModelClick = () => void this._toggleModelMenu();
    this._onThinkingClick = () => this._cycleThinkingLevel();
    this._onDocumentClick = (event) => {
      if (!this._modelDropdown.contains(event.target)) this._closeModelMenu();
    };
    this._modelBtn.addEventListener("click", this._onModelClick);
    this._thinkingBtn.addEventListener("click", this._onThinkingClick);
    this._doc.addEventListener("click", this._onDocumentClick);
    this._unsubscribeLocale = onLocaleChange(() => {
      this._commandHeader.textContent = t("input.commands");
      this._renderComposerState({
        model: this.runtime.model,
        thinkingLevel: this.runtime.thinkingLevel,
        isStreaming: this.runtime.isStreaming,
      });
    });
    this._renderComposerState({
      model: this.runtime.model,
      thinkingLevel: this.runtime.thinkingLevel,
      isStreaming: this.runtime.isStreaming,
    });
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
    this._modelBtn.disabled = this._interactionLocked;
    this._thinkingBtn.disabled = this._interactionLocked;
    this._attachBtn.disabled = this._interactionLocked;
    this._commandBtn.disabled = this._interactionLocked;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.runtime.removeEventListener("renderstate", this._onRenderState);
    this.runtime.removeEventListener("extensionuirequest", this._onExtensionUi);
    this._textarea.removeEventListener("keydown", this._onKeyDown);
    this._sendBtn.removeEventListener("click", this._onSendClick);
    this._modelBtn.removeEventListener("click", this._onModelClick);
    this._thinkingBtn.removeEventListener("click", this._onThinkingClick);
    this._commandMenuController?.destroy();
    this._doc.removeEventListener("click", this._onDocumentClick);
    this._unsubscribeLocale?.();
    this.messageRenderer?.destroy();
    this.toolCardRenderer?.destroy();
    this.dialogHandler?.destroy();
    this._destroyVoice?.();
    this._imageAttachments?.destroy();
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
    const images = this._imageAttachments?.consumePendingImages() || [];
    this.runtime.sendPrompt(text, images);
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

    this._renderUsage(state);
    this._renderComposerState(state);
  }

  _sideCommands() {
    return [
      {
        icon: "🗜️",
        label: t("input.compact"),
        desc: t("input.compactDesc"),
        action: () => this.runtime.runCommand("compact"),
      },
      {
        icon: "📋",
        label: t("input.exportHtml"),
        desc: t("input.exportHtmlDesc"),
        action: () => {},
        disabled: true,
      },
      {
        icon: "📊",
        label: t("input.sessionStats"),
        desc: t("input.sessionStatsDesc"),
        action: async () => {
          const stats = await this.runtime.runCommand("get_session_stats");
          if (!stats) return;
          this.messageRenderer.renderSystemMessage(
            t("status.sessionStatsMessages", {
              total: stats.totalMessages,
              user: stats.userMessages,
              assistant: stats.assistantMessages,
            }),
          );
        },
      },
      {
        icon: "⬇️",
        label: t("input.expandAllTools"),
        desc: t("input.expandAllToolsDesc"),
        action: () => this.toolCardRenderer?.expandAll(),
      },
      {
        icon: "⬆️",
        label: t("input.collapseAllTools"),
        desc: t("input.collapseAllToolsDesc"),
        action: () => this.toolCardRenderer?.collapseAll(),
      },
    ];
  }
  async _toggleModelMenu() {
    if (this._interactionLocked) return;
    if (!this._modelMenu.classList.contains("hidden")) {
      this._closeModelMenu();
      return;
    }

    this._modelMenu.replaceChildren();
    this._modelDropdown.classList.add("open");
    this._modelMenu.classList.remove("hidden");
    try {
      // Prefer the host-wide cache so the menu renders instantly without
      // waiting for this ephemeral Pi to respond. Fall back to the live
      // query if the cache is cold. Both paths run sequentially to preserve
      // the runtime's pending-request setup order: the cache is a fast
      // read, and if it misses, the live query takes over.
      let models = [];
      if (typeof this.runtime.transport?.getCachedModels === "function") {
        try {
          const cached = await this.runtime.transport.getCachedModels();
          if (Array.isArray(cached?.models)) models = cached.models;
        } catch {
          // cache unavailable — fall through to the live query
        }
      }
      if (models.length === 0) {
        models = await this.runtime.getAvailableModels();
      }
      if (this.destroyed || this._modelMenu.classList.contains("hidden")) return;
      this._renderModelMenu(models);
    } catch {
      this._renderModelMenu([]);
    }
  }

  _closeModelMenu() {
    this._modelMenu.classList.add("hidden");
    this._modelDropdown.classList.remove("open");
  }

  _renderModelMenu(models) {
    this._modelMenu.replaceChildren();

    const search = this._doc.createElement("input");
    search.className = "model-dropdown-search";
    search.placeholder = t("models.searchPlaceholder");
    search.type = "text";
    this._modelMenu.appendChild(search);

    const itemsContainer = this._doc.createElement("div");
    itemsContainer.className = "model-dropdown-items";
    this._modelMenu.appendChild(itemsContainer);

    const activeModelId = this.runtime.model?.id ?? this.runtime.model?.modelId;
    const renderItems = (filter) => {
      itemsContainer.replaceChildren();
      const query = (filter || "").toLowerCase();
      if (!models.length) {
        const empty = this._doc.createElement("div");
        empty.className = "model-dropdown-empty";
        empty.textContent = t("models.emptyTitle");
        itemsContainer.appendChild(empty);
        return;
      }

      for (const model of models) {
        const id = model.id || "";
        const shortName = id.replace(/-\d{8}$/, "");
        const providerName = model.provider || "";
        if (
          query &&
          !shortName.toLowerCase().includes(query) &&
          !providerName.toLowerCase().includes(query)
        ) {
          continue;
        }

        const option = this._doc.createElement("div");
        option.className = `model-dropdown-item${id === activeModelId ? " active" : ""}`;
        const name = this._doc.createElement("span");
        name.textContent = shortName;
        if (providerName && providerName !== "anthropic") {
          const provider = this._doc.createElement("span");
          provider.className = "model-dropdown-item-provider";
          provider.textContent = providerName;
          name.appendChild(provider);
        }
        const context = this._doc.createElement("span");
        context.className = "model-dropdown-item-ctx";
        context.textContent = model.contextWindow
          ? `${(model.contextWindow / 1000).toFixed(0)}k`
          : "";
        option.append(name, context);
        option.addEventListener("click", () => {
          this.runtime.setModel(model.provider, id);
          this._closeModelMenu();
        });
        itemsContainer.appendChild(option);
      }
    };

    renderItems("");
    search.addEventListener("input", () => renderItems(search.value));
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this._closeModelMenu();
        event.stopPropagation();
      } else if (event.key === "Enter") {
        itemsContainer.querySelector(".model-dropdown-item")?.click();
      }
    });
    requestAnimationFrame(() => search.focus());
  }

  _cycleThinkingLevel() {
    if (this._interactionLocked) return;
    const current = this.runtime.thinkingLevel || "off";
    const index = THINKING_LEVELS.indexOf(current);
    const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
    this.runtime.setThinkingLevel(next);
  }

  _renderComposerState(state) {
    const model = state?.model;
    const modelId =
      typeof model === "string" ? model : model?.id || model?.modelId || t("misc.model");
    this._modelLabel.textContent = modelId;
    this._modelBtn.title = t("input.switchModel");
    this._modelBtn.setAttribute("aria-label", t("input.switchModel"));

    const thinkingLevel = state?.thinkingLevel || "off";
    this._thinkingBtn.textContent = t("settings.thinkingCompact", { level: thinkingLevel });
    this._thinkingBtn.title = t("settings.thinkingTitle");
    this._thinkingBtn.setAttribute(
      "aria-label",
      t("settings.thinkingAriaLabel", { level: thinkingLevel }),
    );
    this._thinkingBtn.classList.toggle("off", thinkingLevel === "off");

    const sendLabel = state?.isStreaming ? t("ephemeral.abort") : t("ephemeral.send");
    this._sendBtn.title = sendLabel;
    this._sendBtn.setAttribute("aria-label", sendLabel);
    if (state?.isStreaming) {
      appendIcon(this._doc, this._sendBtn, ["M4 4h16v16H4z"], {
        fill: "currentColor",
        strokeWidth: "2.5",
      });
    } else {
      appendSendIcon(this._doc, this._sendBtn);
    }
    const voiceLabel = t("voice.voiceInput");
    this._micBtn.title = voiceLabel;
    this._micBtn.setAttribute("aria-label", voiceLabel);
  }

  _renderUsage(state) {
    if (!this._usageEl) return;
    const parts = [];
    const status = this._connectionStatus(state);
    if (status) parts.push(status);
    const tokens = state?.totalTokens ?? state?.contextUsage?.used ?? state?.contextUsage?.tokens;
    if (typeof tokens === "number" && tokens > 0) {
      parts.push(`${tokens} ${t("ephemeral.tokens")}`);
    }
    const cost = state?.cost;
    if (typeof cost === "number" && cost > 0) {
      parts.push(`$${cost.toFixed(4)}`);
    }
    this._usageEl.textContent = parts.join(" · ");
  }

  _connectionStatus(state) {
    if (state?.error) return t("ephemeral.statusError");
    if (state?.isStreaming) return t("ephemeral.statusStreaming");
    return t("ephemeral.statusReady");
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
