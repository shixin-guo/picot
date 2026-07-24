/**
 * LAN QR code modal: shows a QR code for opening Picot on a mobile device
 * on the same local network.
 *
 * Requires the following elements in index.html (already present):
 *   #lan-qr-btn        — toolbar button (hidden by default)
 *   #lan-qr-modal      — dialog overlay
 *   #lan-qr-modal-backdrop
 *   #lan-qr-modal-close
 *   #lan-qr-loading
 *   #lan-qr-image
 *   #lan-qr-open-link  — button that opens the URL externally
 */

let lanQrUrl = "";

const lanQrBtn = document.getElementById("lan-qr-btn");
const lanQrModal = document.getElementById("lan-qr-modal");
const lanQrModalBackdrop = document.getElementById("lan-qr-modal-backdrop");
const lanQrModalClose = document.getElementById("lan-qr-modal-close");
const lanQrLoading = document.getElementById("lan-qr-loading");
const lanQrImage = document.getElementById("lan-qr-image");
const lanQrOpenLink = document.getElementById("lan-qr-open-link");

function updateLanQrButton(url = "") {
  if (!lanQrBtn) return;
  if (url) {
    lanQrBtn.classList.remove("hidden");
  } else {
    lanQrBtn.classList.add("hidden");
  }
}

async function openLanQrModal() {
  if (!lanQrModal) return;
  lanQrModal.classList.remove("hidden");
  if (lanQrLoading) {
    lanQrLoading.style.display = "";
    lanQrLoading.textContent = "Generating QR code…";
  }
  if (lanQrImage) lanQrImage.classList.add("hidden");
  if (lanQrOpenLink) lanQrOpenLink.classList.add("hidden");
  lanQrUrl = "";
  try {
    // Pass the current session path so the QR code deep-links directly into the session.
    const sessionPath = encodeURIComponent(window.location.pathname);
    const res = await fetch(`/v2/lan-qr?path=${sessionPath}`);
    if (!res.ok) throw new Error("unavailable");
    const data = await res.json();
    if (lanQrImage && data.dataUrl) {
      lanQrImage.src = data.dataUrl;
      lanQrImage.classList.remove("hidden");
    }
    if (typeof data.url === "string" && data.url) {
      lanQrUrl = data.url;
      if (lanQrOpenLink) lanQrOpenLink.classList.remove("hidden");
    }
    if (lanQrLoading) lanQrLoading.style.display = "none";
  } catch {
    if (lanQrLoading) lanQrLoading.textContent = "QR code unavailable";
  }
}

function closeLanQrModal() {
  if (lanQrModal) lanQrModal.classList.add("hidden");
}

/**
 * Poll `/health` once to discover the LAN URL and show/hide the toolbar button.
 * Call this after the runtime is ready.
 */
export async function refreshLanQrButton() {
  try {
    const res = await fetch("/health");
    if (!res.ok) {
      updateLanQrButton("");
      return;
    }
    const data = await res.json();
    const url = typeof data?.lanUrl === "string" ? data.lanUrl : "";
    updateLanQrButton(url);
  } catch {
    updateLanQrButton("");
  }
}

/**
 * Wire up all DOM event listeners for the LAN QR modal.
 * Call once during app initialisation.
 */
export function setupLanQr({ control } = {}) {
  if (lanQrBtn) lanQrBtn.addEventListener("click", () => openLanQrModal());
  if (lanQrModalBackdrop) lanQrModalBackdrop.addEventListener("click", closeLanQrModal);
  if (lanQrModalClose) lanQrModalClose.addEventListener("click", closeLanQrModal);
  if (lanQrOpenLink) {
    lanQrOpenLink.addEventListener("click", () => {
      if (!lanQrUrl) return;
      if (control) {
        control.openExternal(lanQrUrl).catch((error) => {
          console.error("[LAN QR] Failed to open link externally:", error);
          window.open(lanQrUrl, "_blank", "noopener,noreferrer");
        });
        return;
      }
      window.open(lanQrUrl, "_blank", "noopener,noreferrer");
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && lanQrModal && !lanQrModal.classList.contains("hidden")) {
      closeLanQrModal();
    }
  });
}
