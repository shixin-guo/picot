// ABOUTME: Renders collapsible tool execution cards and their streaming output.
// ABOUTME: Uses container-level event delegation so dynamically added cards need no per-element listeners.

const SVG_NS = "http://www.w3.org/2000/svg";

import { onLocaleChange, t } from "../i18n.js";

export class ToolCardRenderer {
  constructor(container) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
    this._destroyed = false;

    // Toggle header expand/collapse via event delegation. A single listener on
    // the container handles every card, including ones added later for history.
    this._onContainerClickToggle = (e) => {
      const header = e.target.closest(".tool-card-header");
      if (!header) return;
      // Don't toggle when clicking action buttons inside the header
      if (e.target.closest(".tool-action-btn")) return;
      const card = header.closest(".tool-card");
      if (!card) return;
      card.querySelector(".tool-card-body")?.classList.toggle("expanded");
      header.querySelector(".tool-card-chevron")?.classList.toggle("expanded");
    };

    // Copy output via event delegation, with a legacy execCommand fallback for
    // contexts where the async Clipboard API is unavailable.
    this._onContainerClickCopy = (e) => {
      const btn = e.target.closest(".copy-output-btn");
      if (!btn) return;
      e.stopPropagation();
      const output = btn.closest(".tool-card")?.querySelector(".tool-output");
      const text = output?.textContent?.trim();
      if (!text) return;
      const copy = navigator.clipboard?.writeText
        ? navigator.clipboard.writeText(text)
        : new Promise((resolve) => {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.cssText = "position:fixed;left:-9999px";
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand("copy");
            textarea.remove();
            resolve();
          });
      copy.then(() => {
        btn.classList.add("copied");
        setTimeout(() => btn.classList.remove("copied"), 1500);
      });
    };

    this.container.addEventListener("click", this._onContainerClickToggle);
    this.container.addEventListener("click", this._onContainerClickCopy);

    // Re-localize rendered status text and copy-button labels on locale change.
    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.container) return;
      for (const el of this.container.querySelectorAll(".tool-status[data-status]")) {
        el.textContent = t(`tools.${el.dataset.status}`);
      }
      for (const el of this.container.querySelectorAll(".copy-output-btn")) {
        const label = t("tools.copyOutput");
        el.title = label;
        el.setAttribute("aria-label", label);
      }
    });
  }

  createToolCard(toolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;

    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolCallId = toolCallId;

    const argsPreview = this.getArgsPreview(toolName, args);
    const argsJson = this.formatJson(args);
    const isExpanded = status === "streaming" || status === "pending";

    const isEdit =
      (toolName === "edit" || toolName === "Edit") &&
      args &&
      (args.oldText || args.old_text) &&
      (args.newText || args.new_text);

    const header = document.createElement("div");
    header.className = "tool-card-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "tool-header-left";
    const chevron = this._createChevron(isExpanded);
    headerLeft.appendChild(chevron);

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = toolName;
    headerLeft.appendChild(name);
    if (argsPreview) {
      const preview = document.createElement("span");
      preview.className = "tool-args-preview";
      preview.textContent = argsPreview;
      headerLeft.appendChild(preview);
    }
    header.appendChild(headerLeft);

    const headerRight = document.createElement("div");
    headerRight.className = "tool-header-right";
    headerRight.appendChild(this._createCopyButton());

    const statusElement = document.createElement("div");
    statusElement.className = `tool-status ${status}`;
    statusElement.dataset.status = status;
    statusElement.textContent = t(`tools.${status}`);
    headerRight.appendChild(statusElement);
    header.appendChild(headerRight);

    const body = document.createElement("div");
    body.className = `tool-card-body${isExpanded ? " expanded" : ""}`;
    if (isEdit) {
      body.appendChild(
        this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text),
      );
    } else if (argsJson) {
      const argsElement = document.createElement("div");
      argsElement.className = "tool-args";
      argsElement.textContent = argsJson;
      body.appendChild(argsElement);
    }
    const outputWrapper = document.createElement("div");
    outputWrapper.className = "tool-output-wrapper";
    const output = document.createElement("div");
    output.className = "tool-output";
    outputWrapper.appendChild(output);
    body.appendChild(outputWrapper);

    card.append(header, body);
    this.container.appendChild(card);
    this.toolCards.set(toolCallId, card);
    this.scrollToBottom();

    return card;
  }

  _createChevron(expanded = false) {
    const chevron = document.createElement("span");
    chevron.className = `tool-card-chevron${expanded ? " expanded" : ""}`;
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "8");
    svg.setAttribute("height", "8");
    svg.setAttribute("viewBox", "0 0 8 8");
    svg.setAttribute("fill", "currentColor");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M2 1l4 3-4 3z");
    svg.appendChild(path);
    chevron.appendChild(svg);
    return chevron;
  }

  _createCopyButton() {
    const copyButton = document.createElement("button");
    copyButton.className = "tool-action-btn copy-output-btn";
    const label = t("tools.copyOutput");
    copyButton.title = label;
    copyButton.setAttribute("aria-label", label);

    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [name, value] of [
      ["width", "13"],
      ["height", "13"],
      ["viewBox", "0 0 24 24"],
      ["fill", "none"],
      ["stroke", "currentColor"],
      ["stroke-width", "2"],
      ["stroke-linecap", "round"],
      ["stroke-linejoin", "round"],
    ]) {
      svg.setAttribute(name, value);
    }
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", "14");
    rect.setAttribute("height", "14");
    rect.setAttribute("x", "8");
    rect.setAttribute("y", "8");
    rect.setAttribute("rx", "2");
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2");
    svg.append(rect, path);
    copyButton.appendChild(svg);
    // Click handling is delegated to the container listener; no per-button
    // listener is needed here.
    return copyButton;
  }

  updateToolCard(toolExecution) {
    let card = this.toolCards.get(toolExecution.toolCallId);

    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    // Update status
    const statusElement = card.querySelector(".tool-status");
    if (statusElement) {
      statusElement.className = `tool-status ${toolExecution.status}`;
      statusElement.dataset.status = toolExecution.status;
      statusElement.textContent = t(`tools.${toolExecution.status}`);
    }

    // Auto-expand when streaming
    if (toolExecution.status === "streaming") {
      const body = card.querySelector(".tool-card-body");
      const chevron = card.querySelector(".tool-card-chevron");
      if (body) body.classList.add("expanded");
      if (chevron) chevron.classList.add("expanded");
    }

    // Update output
    const outputElement = card.querySelector(".tool-output");
    if (outputElement && toolExecution.output) {
      outputElement.textContent = toolExecution.output;
      this.scrollToBottom();
    }
  }

  finalizeToolCard(toolCallId, result, isError) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    // Update status
    const statusElement = card.querySelector(".tool-status");
    if (statusElement) {
      const status = isError ? "error" : "complete";
      statusElement.className = `tool-status ${status}`;
      statusElement.dataset.status = status;
      statusElement.textContent = t(`tools.${status}`);
    }

    // Update output with final result
    const outputElement = card.querySelector(".tool-output");
    if (outputElement && result) {
      const output = this.formatResult(result);
      outputElement.textContent = output;
    }

    // Collapse completed cards (less noise)
    if (!isError) {
      const body = card.querySelector(".tool-card-body");
      const chevron = card.querySelector(".tool-card-chevron");
      if (body) body.classList.remove("expanded");
      if (chevron) chevron.classList.remove("expanded");
    }
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolCallId = toolCallId;

    // Header
    const header = document.createElement("div");
    header.className = "tool-card-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "tool-header-left";

    const chevron = this._createChevron();
    headerLeft.appendChild(chevron);

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = toolName;
    headerLeft.appendChild(name);

    const preview = this.getArgsPreview(toolName, args);
    if (preview) {
      const previewEl = document.createElement("span");
      previewEl.className = "tool-args-preview";
      previewEl.textContent = preview;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: copy button + status
    const headerRight = document.createElement("div");
    headerRight.className = "tool-header-right";

    const copyBtn = this._createCopyButton();
    headerRight.appendChild(copyBtn);

    const status = document.createElement("div");
    status.className = "tool-status complete";
    status.dataset.status = "complete";
    status.textContent = t("tools.complete");
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    card.appendChild(header);

    // Body (collapsed by default)
    const body = document.createElement("div");
    body.className = "tool-card-body";

    const isEdit =
      (toolName === "edit" || toolName === "Edit") &&
      args &&
      (args.oldText || args.old_text) &&
      (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(
        this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text),
      );
    } else {
      const argsJson = this.formatJson(args);
      if (argsJson) {
        const argsEl = document.createElement("div");
        argsEl.className = "tool-args";
        argsEl.textContent = argsJson;
        body.appendChild(argsEl);
      }
    }

    const outputEl = document.createElement("div");
    outputEl.className = "tool-output";
    body.appendChild(outputEl);

    card.appendChild(body);

    this.container.appendChild(card);
    this.toolCards.set(toolCallId, card);

    return card;
  }

  /**
   * Add result to a history card (stays collapsed)
   */
  addHistoryResult(toolCallId, result, isError) {
    const card = this.toolCards.get(toolCallId);
    if (!card) return;

    if (isError) {
      const statusEl = card.querySelector(".tool-status");
      if (statusEl) {
        statusEl.className = "tool-status error";
        statusEl.dataset.status = "error";
        statusEl.textContent = t("tools.error");
      }
    }

    const outputElement = card.querySelector(".tool-output");
    if (outputElement && result) {
      outputElement.textContent = this.formatResult(result);
    }
  }

  /** Compact preview for the header line */
  getArgsPreview(_toolName, args) {
    if (!args || Object.keys(args).length === 0) return "";

    // Show the most relevant arg inline
    if (args.path) return args.path;
    if (args.command) return args.command.substring(0, 80);
    if (args.query) return args.query.substring(0, 60);
    if (args.url) return args.url;

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === "string" && val.length > 0) {
        return val.substring(0, 60);
      }
    }
    return "";
  }

  formatJson(obj) {
    try {
      if (Object.keys(obj).length === 0) return "";
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  /** Render a simple inline diff for Edit tool */
  renderDiff(oldText, newText) {
    const container = document.createElement("div");
    container.className = "tool-diff";

    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    // Removed lines
    for (const line of oldLines) {
      const el = document.createElement("div");
      el.className = "diff-line diff-removed";
      el.textContent = `- ${line}`;
      container.appendChild(el);
    }

    // Added lines
    for (const line of newLines) {
      const el = document.createElement("div");
      el.className = "diff-line diff-added";
      el.textContent = `+ ${line}`;
      container.appendChild(el);
    }

    return container;
  }

  formatResult(result) {
    if (!result) return "";

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((block) => {
          if (block.type === "text") return block.text;
          return JSON.stringify(block);
        })
        .join("\n");
    }

    return JSON.stringify(result, null, 2);
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.container) {
      const threshold = 100;
      const isNear =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <
        threshold;
      if (isNear) {
        requestAnimationFrame(() => {
          if (!this.container) return;
          this.container.scrollTop = this.container.scrollHeight;
        });
      }
    }
  }

  expandAll() {
    this.toolCards.forEach((card) => {
      card.querySelector(".tool-card-body")?.classList.add("expanded");
      card.querySelector(".tool-card-chevron")?.classList.add("expanded");
    });
  }

  collapseAll() {
    this.toolCards.forEach((card) => {
      card.querySelector(".tool-card-body")?.classList.remove("expanded");
      card.querySelector(".tool-card-chevron")?.classList.remove("expanded");
    });
  }

  clear() {
    this.toolCards.forEach((card) => {
      card.remove();
    });
    this.toolCards.clear();
  }

  // Tear down the locale subscription and container listeners, drop tool-card
  // state, and release the container. Idempotent. clear() empties cards without
  // unsubscribing; destroy() is the full teardown used when a view is discarded.
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    if (typeof this.unsubscribeLocaleChange === "function") {
      this.unsubscribeLocaleChange();
      this.unsubscribeLocaleChange = null;
    }
    if (this.container) {
      this.container.removeEventListener("click", this._onContainerClickToggle);
      this.container.removeEventListener("click", this._onContainerClickCopy);
    }
    this._onContainerClickToggle = null;
    this._onContainerClickCopy = null;
    this.toolCards.clear();
    this.container = null;
  }
}
