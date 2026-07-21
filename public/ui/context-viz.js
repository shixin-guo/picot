import { t } from "../i18n.js";

export function setupContextViz({
  tokenUsageEl,
  contextViz,
  contextBar,
  contextLegend,
  contextVizUsed,
  contextVizTotal,
  getUsage,
  getContextWindowSize,
}) {
  function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function updateContextViz() {
    const lastUsage = getUsage();
    const contextWindowSize = getContextWindowSize();
    if (!lastUsage || !contextWindowSize) return;

    const input = lastUsage.input || 0;
    const cacheRead = lastUsage.cacheRead || 0;
    const total = contextWindowSize;
    const freshInput = input;
    const totalUsed = freshInput + cacheRead;
    const free = Math.max(0, total - totalUsed);

    const segments = [
      { key: "cache", label: t("context.cached"), tokens: cacheRead, color: "cache" },
      { key: "messages", label: t("context.input"), tokens: freshInput, color: "messages" },
      { key: "free", label: t("context.available"), tokens: free, color: "free" },
    ];

    contextBar.innerHTML = "";
    for (const seg of segments) {
      if (seg.tokens <= 0) continue;
      const pct = (seg.tokens / total) * 100;
      const el = document.createElement("div");
      el.className = `context-bar-segment ${seg.color}`;
      el.style.width = `${pct}%`;
      el.title = t("context.tooltip", { label: seg.label, tokens: formatTokens(seg.tokens) });
      contextBar.appendChild(el);
    }

    contextLegend.innerHTML = "";
    for (const seg of segments) {
      const item = document.createElement("div");
      item.className = "context-legend-item";
      item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
      contextLegend.appendChild(item);
    }

    const pct = Math.round((totalUsed / total) * 100);
    contextVizUsed.textContent = t("context.used", { pct });
    contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
  }

  // Portal the popover to <body> so it escapes the header's stacking context
  // (z-index: 10). Without this, the file preview panel covers it. We move
  // the element once at setup and re-position it with fixed coordinates on
  // every open so it tracks the button even if the header layout shifts.
  if (contextViz.parentElement && contextViz.parentElement !== document.body) {
    document.body.appendChild(contextViz);
  }

  function positionAndShow() {
    const rect = tokenUsageEl.getBoundingClientRect();
    contextViz.style.position = "fixed";
    contextViz.style.top = `${rect.bottom + 8}px`;
    // Right-align the popover's right edge with the button's right edge.
    contextViz.style.right = `${window.innerWidth - rect.right}px`;
    contextViz.style.left = "auto";
    contextViz.classList.remove("hidden");
  }

  tokenUsageEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = contextViz.classList.contains("hidden");
    if (isHidden) {
      updateContextViz();
      positionAndShow();
    } else {
      contextViz.classList.add("hidden");
    }
  });

  document.addEventListener("click", (e) => {
    if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
      contextViz.classList.add("hidden");
    }
  });

  _updateFn = updateContextViz;

  // Compact button inside the context-viz dialog. Calls Pi's /compact
  // command and hides the popover; the next token-usage update re-opens it
  // if the user clicks the pill again.
  const compactBtn = document.getElementById("context-viz-compact");
  if (compactBtn) {
    compactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      contextViz.classList.add("hidden");
      // Defer to the global rpcCommand so status text and i18n are handled
      // by the same path as the Commands menu entry.
      const rpc = window.__picotRpcCommand;
      if (typeof rpc === "function") {
        rpc({ type: "compact" }, t("status.compacting"));
      } else {
        fetch("/api/rpc", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "compact" }),
        });
      }
    });
  }
}

let _updateFn = null;

export function repaintContextViz() {
  _updateFn?.();
}
