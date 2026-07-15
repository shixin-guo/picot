const DEFAULT_SETTLE_DELAY_MS = 80;
const DEFAULT_SETTLE_PASSES = 2;

export function anchorHistoryToBottom(
  messagesEl,
  {
    requestAnimationFrame = window.requestAnimationFrame.bind(window),
    setTimeout = window.setTimeout.bind(window),
    settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
    settlePasses = DEFAULT_SETTLE_PASSES,
    preserveScrollTarget = false,
  } = {},
) {
  if (!messagesEl) return;
  if (preserveScrollTarget) return;

  // During history hydration, we want deterministic bottom anchoring.
  messagesEl.style.scrollBehavior = "auto";

  const applyBottomAnchor = () => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  // Immediate anchor for already-laid-out content.
  applyBottomAnchor();

  // Keep anchoring for a short settling window so delayed ResizeObserver /
  // markdown layout work cannot leave the viewport mid-history.
  for (let pass = 0; pass < settlePasses; pass++) {
    setTimeout(
      () => {
        requestAnimationFrame(applyBottomAnchor);
      },
      settleDelayMs * (pass + 1),
    );
  }

  // Restore the default smooth behavior once settling anchors have been applied.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = "";
    });
  });
}
