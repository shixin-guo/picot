/**
 * Message Renderer - Renders chat messages with markdown support
 */

import {
  initCodeCopyDelegation,
  renderMarkdown,
  renderStreamingMarkdown,
  renderUserMarkdown,
} from "./markdown.js";

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
  // Match both old (with timestamp) and new (without) formats
  const lineRe = /^- (?:\[[\dT:.Z+-]+\] )?\[uid:[^\]]+\] ([^:]+): (.*)$/;
  const lines = text.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;
  const parsed = lines.map((l) => {
    const m = l.match(lineRe);
    return m ? { name: m[1].trim(), text: m[2] } : null;
  });
  if (parsed.some((p) => p === null)) return null; // mixed content – don't touch
  const names = [...new Set(parsed.map((p) => p.name))];
  // Single speaker: just show the text lines
  if (names.length === 1) {
    return parsed.map((p) => p.text).join("\n");
  }
  // Multiple speakers: show `name: text`
  return parsed.map((p) => `**${p.name}**: ${p.text}`).join("\n\n");
}

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;

    // Wire up code-block copy buttons via event delegation
    initCodeCopyDelegation(this.container);

    // Wire up thinking-block toggle buttons via event delegation
    this.container.addEventListener("click", (e) => {
      const toggle = e.target.closest("[data-thinking-toggle]");
      if (!toggle) return;
      const block = toggle.closest(".thinking-block");
      if (!block) return;
      const content = block.querySelector(".thinking-content");
      if (content) content.classList.toggle("expanded");
      toggle.classList.toggle("expanded");
    });

    // Track scroll position for smart auto-scroll
    this.container.addEventListener("scroll", () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <
        threshold;
    });
  }

  clear() {
    this.container.innerHTML = "";
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
    const workspaceHtml = workspacePath
      ? `<p class="hint welcome-workspace">Current workspace: <code>${this.escapeHtml(workspacePath)}</code></p>`
      : "";
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/logo-dark.svg" alt="Picot logo" class="tau-icon-welcome"></div>
        <p>Welcome to Picot</p>
        <p class="hint">Type a message below to start chatting with Pi, or select a session from the sidebar.</p>
        ${workspaceHtml}
        <div class="shortcuts-hint">
          <span>/ Focus input</span>
          <span>Esc Abort</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false, { entryId = null } = {}) {
    // Remove welcome message if present
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message user${isHistory ? " history" : ""}`;

    let imagesHtml = "";
    if (message.images && message.images.length > 0) {
      imagesHtml =
        '<div class="message-images">' +
        message.images
          .map((img) => {
            const src = img.data.startsWith("data:")
              ? img.data
              : `data:${img.mimeType || "image/png"};base64,${img.data}`;
            return `<img class="message-image" src="${src}" alt="Attached image" />`;
          })
          .join("") +
        "</div>";
    }

    const displayContent = cleanChatTranscript(message.content) ?? message.content;
    if (entryId) div.dataset.entryId = entryId;
    const forkBtnHtml = entryId
      ? `<button class="message-fork-btn" aria-label="Fork session from here" title="Fork session from here"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg></button>`
      : "";
    div.innerHTML = `
      <div class="message-content">${imagesHtml}${renderUserMarkdown(displayContent)}</div>
      <div class="message-footer"><button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>${forkBtnHtml}</div>
    `;
    this._setupCopyBtn(div);
    if (entryId) this._setupForkBtn(div);
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
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

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${!isStreaming ? `<div class="message-footer"><button class="message-copy-btn" aria-label="Copy message"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>${usageHtml}</div>` : ""}
    `;

    if (!isStreaming) this._setupCopyBtn(div);
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    // Returns an HTML string — callers concatenate it into contentHtml.
    // Click handling is wired via event delegation in initThinkingToggleDelegation.
    const chevronSvg = `<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M2 1l4 3-4 3z"/></svg>`;
    const brainSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px" aria-hidden="true"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg>`;
    return `<div class="thinking-block"><div class="thinking-toggle" data-thinking-toggle><span class="chevron">${chevronSvg}</span><span class="thinking-label">${brainSvg} Thinking</span></div><div class="thinking-content">${this.escapeHtml(thinking)}</div></div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector(".streaming-thinking");
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector(".message-content");
      if (!contentDiv) return;
      thinkingDiv = document.createElement("div");
      thinkingDiv.className = "thinking-block streaming-thinking";
      thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" data-thinking-toggle>
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
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
        textNode.innerHTML = rendered;
      } else {
        contentDiv.innerHTML = rendered;
      }
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
      contentDiv.innerHTML = html;
    }

    // Add footer (usage + copy button) after streaming finishes
    if (!messageElement.querySelector(".message-footer")) {
      const copyableText = this.getCopyableText(messageElement);
      const hasUsage = Boolean(usage?.cost && usage.cost.total > 0);
      if (!copyableText && !hasUsage) {
        messageElement.remove();
        return;
      }

      const footer = document.createElement("div");
      footer.className = "message-footer";

      if (copyableText) {
        const btn = document.createElement("button");
        btn.className = "message-copy-btn";
        btn.setAttribute("aria-label", "Copy message");
        btn.innerHTML =
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        footer.appendChild(btn);
      }

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

  _setupForkBtn(messageEl) {
    const btn = messageEl.querySelector(".message-fork-btn");
    if (!btn) return;
    const entryId = messageEl.dataset.entryId;
    if (!entryId) return;
    btn.addEventListener("click", () => {
      messageEl.dispatchEvent(
        new CustomEvent("messagefork", {
          bubbles: true,
          detail: { entryId },
        }),
      );
    });
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector(".message-copy-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const text = this.getCopyableText(messageEl);
      if (!text) return;
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

  getCopyableText(messageEl) {
    const content = messageEl.querySelector(".message-content");
    if (!content) return "";
    const copyContent = content.cloneNode(true);
    copyContent.querySelectorAll(".thinking-block").forEach((block) => {
      block.remove();
    });
    return copyContent.textContent.trim();
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
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
