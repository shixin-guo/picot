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
  if (!tokenUsageEl || !contextViz) {
    return {
      update: () => {},
      hide: () => {},
    };
  }

  function updateContextViz() {
    const lastUsage = getUsage?.();
    const contextWindowSize =
      Number(getContextWindowSize?.()) || Number(lastUsage?.contextWindow) || 0;
    if (!lastUsage || contextWindowSize <= 0) return;

    const input = Number(lastUsage.input) || 0;
    const cacheRead = Number(lastUsage.cacheRead) || 0;
    const total = contextWindowSize;
    const totalUsed = input + cacheRead;
    const free = Math.max(0, total - totalUsed);

    const segments = [
      { key: "cache", label: "Cached (reused)", tokens: cacheRead, color: "cache" },
      { key: "input", label: "Uncached", tokens: input, color: "input" },
      { key: "free", label: "Available", tokens: free, color: "free" },
    ];

    if (contextBar) {
      contextBar.innerHTML = "";
      for (const segment of segments) {
        if (segment.tokens <= 0) continue;
        const element = document.createElement("div");
        element.className = `context-bar-segment ${segment.color}`;
        element.style.width = `${(segment.tokens / total) * 100}%`;
        element.title = `${segment.label}: ${formatTokens(segment.tokens)}`;
        contextBar.appendChild(element);
      }
    }

    if (contextLegend) {
      contextLegend.innerHTML = "";
      for (const segment of segments) {
        const item = document.createElement("div");
        item.className = "context-legend-item";

        const left = document.createElement("span");
        left.className = "context-legend-left";

        const dot = document.createElement("span");
        dot.className = `context-legend-dot ${segment.color}`;
        left.append(dot, segment.label);

        const value = document.createElement("span");
        value.className = "context-legend-value";
        value.textContent = formatTokens(segment.tokens);

        item.append(left, value);
        contextLegend.appendChild(item);
      }
    }

    const percent = Math.round((totalUsed / total) * 100);
    if (contextVizUsed) contextVizUsed.textContent = `${percent}% used`;
    if (contextVizTotal) {
      contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
    }
  }

  function hide() {
    contextViz.classList.add("hidden");
  }

  tokenUsageEl.addEventListener("click", (event) => {
    event.stopPropagation();
    if (contextViz.classList.contains("hidden")) {
      updateContextViz();
      contextViz.classList.remove("hidden");
    } else {
      hide();
    }
  });

  document.addEventListener("click", (event) => {
    if (!contextViz.contains(event.target) && event.target !== tokenUsageEl) hide();
  });

  return { update: updateContextViz, hide };
}

export function formatTokens(value) {
  const tokens = Number(value) || 0;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}
