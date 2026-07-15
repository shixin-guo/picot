const DEFAULT_MIN_WIDTH = 260;
const DEFAULT_MAX_WIDTH = 560;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function readStoredWidth(storageKey) {
  if (!storageKey) return null;
  const stored = Number.parseInt(localStorage.getItem(storageKey) || "", 10);
  return Number.isFinite(stored) ? stored : null;
}

export function setupResizablePanel(
  panel,
  { storageKey, defaultWidth, minWidth = DEFAULT_MIN_WIDTH, maxWidth = DEFAULT_MAX_WIDTH },
) {
  if (!panel) return () => {};

  panel.classList.add("app-side-panel", "is-resizable");
  const initialWidth = clamp(readStoredWidth(storageKey) ?? defaultWidth, minWidth, maxWidth);
  setPanelWidth(panel, initialWidth, storageKey);

  const handle =
    panel.querySelector(".app-side-panel-resize-handle") || document.createElement("div");
  handle.className = "app-side-panel-resize-handle";
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("title", "Resize panel");
  if (!handle.parentElement) {
    panel.prepend(handle);
  }

  let startX = 0;
  let startWidth = initialWidth;

  const onPointerMove = (event) => {
    const nextWidth = clamp(startWidth + startX - event.clientX, minWidth, maxWidth);
    setPanelWidth(panel, nextWidth, storageKey);
  };

  const onPointerUp = () => {
    document.body.classList.remove("is-resizing-side-panel");
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    startX = event.clientX;
    startWidth = Number.parseInt(panel.style.getPropertyValue("--panel-width"), 10) || initialWidth;
    document.body.classList.add("is-resizing-side-panel");
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
  };

  handle.addEventListener("pointerdown", onPointerDown);

  return () => {
    handle.removeEventListener("pointerdown", onPointerDown);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.body.classList.remove("is-resizing-side-panel");
  };
}

function setPanelWidth(panel, width, storageKey) {
  panel.style.setProperty("--panel-width", `${Math.round(width)}px`);
  if (storageKey) {
    localStorage.setItem(storageKey, String(Math.round(width)));
  }
}
