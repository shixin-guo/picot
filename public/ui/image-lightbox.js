/**
 * Image Lightbox — click-to-zoom for message images.
 *
 * Call initImageLightbox(container) once on the messages container.
 * Handles both .message-image (user-attached) and .inline-image (markdown) via
 * event delegation so dynamically rendered images are covered automatically.
 */

let overlay = null;

function getOrCreateOverlay() {
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.className = "image-lightbox-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Image preview");

  const img = document.createElement("img");
  img.className = "image-lightbox-img";
  img.alt = "";

  const closeBtn = document.createElement("button");
  closeBtn.className = "image-lightbox-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><line x1="3" y1="3" x2="17" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="17" y1="3" x2="3" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  overlay.appendChild(img);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);

  // Close on backdrop click (not on image itself)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target === closeBtn || closeBtn.contains(e.target)) {
      closeLightbox();
    }
  });

  // Close on Escape
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) {
      closeLightbox();
    }
  });

  return overlay;
}

function openLightbox(src, alt) {
  const ov = getOrCreateOverlay();
  const img = ov.querySelector(".image-lightbox-img");
  img.src = src;
  img.alt = alt || "";
  // Reset any previous animation
  ov.classList.remove("open");
  // Force reflow so the transition fires
  void ov.offsetWidth;
  ov.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  if (!overlay) return;
  overlay.classList.remove("open");
  document.body.style.overflow = "";
}

/**
 * Wire up lightbox click delegation on a container element.
 * Safe to call multiple times on the same container (deduped via dataset flag).
 */
export function initImageLightbox(container) {
  if (container.dataset.lightboxWired) return;
  container.dataset.lightboxWired = "1";

  container.addEventListener("click", (e) => {
    const img = e.target.closest("img.message-image, img.inline-image");
    if (!img) return;
    e.stopPropagation();
    openLightbox(img.src, img.alt);
  });
}
