// ABOUTME: Renders user and assistant chat messages for the Picot WebView.
// ABOUTME: Preserves renderer behavior while exposing user elements for navigation.
/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { onLocaleChange, t } from "./i18n.js";
import { renderMarkdown, renderStreamingMarkdown, renderUserMarkdown } from "./markdown.js";

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;
    this.lastWelcomeOptions = null;
    this._destroyed = false;

    // Track scroll position for smart auto-scroll. Store the handler so destroy()
    // can remove it; an anonymous listener would leak across view recreations.
    this._scrollHandler = () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <
        threshold;
    };
    this.container.addEventListener("scroll", this._scrollHandler);

    // Update already-rendered DOM when the locale changes without re-rendering
    // streaming content.
    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.container) return;
      this.container.querySelectorAll(".message-copy-btn").forEach((btn) => {
        btn.setAttribute("aria-label", t("messages.copyMessage"));
        btn.title = t("messages.copyMessage");
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
    // Session switches reuse the same renderer instance. If the previous session
    // left the viewport away from bottom, keep new renders from inheriting that
    // stale anchor state (which can suppress auto-scroll until the user scrolls).
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
    shortcuts.appendChild(this._textElement("span", `/ ${t("shortcuts.focusInput")}`));
    shortcuts.appendChild(this._textElement("span", `Esc ${t("shortcuts.abort")}`));
    welcome.appendChild(shortcuts);
    this.container.replaceChildren(welcome);
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message user${isHistory ? " history" : ""}`;

    const content = document.createElement("div");
    content.className = "message-content";
    if (message.images?.length > 0) {
      const images = document.createElement("div");
      images.className = "message-images";
      for (const image of message.images) {
        const imageElement = document.createElement("img");
        imageElement.className = "message-image";
        imageElement.src = this._imageSource(image);
        imageElement.alt = t("messages.attachedImage");
        images.appendChild(imageElement);
      }
      content.appendChild(images);
    }
    this._appendMarkup(content, renderUserMarkdown(message.content));
    div.appendChild(content);
    div.appendChild(this._createCopyButton());
    this.container.appendChild(div);
    this._setupCodeCopyButtons(div);
    this._setupCopyBtn(div);
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message assistant${isHistory ? " history" : ""}`;
    div.dataset.messageId = message.id || "streaming";

    let contentHtml = "";
    let usageHtml = "";
    let rawStreamingText = "";

    if (typeof message.content === "string") {
      rawStreamingText = message.content;
      contentHtml = isStreaming
        ? renderStreamingMarkdown(message.content)
        : renderMarkdown(message.content);
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === "text") {
          rawStreamingText += block.text;
          contentHtml += isStreaming
            ? renderStreamingMarkdown(block.text)
            : renderMarkdown(block.text);
        } else if (block.type === "thinking") {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }
    // Markdown is rendered live during streaming, so the raw text (with its
    // syntax markers) can't be recovered from the DOM at finalize time.
    if (isStreaming) {
      div._streamingRawText = rawStreamingText;
    }

    // Usage/cost info
    if (message.usage?.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const streamingClass = isStreaming ? " streaming" : "";

    const markup = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
      ${!isStreaming ? `<button class="message-copy-btn" aria-label="${this.escapeHtml(t("messages.copyMessage"))}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>` : ""}
    `;
    this._replaceMarkup(div, markup);

    this._setupThinkingToggles(div);
    this._setupCodeCopyButtons(div);
    if (!isStreaming) this._setupCopyBtn(div);
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    return `<div class="thinking-block">
<div class="thinking-toggle" data-thinking-toggle="true" role="button" tabindex="0">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> <span class="thinking-label-text">${this.escapeHtml(t("messages.thinking"))}</span></span>
</div>
<div class="thinking-content">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  _setupThinkingToggles(root) {
    root.querySelectorAll(".thinking-label-text").forEach((label) => {
      label.textContent = t("messages.thinking");
    });
    root.querySelectorAll("[data-thinking-toggle]").forEach((toggle) => {
      if (toggle.dataset.bound === "true") return;
      const toggleThinking = () => {
        toggle.nextElementSibling?.classList.toggle("expanded");
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
      const markup = `
        <div class="thinking-toggle expanded" data-thinking-toggle="true" role="button" tabindex="0">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 0 2.526 5.77 4 4 0 0 0-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> <span class="thinking-label-text"></span></span>
        </div>
        <div class="thinking-content expanded"></div>`;
      this._appendMarkup(thinkingDiv, markup);
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
    if (contentDiv) {
      messageElement._streamingRawText = content;
      // Keep any thinking block, update only the text part
      const thinkingBlock = contentDiv.querySelector(".streaming-thinking");
      const rendered = renderStreamingMarkdown(content);
      if (thinkingBlock) {
        // Remove everything after the thinking block and re-add text
        let textNode = contentDiv.querySelector(".streaming-text");
        if (!textNode) {
          textNode = document.createElement("div");
          textNode.className = "streaming-text";
          contentDiv.appendChild(textNode);
        }
        this._replaceMarkup(textNode, rendered);
      } else {
        this._replaceMarkup(contentDiv, rendered);
      }
      this._setupCodeCopyButtons(contentDiv);
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = "") {
    const contentDiv = messageElement.querySelector(".message-content");
    if (contentDiv) {
      contentDiv.classList.remove("streaming");
      // Prefer the raw text stashed during streaming — the DOM now holds
      // rendered markdown, so textContent has lost the syntax markers.
      const streamingText = contentDiv.querySelector(".streaming-text");
      const domText = streamingText ? streamingText.textContent : contentDiv.textContent;
      const rawText =
        typeof messageElement._streamingRawText === "string"
          ? messageElement._streamingRawText
          : domText;
      messageElement._streamingRawText = null;

      // Rebuild with thinking block (if any) + markdown text
      let html = "";
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += renderMarkdown(rawText);
      this._replaceMarkup(contentDiv, html);
      this._setupThinkingToggles(contentDiv);
      this._setupCodeCopyButtons(contentDiv);
    }

    // Add copy button after streaming finishes
    if (!messageElement.querySelector(".message-copy-btn")) {
      const btn = document.createElement("button");
      btn.className = "message-copy-btn";
      btn.setAttribute("aria-label", t("messages.copyMessage"));
      this._appendMarkup(
        btn,
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      );
      messageElement.appendChild(btn);
      this._setupCopyBtn(messageElement);
    }

    // Add usage info if available
    if (usage?.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector(".message-usage")) {
        const span = document.createElement("span");
        span.className = "message-usage";
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
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

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector(".message-copy-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const content = messageEl.querySelector(".message-content");
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement("textarea");
        ta.value = t;
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

  _textElement(tagName, text, className = "") {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  }

  _createCopyButton() {
    const button = document.createElement("button");
    button.className = "message-copy-btn";
    button.setAttribute("aria-label", t("messages.copyMessage"));
    this._appendMarkup(
      button,
      '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9v1"/></svg>',
    );
    return button;
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
    const blockedTags = new Set([
      "SCRIPT",
      "STYLE",
      "IFRAME",
      "OBJECT",
      "EMBED",
      "FOREIGNOBJECT",
      "ANIMATE",
      "SET",
      "USE",
    ]);
    root.querySelectorAll("*").forEach((element) => {
      if (blockedTags.has(element.tagName)) {
        element.remove();
        return;
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        if (
          name.startsWith("on") ||
          name === "srcdoc" ||
          name === "formaction" ||
          (name === "href" && !/^(https?:|mailto:|#)/i.test(value)) ||
          (name === "src" && !/^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp);)/i.test(value)) ||
          (name === "style" && /url\s*\(/i.test(value))
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    });
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
      requestAnimationFrame(() => {
        if (this.container) this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }

  // Tear down listeners and release the container reference. Idempotent:
  // hiding/deactivating a view must NOT destroy it; only an explicit destroy()
  // removes the scroll + locale listeners so a recreated view stays clean.
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
