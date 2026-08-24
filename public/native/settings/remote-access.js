import { t } from "../../i18n.js";

function isPlainLauncherUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.pathname === "/app" &&
      !url.search &&
      !url.hash &&
      value === `${url.origin}/app`
    );
  } catch {
    return false;
  }
}

/**
 * Owns the desktop Settings > Remote Access panel. The Host endpoint is
 * intentionally trusted-desktop-only; its QR is navigation to /app, never an
 * authorization credential.
 */
export function setupRemoteAccessPanel({ fetchImpl = globalThis.fetch } = {}) {
  const urlValue = document.getElementById("remote-access-url");
  const copyButton = document.getElementById("remote-access-copy");
  const copyStatus = document.getElementById("remote-access-copy-status");
  const qrButton = document.getElementById("remote-access-show-qr");
  const qrImage = document.getElementById("remote-access-qr");
  const error = document.getElementById("remote-access-error");
  if (!urlValue || !copyButton || !qrButton || !qrImage) return { load: async () => {} };

  let remoteUrl = "";
  let qrDataUrl = "";
  let loaded = false;
  let loading = null;

  const setStatus = (message, isError = false) => {
    if (!copyStatus) return;
    copyStatus.textContent = message;
    copyStatus.classList.toggle("remote-access-status--error", isError);
  };

  async function load() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const response = await fetchImpl("/v2/remote-access", { cache: "no-store" });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !isPlainLauncherUrl(body.url)) {
          throw new Error("unavailable");
        }
        remoteUrl = body.url;
        qrDataUrl = typeof body.dataUrl === "string" ? body.dataUrl : "";
        urlValue.textContent = remoteUrl;
        if (error) error.textContent = "";
        urlValue.title = remoteUrl;
        loaded = true;
      } catch {
        if (error) error.textContent = t("settings.remoteAccessUnavailable");
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  copyButton.addEventListener("click", async () => {
    if (!remoteUrl) await load();
    if (!remoteUrl) return;
    try {
      await navigator.clipboard.writeText(remoteUrl);
      setStatus(t("settings.remoteAccessCopied"));
    } catch {
      setStatus(t("settings.remoteAccessCopyFailed"), true);
    }
  });

  qrButton.addEventListener("click", async () => {
    if (!remoteUrl) await load();
    if (!qrDataUrl) return;
    qrImage.src = qrDataUrl;
    qrImage.hidden = false;
    qrButton.hidden = true;
  });

  return { load };
}
