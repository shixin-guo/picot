/**
 * Reusable drag-handle between a sidebar and the main content area.
 *
 * Behavior:
 * - Creates a thin vertical handle element next to `sidebarEl`.
 * - Drag updates a CSS custom property on the sidebar element so layout follows.
 * - Persists final width to localStorage under `storageKey`.
 * - Hidden on screens <= 768px (mobile slide-over mode).
 *
 * Required config:
 *   sidebarEl   Element the handle sits next to (must be in the DOM).
 *   side        "left" | "right" — affects which CSS variable is updated.
 *   storageKey  Unique localStorage key for this sidebar's width.
 *
 * Optional config:
 *   minWidth, maxWidth   Default 180 / 500.
 *   cssVar               Override the CSS variable name (defaults: --sidebar-width or --file-sidebar-width).
 *   initialWidth         Override initial width (defaults: persisted value, then sidebarEl offset).
 */

const MOBILE_MAX_WIDTH = 768;
const DEFAULT_MIN = 180;
const DEFAULT_MAX = 500;

function resolveWidth(el) {
  if (!el) return 0;
  const rect = el.getBoundingClientRect?.();
  if (rect?.width) return rect.width;
  return el.offsetWidth || 0;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function createSidebarResizer({
  sidebarEl,
  side,
  storageKey,
  minWidth = DEFAULT_MIN,
  maxWidth = DEFAULT_MAX,
  cssVar,
  initialWidth,
}) {
  if (!sidebarEl || !storageKey) return null;
  if (side !== "left" && side !== "right") {
    throw new Error(`createSidebarResizer: side must be "left" or "right", got "${side}"`);
  }

  const variableName = cssVar || (side === "left" ? "--sidebar-width" : "--file-sidebar-width");

  const handle = document.createElement("div");
  handle.className = "sidebar-resizer";
  handle.dataset.side = side;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  const siblingMethod = side === "left" ? "afterend" : "beforebegin";
  sidebarEl.insertAdjacentElement(siblingMethod, handle);

  let dragging = false;
  let startCursorX = 0;
  let startWidth = 0;

  const applyWidth = (width) => {
    const clamped = clamp(width, minWidth, maxWidth);
    sidebarEl.style.setProperty(variableName, `${clamped}px`);
    return clamped;
  };

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
  };

  const persist = (width) => {
    try {
      localStorage.setItem(storageKey, String(Math.round(width)));
    } catch {
      /* localStorage may be unavailable; failure is non-fatal */
    }
  };

  const onMouseMove = (event) => {
    if (!dragging) return;
    const delta = event.clientX - startCursorX;
    const next = side === "left" ? startWidth + delta : startWidth - delta;
    applyWidth(next);
    event.preventDefault();
  };

  const onMouseUp = (event) => {
    if (!dragging) return;
    const delta = event.clientX - startCursorX;
    const next = side === "left" ? startWidth + delta : startWidth - delta;
    const finalWidth = applyWidth(next);
    persist(finalWidth);
    stopDrag();
  };

  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    if (window.innerWidth <= MOBILE_MAX_WIDTH) return;
    dragging = true;
    startCursorX = event.clientX;
    startWidth = resolveWidth(sidebarEl);
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    event.preventDefault();
  });

  const syncForViewport = () => {
    if (window.innerWidth <= MOBILE_MAX_WIDTH) {
      handle.style.display = "none";
    } else {
      handle.style.display = "";
    }
  };

  window.addEventListener("resize", syncForViewport);
  syncForViewport();

  // Initialize the sidebar width from `initialWidth`, localStorage, or current DOM width.
  if (typeof initialWidth === "number" && !Number.isNaN(initialWidth)) {
    applyWidth(initialWidth);
  } else {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) {
        const parsed = Number.parseFloat(stored);
        if (!Number.isNaN(parsed)) {
          applyWidth(parsed);
        } else {
          applyWidth(resolveWidth(sidebarEl));
        }
      } else {
        applyWidth(resolveWidth(sidebarEl));
      }
    } catch {
      applyWidth(resolveWidth(sidebarEl));
    }
  }

  return {
    element: handle,
    get width() {
      return resolveWidth(sidebarEl);
    },
    setWidth(width) {
      const applied = applyWidth(width);
      persist(applied);
      return applied;
    },
    destroy() {
      window.removeEventListener("resize", syncForViewport);
      stopDrag();
      handle.remove();
    },
  };
}
