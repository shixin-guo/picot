function isEditableElement(element) {
  const tag = element?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || element?.isContentEditable;
}

function isVisible(element) {
  return Boolean(element && !element.classList.contains("hidden"));
}

function overlayOwnsEscape() {
  return (
    isVisible(document.getElementById("settings-panel")) ||
    isVisible(document.getElementById("model-dropdown-menu")) ||
    isVisible(document.getElementById("lan-qr-modal")) ||
    document.querySelector(".image-lightbox.open")
  );
}

export function setupAppKeyboardShortcuts({ input, abort, isWorking }) {
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (overlayOwnsEscape()) return;
      if (isWorking()) {
        event.preventDefault();
        abort();
      }
      return;
    }

    if (event.key === "/" && !isEditableElement(document.activeElement)) {
      event.preventDefault();
      input?.focus();
    }
  });
}
