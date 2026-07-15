const BASE_TOP_INSET = 68;
const BASE_BOTTOM_INSET = 100;
const CHROME_GAP = 12;

function defaultMeasureHeight(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect?.();
  return Math.ceil(rect?.height || element.offsetHeight || 0);
}

export function syncMessagesInsets({
  main,
  messages,
  header,
  inputArea,
  measureHeight = defaultMeasureHeight,
} = {}) {
  if (!main || !messages || !header || !inputArea) {
    return {
      topInset: BASE_TOP_INSET,
      bottomInset: BASE_BOTTOM_INSET,
    };
  }

  const topInset = Math.max(BASE_TOP_INSET, measureHeight(header) + CHROME_GAP);
  const bottomInset = Math.max(BASE_BOTTOM_INSET, measureHeight(inputArea) + CHROME_GAP);

  main.style.setProperty("--messages-top-inset", `${topInset}px`);
  main.style.setProperty("--messages-bottom-inset", `${bottomInset}px`);
  messages.style.setProperty("scroll-padding-top", `${topInset}px`);
  messages.style.setProperty("scroll-padding-bottom", `${bottomInset}px`);

  return { topInset, bottomInset };
}

export function setupMessagesInsets({ main, messages, header, inputArea } = {}) {
  let frameId = 0;

  const sync = () => {
    frameId = 0;
    syncMessagesInsets({ main, messages, header, inputArea });
  };

  const scheduleSync = () => {
    if (frameId) return;
    frameId = requestAnimationFrame(sync);
  };

  scheduleSync();

  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          scheduleSync();
        })
      : null;

  observer?.observe(header);
  observer?.observe(inputArea);
  observer?.observe(main);

  window.addEventListener("resize", scheduleSync);
  window.visualViewport?.addEventListener("resize", scheduleSync);

  return () => {
    if (frameId) cancelAnimationFrame(frameId);
    observer?.disconnect();
    window.removeEventListener("resize", scheduleSync);
    window.visualViewport?.removeEventListener("resize", scheduleSync);
  };
}
