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
      { key: "cache", label: "Cached", tokens: cacheRead, color: "cache" },
      { key: "messages", label: "Input", tokens: freshInput, color: "messages" },
      { key: "free", label: "Available", tokens: free, color: "free" },
    ];

    contextBar.innerHTML = "";
    for (const seg of segments) {
      if (seg.tokens <= 0) continue;
      const pct = (seg.tokens / total) * 100;
      const el = document.createElement("div");
      el.className = `context-bar-segment ${seg.color}`;
      el.style.width = `${pct}%`;
      el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
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
    contextVizUsed.textContent = `${pct}% used`;
    contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
  }

  tokenUsageEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = contextViz.classList.contains("hidden");
    if (isHidden) {
      updateContextViz();
      contextViz.classList.remove("hidden");
    } else {
      contextViz.classList.add("hidden");
    }
  });

  document.addEventListener("click", (e) => {
    if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
      contextViz.classList.add("hidden");
    }
  });
}
