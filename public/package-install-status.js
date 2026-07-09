import { t } from "./i18n.js";

export function summarizePackageError(err) {
  const raw = String(err?.message || err || "unknown error");
  if (raw.includes("EACCES") || raw.includes("permission denied")) {
    return t("extensions.permissionDenied");
  }
  return raw;
}

export function renderPackageInstallFailure(status, err, operation = "install") {
  if (!status) return;
  const fullMessage = String(err?.message || err || "unknown error");
  const isUninstall = operation === "uninstall";
  status.hidden = false;
  status.classList.add("is-error");
  status.title = "";
  status.replaceChildren();

  const title = document.createElement("div");
  title.className = "settings-extension-status-title";
  title.textContent = isUninstall ? t("extensions.uninstallFailed") : t("extensions.installFailed");
  status.appendChild(title);

  const npmNote = document.createElement("div");
  npmNote.className = "settings-extension-status-note";
  npmNote.textContent = isUninstall
    ? t("extensions.uninstallFailedNote")
    : t("extensions.installFailedNote");
  status.appendChild(npmNote);

  const detail = document.createElement("div");
  detail.className = "settings-extension-status-detail";
  detail.textContent = summarizePackageError(fullMessage);
  status.appendChild(detail);
}
