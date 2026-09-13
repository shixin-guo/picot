// ABOUTME: Renders user and assistant chat messages for the Picot WebView.
// ABOUTME: Preserves renderer behavior while exposing user elements for navigation.
/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { onLocaleChange, t } from "../i18n.js";
import { createIcon } from "../icons.js";
import { initImageLightbox } from "./image-lightbox.js";
import { renderMarkdown, renderStreamingMarkdown, renderUserMarkdown } from "./markdown.js";
import { sanitizeMarkup } from "./sanitize-markup.js";

/**
 * Detect and clean up pi-chat transcript format.
 *
 * Old format: `- [ISO-timestamp] [uid:ID] name: text`
 * New format:  `- [uid:ID] name: text`
 *
 * Returns the cleaned text (just `name: text` per line, deduplicated when
 * all lines share the same speaker), or null if the content doesn't look
 * like a chat transcript.
 */
function cleanChatTranscript(text) {
  if (!text || typeof text !== "string") return null;
  const lineRe = /^- (?:\[[\dT:.Z+-]+\] )?\[uid:[^\]]+\] ([^:]+): (.*)$/;
  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 0) return null;
  const parsed = lines.map((line) => {
    const match = line.match(lineRe);
    return match ? { name: match[1].trim(), text: match[2] } : null;
  });
  if (parsed.some((line) => line === null)) return null;
  const names = [...new Set(parsed.map((line) => line.name))];
  if (names.length === 1) {
    return parsed.map((line) => line.text).join("\n");
  }
  return parsed.map((line) => `**${line.name}**: ${line.text}`).join("\n\n");
}

const COPY_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHEVRON_ICON =
  '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M2 1l4 3-4 3z"/></svg>';
const BRAIN_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px" aria-hidden="true"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg>';
const AUTO_SCROLL_BOTTOM_TOLERANCE = 1;

export const USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD = 400;
export const USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD = 8;

function resolveMessageEntryId(message, override = null) {
  const id = override ?? message?.entryId ?? message?.entry_id ?? null;
  return typeof id === "string" && id ? id : null;
}

export function shouldCollapseUserMessage(text) {
  if (typeof text !== "string" || text.length === 0) return false;
  return (
    text.length >= USER_MESSAGE_COLLAPSE_CHAR_THRESHOLD ||
    (text.match(/\n/g)?.length ?? 0) >= USER_MESSAGE_COLLAPSE_NEWLINE_THRESHOLD
  );
}

/**
 * Format a message timestamp for a chat log.
 *
 * Same calendar day (local time) → "HH:MM". A different day → "MM/DD HH:MM"
 * (no i18n — the numeric form reads the same across locales). Invalid or
 * missing input → "" so callers can render unconditionally and omit the
 * span when there is nothing to show. Intentionally does NOT reuse the
 * sidebar's relative-time `formatSessionTime`; chat logs want absolute
 * clock times, not "2h ago".
 */
export function formatMessageTime(timestampMs) {
  // null / undefined must short-circuit before Number(): Number(null) === 0
  // is a finite value and would otherwise render the epoch as a real time.
  if (timestampMs == null) return "";
  const ms = Number(timestampMs);
  if (!Number.isFinite(ms)) return "";
  const date = new Date(ms);
  // Number.isFinite(1e20) passes, but new Date(1e20) is invalid (getTime → NaN).
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay) return hhmm;
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${hhmm}`;
}

/**
 * Format a response duration (ms) for the message footer, e.g. "3.2s" or
 * "1m 05s". Picot times generation client-side (message_start → message_end);
 * pi's runtime events carry no duration field of their own. Returns "" for
 * missing/invalid input so callers can render unconditionally.
 */
export function formatDurationLabel(durationMs) {
  // null / undefined must short-circuit before Number(): Number(null) === 0
  // is a finite value and would otherwise render a fake "0.0s" duration.
  if (durationMs == null) return "";
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Full timestamp for the hover `title` (screen-reader / exact reference). */
function fullTimestampTitle(timestampMs) {
  const ms = Number(timestampMs);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export class MessageRenderer {
  constructor(container, { sessionTreeActions = false } = {}) {
    this.container = container;
    // Session-tree actions (Fork/Edit) need a persisted session tree behind
    // the message list; ephemeral or detached views render no inert controls.
    this.sessionTreeActions = sessionTreeActions;
    this.isNearBottom = true;
    this.lastWelcomeOptions = null;
    this._destroyed = false;

    initImageLightbox(this.container);

    this._scrollHandler = () => {
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <=
        AUTO_SCROLL_BOTTOM_TOLERANCE;
    };
    this.container.addEventListener("scroll", this._scrollHandler);

    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.container) return;
      this.container.querySelectorAll(".message-copy-btn").forEach((btn) => {
        btn.setAttribute("aria-label", t("messages.copyMessage"));
        btn.title = t("messages.copyMessage");
      });
      this.container.querySelectorAll(".message-user-collapse-toggle").forEach((btn) => {
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.textContent = t(expanded ? "messages.collapse" : "messages.expand");
      });
      this.container.querySelectorAll(".thinking-label-text").forEach((el) => {
        el.textContent = t("messages.thinking");
      });
      if (this.container.querySelector(".welcome")) {
        this.renderWelcome(this.lastWelcomeOptions || {});
      }
    });
  }

  clear() {
    if (!this.container) return;
    this.container.replaceChildren();
    this.isNearBottom = true;
  }

  clearSearchHighlights() {
    const marks = this.container.querySelectorAll("mark[data-search-highlight='true']");
    marks.forEach((mark) => {
      const text = document.createTextNode(mark.textContent || "");
      mark.replaceWith(text);
      text.parentNode?.normalize();
    });
  }

  highlightSearchQuery(query, { scrollToFirst = true } = {}) {
    this.clearSearchHighlights();

    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (!normalizedQuery) return 0;

    const pattern = new RegExp(this.escapeRegExp(normalizedQuery), "gi");
    let matchCount = 0;
    let firstMatch = null;

    this.container.querySelectorAll(".message-content").forEach((content) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest("mark[data-search-highlight='true']")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textNodes = [];
      let currentNode = walker.nextNode();
      while (currentNode) {
        textNodes.push(currentNode);
        currentNode = walker.nextNode();
      }

      textNodes.forEach((node) => {
        const count = this.highlightTextNode(node, pattern, (mark) => {
          if (!firstMatch) firstMatch = mark;
        });
        matchCount += count;
      });
    });

    if (scrollToFirst && firstMatch && typeof firstMatch.scrollIntoView === "function") {
      firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    return matchCount;
  }

  renderWelcome({ workspacePath } = {}) {
    this.lastWelcomeOptions = { workspacePath };
    const welcome = document.createElement("div");
    welcome.className = "welcome";

    const icon = document.createElement("div");
    icon.className = "welcome-icon";
    const logo = document.createElement("img");
    logo.src = "icons/logo-dark.svg";
    logo.alt = "Picot logo";
    logo.className = "tau-icon-welcome";
    icon.appendChild(logo);
    welcome.appendChild(icon);

    welcome.appendChild(this._textElement("p", t("app.welcome")));
    welcome.appendChild(this._textElement("p", t("app.welcomeHint"), "hint"));
    if (workspacePath) {
      const workspace = document.createElement("p");
      workspace.className = "hint welcome-workspace";
      workspace.appendChild(document.createTextNode(`${t("app.currentWorkspace")} `));
      const code = document.createElement("code");
      code.textContent = workspacePath;
      workspace.appendChild(code);
      welcome.appendChild(workspace);
    }

    const shortcuts = document.createElement("div");
    shortcuts.className = "shortcuts-hint";
    shortcuts.setAttribute("aria-label", t("migrated.index.ariaLabel.keyboardShortcuts"));
    const focusShortcut = this._textElement("span", "");
    this._appendMarkup(focusShortcut, `<kbd>/</kbd> ${this.escapeHtml(t("shortcuts.focusInput"))}`);
    const abortShortcut = this._textElement("span", "");
    this._appendMarkup(abortShortcut, `<kbd>Esc</kbd> ${this.escapeHtml(t("shortcuts.abort"))}`);
    shortcuts.append(focusShortcut, abortShortcut);
    welcome.appendChild(shortcuts);
    this.container.replaceChildren(welcome);
  }

  renderUserMessage(message, isHistory = false, { entryId = null } = {}) {
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message user${isHistory ? " history" : ""}`;

    const imageItems = this._collectImageItems(message);
    const content = document.createElement("div");
    content.className = "message-content";
    if (imageItems.length > 0) {
      const images = document.createElement("div");
      images.className = "message-images";
      for (const image of imageItems) {
        const imageElement = document.createElement("img");
        imageElement.className = "message-image";
        imageElement.src = this._imageSource(image);
        imageElement.alt = t("messages.attachedImage");
        images.appendChild(imageElement);
      }
      content.appendChild(images);
    }

    const rawContent = this._textContentFromMessageContent(message.content);
    const displayContent = cleanChatTranscript(rawContent) ?? rawContent;
    this._appendMarkup(content, renderUserMarkdown(displayContent));
    div.appendChild(content);

    const collapseToggle = this._createUserCollapseToggle(content, displayContent);
    const footer = document.createElement("div");
    footer.className = "message-footer";
    // Fixed user order (v3 2026-08-21 design): Expand → Fork → Edit → Copy →
    // Timestamp. Fork/Edit are session-tree actions gated to persisted trees;
    // the toolbar is always visible (no hover reveal).
    if (collapseToggle) footer.appendChild(collapseToggle);
    if (this.sessionTreeActions) {
      const actionText = typeof message.content === "string" ? message.content : "";
      footer.appendChild(this._createUserActionButton("fork", actionText));
      footer.appendChild(this._createUserActionButton("edit", actionText));
    }
    footer.appendChild(this._createCopyButton());
    const timeSpan = this._createTimeSpan(message.timestamp);
    if (timeSpan) footer.appendChild(timeSpan);
    const forkEntryId = resolveMessageEntryId(message, entryId);
    if (forkEntryId) {
      div.dataset.entryId = forkEntryId;
    }
    div.appendChild(footer);

    this.container.appendChild(div);
    this._setupCodeCopyButtons(div);
    this._setupCopyBtn(div);
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false, targetContainer = null) {
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message assistant${isHistory ? " history" : ""}`;
    div.dataset.messageId = message.id || "streaming";
    // Jump targets for the Info panel. Process-group fragments share a
    // parent assistant entry; only the visible answer (or unterminated
    // leading text) should carry the session-tree id.
    const isProcessMessage = targetContainer !== null;
    const assistantEntryId = resolveMessageEntryId(message);
    if (assistantEntryId && !isProcessMessage) {
      div.dataset.entryId = assistantEntryId;
    }

    let contentHtml = "";
    let usageHtml = "";
    let rawStreamingText = "";
    let hasThinking = false;

    if (typeof message.content === "string") {
      rawStreamingText = message.content;
      contentHtml = isStreaming
        ? renderStreamingMarkdown(message.content)
        : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block) continue;
        if (block.type === "text") {
          rawStreamingText += block.text;
          contentHtml += isStreaming
            ? renderStreamingMarkdown(block.text)
            : renderMarkdown(block.text);
        } else if (block.type === "thinking") {
          hasThinking = true;
          contentHtml += this.renderThinkingBlock(block.thinking, message.usage?.cost?.total);
        }
      }
    }

    if (isStreaming) {
      div._streamingRawText = rawStreamingText;
    }

    const hasText = rawStreamingText.trim().length > 0;
    if (!isProcessMessage && message.usage?.cost && !hasThinking) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }
    const timeLabel = formatMessageTime(message.timestamp);
    const timeHtml = timeLabel
      ? `<span class="message-time" title="${this.escapeHtml(fullTimestampTitle(message.timestamp))}">${timeLabel}</span>`
      : "";

    const streamingClass = isStreaming ? " streaming" : "";

    if (!isStreaming && isHistory && !contentHtml) return null;

    const showFooter = !isStreaming && !isProcessMessage && (hasText || usageHtml);
    const footerHtml = showFooter
      ? `<div class="message-footer">${hasText ? `<button class="message-copy-btn" aria-label="${this.escapeHtml(t("messages.copyMessage"))}" title="${this.escapeHtml(t("messages.copyMessage"))}">${COPY_ICON}</button>` : ""}${timeHtml}${usageHtml}</div>`
      : "";

    this._replaceMarkup(
      div,
      `<div class="message-content${streamingClass}">${contentHtml}</div>${footerHtml}`,
    );

    this._setupThinkingToggles(div);
    this._setupCodeCopyButtons(div);
    if (!isStreaming && hasText && !isProcessMessage) this._setupCopyBtn(div);
    (targetContainer || this.container).appendChild(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking, cost) {
    const costHtml = this._thinkingCostHtml(cost);
    return `<div class="thinking-block"><div class="thinking-toggle" data-thinking-toggle="true" role="button" tabindex="0"><span class="chevron">${CHEVRON_ICON}</span><span class="thinking-label">${BRAIN_ICON} <span class="thinking-label-text">${this.escapeHtml(t("messages.thinking"))}</span></span>${costHtml}</div><div class="thinking-content">${this.escapeHtml(thinking)}</div></div>`;
  }

  _thinkingCostHtml(cost) {
    if (!(cost > 0)) return "";
    return `<span class="thinking-usage" title="Total cost for this response">$${cost.toFixed(4)}</span>`;
  }

  _setupThinkingToggles(root) {
    root.querySelectorAll(".thinking-label-text").forEach((label) => {
      label.textContent = t("messages.thinking");
    });
    root.querySelectorAll("[data-thinking-toggle]").forEach((toggle) => {
      if (toggle.dataset.bound === "true") return;
      const toggleThinking = () => {
        const block = toggle.closest(".thinking-block");
        const content = block?.querySelector(".thinking-content");
        content?.classList.toggle("expanded");
        toggle.classList.toggle("expanded");
      };
      toggle.addEventListener("click", toggleThinking);
      toggle.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleThinking();
        }
      });
      toggle.dataset.bound = "true";
    });
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector(".streaming-thinking");
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector(".message-content");
      if (!contentDiv) return;
      thinkingDiv = document.createElement("div");
      thinkingDiv.className = "thinking-block streaming-thinking";
      this._appendMarkup(
        thinkingDiv,
        `<div class="thinking-toggle expanded" data-thinking-toggle="true" role="button" tabindex="0"><span class="chevron">${CHEVRON_ICON}</span><span class="thinking-label">${BRAIN_ICON} <span class="thinking-label-text">${this.escapeHtml(t("messages.thinking"))}</span></span></div><div class="thinking-content expanded"></div>`,
      );
      contentDiv.prepend(thinkingDiv);
      this._setupThinkingToggles(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector(".thinking-content");
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector(".message-content");
    if (!contentDiv) return;

    const { text, thinking } = this.splitStreamingContent(content);

    if (thinking) this.updateStreamingThinking(messageElement, thinking);

    // Only overwrite the accumulated raw text when the update actually contains
    // text content. If the final message_end event carries only tool_use blocks
    // (no text), we must keep the text that streamed in earlier so that
    // finalizeStreamingMessage can re-render it correctly.
    if (text) messageElement._streamingRawText = text;
    const thinkingBlock = contentDiv.querySelector(".streaming-thinking");
    const rendered = renderStreamingMarkdown(text);
    if (thinkingBlock) {
      let textNode = contentDiv.querySelector(".streaming-text");
      if (!textNode) {
        textNode = document.createElement("div");
        textNode.className = "streaming-text";
        contentDiv.appendChild(textNode);
      }
      this._replaceMarkup(textNode, text ? rendered : textNode.innerHTML);
    } else if (text) {
      this._replaceMarkup(contentDiv, rendered);
    }
    this._setupCodeCopyButtons(contentDiv);
    this.scrollToBottom();
  }

  splitStreamingContent(content) {
    if (typeof content === "string") return { text: content, thinking: "" };
    if (!Array.isArray(content)) return { text: "", thinking: "" };
    let text = "";
    let thinking = "";
    for (const block of content) {
      if (block?.type === "text") text += block.text ?? "";
      else if (block?.type === "thinking") thinking += block.thinking ?? "";
    }
    return { text, thinking };
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = "", durationMs = null) {
    const contentDiv = messageElement.querySelector(".message-content");
    let finalThinking = "";
    if (contentDiv) {
      contentDiv.classList.remove("streaming");
      const streamingText = contentDiv.querySelector(".streaming-text");
      const domText = streamingText ? streamingText.textContent : contentDiv.textContent;
      const rawText =
        typeof messageElement._streamingRawText === "string"
          ? messageElement._streamingRawText
          : domText;
      messageElement._streamingRawText = null;

      finalThinking =
        thinking ||
        contentDiv.querySelector(".streaming-thinking .thinking-content")?.textContent ||
        "";

      let html = "";
      if (finalThinking) {
        html += this.renderThinkingBlock(finalThinking, usage?.cost?.total);
      }
      html += renderMarkdown(rawText);
      this._replaceMarkup(contentDiv, html);
      this._setupThinkingToggles(contentDiv);
      this._setupCodeCopyButtons(contentDiv);
    }

    if (!messageElement.querySelector(".message-footer")) {
      const copyableText = this.getCopyableText(messageElement);
      const hasUsage = Boolean(usage?.cost && usage.cost.total > 0 && !finalThinking);
      if (!copyableText && !hasUsage) {
        messageElement.remove();
        return;
      }

      const footer = document.createElement("div");
      footer.className = "message-footer";

      if (copyableText) footer.appendChild(this._createCopyButton());

      const timeSpan = this._createTimeSpan(Date.now());
      if (timeSpan) footer.appendChild(timeSpan);

      const durationSpan = this._createDurationSpan(durationMs);
      if (durationSpan) footer.appendChild(durationSpan);

      if (hasUsage) {
        const span = document.createElement("span");
        span.className = "message-usage";
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        footer.appendChild(span);
      }

      messageElement.appendChild(footer);
      this._setupCopyBtn(messageElement);
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "system-message";
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement("div");
    div.className = "error-message";
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  /**
   * Fork / Edit action for user messages (Pi-native /fork and /tree-select
   * entry points). The buttons dispatch bubbling `messagefork` /
   * `messageedit` CustomEvents carrying the Pi entry id (resolved from the
   * nearest [data-entry-id] anchor at click time) and the original prompt
   * text. App.js owns the transport calls; the renderer stays presentational.
   */
  _createUserActionButton(kind, actionText) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `message-action message-${kind}-btn`;
    button.setAttribute(
      "aria-label",
      t(kind === "fork" ? "messages.forkSession" : "messages.editMessage"),
    );
    button.title = t(kind === "fork" ? "messages.forkSession" : "messages.editMessage");
    const icon = createIcon(kind === "fork" ? "git-branch" : "pencil", { size: 12 });
    if (icon) button.appendChild(icon);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const entryId = button.closest("[data-entry-id]")?.dataset.entryId || null;
      button.dispatchEvent(
        new CustomEvent(kind === "fork" ? "messagefork" : "messageedit", {
          bubbles: true,
          detail: { entryId, text: actionText },
        }),
      );
    });
    return button;
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector(".message-copy-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const text = this.getCopyableText(messageEl);
      if (!text) return;
      const copyText = (value) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(value);
        const ta = document.createElement("textarea");
        ta.value = value;
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add("copied");
        setTimeout(() => {
          btn.classList.remove("copied");
        }, 1500);
      });
    });
  }

  getCopyableText(messageEl) {
    const content = messageEl.querySelector(".message-content");
    if (!content) return "";
    const clone = content.cloneNode(true);
    clone.querySelectorAll(".thinking-block, .streaming-thinking").forEach((el) => {
      el.remove();
    });
    return (clone.textContent || "").trim();
  }

  _textElement(tagName, text, className = "") {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  /** Timestamp span for the message footer; null when there is no valid time. */
  _createTimeSpan(timestampMs) {
    const label = formatMessageTime(timestampMs);
    if (!label) return null;
    const span = document.createElement("span");
    span.className = "message-time";
    span.textContent = label;
    const title = fullTimestampTitle(timestampMs);
    if (title) span.title = title;
    return span;
  }

  /** Response-time span for the assistant footer; null when there's no duration to show. */
  _createDurationSpan(durationMs) {
    const label = formatDurationLabel(durationMs);
    if (!label) return null;
    const span = document.createElement("span");
    span.className = "message-duration";
    span.textContent = label;
    span.title = t("messages.responseTime");
    return span;
  }

  /** Create the expand/collapse control for long user prompts. */
  _createUserCollapseToggle(contentEl, rawContent) {
    if (!shouldCollapseUserMessage(rawContent)) return null;

    contentEl.classList.add("user-message-collapsible");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-user-collapse-toggle";
    button.textContent = t("messages.expand");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => {
      const expanded = contentEl.classList.toggle("expanded");
      button.setAttribute("aria-expanded", String(expanded));
      button.textContent = t(expanded ? "messages.collapse" : "messages.expand");
    });
    return button;
  }

  _createCopyButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-copy-btn";
    button.setAttribute("aria-label", t("messages.copyMessage"));
    button.title = t("messages.copyMessage");
    this._appendMarkup(button, COPY_ICON);
    return button;
  }

  _collectImageItems(message) {
    const imageItems = [];
    if (message.images?.length > 0) imageItems.push(...message.images);
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "image" && block.data) imageItems.push(block);
      }
    }
    if (message.attachments?.length > 0) {
      for (const attachment of message.attachments) {
        if (attachment.type === "image" && attachment.content) {
          imageItems.push({ data: attachment.content, mimeType: attachment.mimeType });
        }
      }
    }
    return imageItems;
  }

  _textContentFromMessageContent(content) {
    if (!Array.isArray(content)) return content;
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
  }

  _imageSource(image) {
    const data = typeof image?.data === "string" ? image.data : "";
    if (/^data:image\/(?:png|jpe?g|gif|webp);base64,/i.test(data)) return data;
    const mime = /^image\/(?:png|jpe?g|gif|webp)$/i.test(image?.mimeType || "")
      ? image.mimeType
      : "image/png";
    return `data:${mime};base64,${data}`;
  }

  _appendMarkup(parent, markup) {
    const parsed = new DOMParser().parseFromString(String(markup || ""), "text/html");
    this._sanitizeMarkup(parsed.body);
    parent.append(...Array.from(parsed.body.childNodes));
  }

  _replaceMarkup(parent, markup) {
    parent.replaceChildren();
    this._appendMarkup(parent, markup);
  }

  _sanitizeMarkup(root) {
    sanitizeMarkup(root);
  }

  _setupCodeCopyButtons(root) {
    root.querySelectorAll(".copy-btn").forEach((button) => {
      if (button.dataset.bound === "true") return;
      button.addEventListener("click", () => {
        const code = button.closest(".code-block-wrapper")?.querySelector("code");
        if (!code) return;
        const copy = (text) => {
          if (navigator.clipboard) return navigator.clipboard.writeText(text);
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.cssText = "position:fixed;left:-9999px";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
          return Promise.resolve();
        };
        copy(code.textContent || "").then(() => {
          button.textContent = t("messages.copied");
          button.classList.add("copied");
          setTimeout(() => {
            button.textContent = t("messages.copy");
            button.classList.remove("copied");
          }, 2000);
        });
      });
      button.dataset.bound = "true";
    });
  }

  highlightTextNode(node, pattern, onMatch) {
    const text = node.textContent || "";
    const regex = new RegExp(pattern.source, pattern.flags);
    let lastIndex = 0;
    let matchCount = 0;
    let match = regex.exec(text);
    if (!match) return 0;

    const fragment = document.createDocumentFragment();
    while (match) {
      const [matchedText] = match;
      const start = match.index;
      if (start > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      }

      const mark = document.createElement("mark");
      mark.dataset.searchHighlight = "true";
      mark.textContent = matchedText;
      fragment.appendChild(mark);
      if (typeof onMatch === "function") onMatch(mark);

      matchCount += 1;
      lastIndex = start + matchedText.length;
      match = regex.exec(text);
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.replaceWith(fragment);
    return matchCount;
  }

  escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  escapeHtml(text) {
    return String(text ?? "").replace(/[&<>"']/g, (character) => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      };
      return entities[character];
    });
  }

  scrollToBottom() {
    if (this.isNearBottom && this.container) {
      this.forceScrollToBottom();
    }
  }

  forceScrollToBottom() {
    requestAnimationFrame(() => {
      if (this.container) this.container.scrollTop = this.container.scrollHeight;
    });
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (this.container && this._scrollHandler) {
      this.container.removeEventListener("scroll", this._scrollHandler);
    }
    if (typeof this.unsubscribeLocaleChange === "function") {
      this.unsubscribeLocaleChange();
      this.unsubscribeLocaleChange = null;
    }
    this._scrollHandler = null;
    this.container = null;
  }
}
