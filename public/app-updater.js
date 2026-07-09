import { onLocaleChange, t } from "./i18n.js";

export function createAppUpdater({
  transport,
  appVersionValue,
  updaterSection,
  checkUpdatesBtn,
  updateStatusRow,
  updateStatusEl,
  updateInstallRow,
  updateInstallLabel,
  installUpdateBtn,
  sidebarUpdateBtn,
  onOpenSettings,
}) {
  const APP_VERSION = (() => {
    const meta = document.querySelector('meta[name="app-version"]');
    return meta?.content?.trim() || null;
  })();

  let pendingUpdate = null;
  let updaterBusy = false;
  let updateCheckFailed = false;
  let uiInitialized = false;
  let startupCheckTimer = null;
  let periodicCheckInterval = null;
  const BETA_VERSION_RE = /-beta(?:[.-]|$)/i;
  const NUMERIC_PRERELEASE_VERSION_RE = /-\d+(?:\.\d+)*$/;
  let currentAppVersion = APP_VERSION;

  // i18n: track the current status/button text so a locale change can repaint
  // already-rendered UI without rechecking the network. Raw values (versions,
  // raw transport error text) are kept untranslated and not re-applied.
  let currentStatusKey = null;
  let currentStatusParams = {};
  let currentStatusTone = "info";
  let appVersionUnknown = false;
  let currentCheckBtnKey = "updater.checkNow";
  let currentCheckBtnParams = {};
  let currentInstallLabelKey = null;
  let currentInstallLabelParams = {};
  let currentInstallBtnKey = null;
  let currentInstallBtnParams = {};

  function applyUpdateStatus(key, params = {}, tone = "info") {
    currentStatusKey = key;
    currentStatusParams = params;
    currentStatusTone = tone;
    setUpdateStatus(t(key, params), tone);
  }

  function applyRawUpdateStatus(message, tone = "info") {
    currentStatusKey = null;
    currentStatusTone = tone;
    setUpdateStatus(message, tone);
  }

  function setCheckBtnText(key, params = {}) {
    currentCheckBtnKey = key;
    currentCheckBtnParams = params;
    if (checkUpdatesBtn) checkUpdatesBtn.textContent = t(key, params);
  }

  function setInstallBtnText(key, params = {}) {
    currentInstallBtnKey = key;
    currentInstallBtnParams = params;
    if (installUpdateBtn) installUpdateBtn.textContent = t(key, params);
  }

  function setInstallLabelText(key, params = {}) {
    currentInstallLabelKey = key;
    currentInstallLabelParams = params;
    if (updateInstallLabel) updateInstallLabel.textContent = t(key, params);
  }

  function setSidebarUpdateButton({
    visible,
    label = t("updater.update"),
    tone = "ok",
    title = t("updater.openInSettings"),
    disabled = false,
  }) {
    if (!sidebarUpdateBtn) return;
    sidebarUpdateBtn.classList.toggle("hidden", !visible);
    if (!visible) {
      sidebarUpdateBtn.textContent = t("updater.update");
      sidebarUpdateBtn.dataset.tone = "";
      sidebarUpdateBtn.disabled = false;
      sidebarUpdateBtn.title = t("updater.openInSettings");
      return;
    }
    sidebarUpdateBtn.textContent = label;
    sidebarUpdateBtn.dataset.tone = tone;
    sidebarUpdateBtn.disabled = disabled;
    sidebarUpdateBtn.title = title;
  }

  function syncSidebarUpdateButton() {
    if (updaterBusy) {
      setSidebarUpdateButton({
        visible: true,
        label: t("updater.updating"),
        tone: "warn",
        title: t("updater.updateInProgress"),
        disabled: true,
      });
      return;
    }
    if (pendingUpdate) {
      setSidebarUpdateButton({
        visible: true,
        label: t("updater.update"),
        tone: "ok",
        title: t("updater.updateAvailableVersion", { version: pendingUpdate.version }),
      });
      return;
    }
    if (updateCheckFailed) {
      setSidebarUpdateButton({
        visible: true,
        label: t("updater.retry"),
        tone: "error",
        title: t("updater.lastCheckFailed"),
      });
      return;
    }
    setSidebarUpdateButton({ visible: false });
  }

  function setUpdateStatus(message, tone = "info") {
    if (!updateStatusRow || !updateStatusEl) return;
    if (!message) {
      updateStatusRow.hidden = true;
      updateStatusEl.textContent = "";
      updateStatusEl.dataset.tone = "";
      return;
    }
    updateStatusRow.hidden = false;
    updateStatusEl.textContent = message;
    updateStatusEl.dataset.tone = tone;
  }

  function showInstallButton(update) {
    if (!updateInstallRow || !updateInstallLabel || !installUpdateBtn) return;
    if (!update) {
      updateInstallRow.hidden = true;
      currentInstallLabelKey = null;
      currentInstallBtnKey = null;
      return;
    }
    updateInstallRow.hidden = false;
    if (update.currentVersion) {
      setInstallLabelText("updater.versionLabelFrom", {
        version: update.version,
        current: update.currentVersion,
      });
    } else {
      setInstallLabelText("updater.versionLabel", { version: update.version });
    }
    installUpdateBtn.disabled = false;
    setInstallBtnText("updater.downloadInstall");
  }

  function isIgnoredPrereleaseVersion(version) {
    return BETA_VERSION_RE.test(String(version || "").trim());
  }

  function isLocalPrereleaseBuild(version) {
    return NUMERIC_PRERELEASE_VERSION_RE.test(String(version || "").trim());
  }

  async function loadAppVersion() {
    if (!appVersionValue) return;

    if (APP_VERSION) {
      appVersionValue.textContent = APP_VERSION;
      appVersionUnknown = false;
      currentAppVersion = APP_VERSION;
      return APP_VERSION;
    }

    try {
      if (transport?.capabilities?.native) {
        const v = await transport.getAppVersion();
        if (v) {
          appVersionValue.textContent = v;
          appVersionUnknown = false;
          currentAppVersion = v;
          return v;
        }
      }
    } catch (err) {
      console.warn("[updater] unable to read app version:", err);
    }
    appVersionValue.textContent = t("updater.unknown");
    appVersionUnknown = true;
    currentAppVersion = "unknown";
    return currentAppVersion;
  }

  function explainUpdateError(rawMessage) {
    const msg = String(rawMessage || "");
    if (/Could not fetch a valid release JSON/i.test(msg)) {
      return { key: "updater.noManifest", params: {} };
    }
    if (/pubkey|public key|signature/i.test(msg)) {
      return { key: "updater.pubkeyError", params: {} };
    }
    if (msg) return { raw: msg };
    return { key: "updater.unknownError", params: {} };
  }

  async function checkForUpdates({ silent = false } = {}) {
    if (updaterBusy) return null;

    if (isLocalPrereleaseBuild(currentAppVersion)) {
      if (!silent) {
        applyUpdateStatus("updater.prereleaseBuild", { version: currentAppVersion }, "info");
      }
      pendingUpdate = null;
      updateCheckFailed = false;
      showInstallButton(null);
      syncSidebarUpdateButton();
      return null;
    }

    if (!transport?.hasUpdater) {
      if (!silent) applyUpdateStatus("updater.autoUpdatesDesktopOnly", {}, "warn");
      if (updaterSection && !transport?.capabilities?.native) updaterSection.hidden = true;
      setSidebarUpdateButton({ visible: false });
      return null;
    }

    updaterBusy = true;
    syncSidebarUpdateButton();
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = true;
      setCheckBtnText("updater.checking");
    }
    if (!silent) applyUpdateStatus("updater.checkingForUpdates", {}, "info");

    try {
      const update = await transport.checkForUpdate();
      if (!update) {
        pendingUpdate = null;
        updateCheckFailed = false;
        showInstallButton(null);
        applyUpdateStatus("updater.latestVersion", {}, "ok");
        syncSidebarUpdateButton();
        return null;
      }

      if (isIgnoredPrereleaseVersion(update.version)) {
        console.info("[updater] ignoring beta release:", update.version);
        pendingUpdate = null;
        updateCheckFailed = false;
        showInstallButton(null);
        applyUpdateStatus("updater.latestStable", {}, "ok");
        syncSidebarUpdateButton();
        return null;
      }

      pendingUpdate = update;
      updateCheckFailed = false;
      showInstallButton(update);
      applyUpdateStatus("updater.updateAvailableVersion", { version: update.version }, "ok");
      syncSidebarUpdateButton();
      return update;
    } catch (err) {
      const explained = explainUpdateError(err?.message || err);
      console.warn("[updater] check failed:", err);
      if (!silent) {
        if (explained.key) {
          applyUpdateStatus(explained.key, explained.params, "warn");
        } else {
          applyRawUpdateStatus(explained.raw, "warn");
        }
      }
      updateCheckFailed = true;
      syncSidebarUpdateButton();
      return null;
    } finally {
      updaterBusy = false;
      syncSidebarUpdateButton();
      if (checkUpdatesBtn) {
        checkUpdatesBtn.disabled = false;
        setCheckBtnText("updater.checkNow");
      }
    }
  }

  async function installPendingUpdate() {
    if (updaterBusy || !pendingUpdate) return;
    if (!transport?.capabilities?.native) return;

    updaterBusy = true;
    syncSidebarUpdateButton();
    if (installUpdateBtn) {
      installUpdateBtn.disabled = true;
      setInstallBtnText("updater.downloading");
    }
    if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;

    try {
      await transport.downloadAndInstallUpdate((evt) => {
        if (evt.phase === "started") {
          if (evt.contentLength) {
            applyUpdateStatus(
              "updater.downloadingMB",
              { mb: (evt.contentLength / 1_048_576).toFixed(1) },
              "info",
            );
          } else {
            applyUpdateStatus("updater.downloading", {}, "info");
          }
        } else if (evt.phase === "progress" && evt.contentLength) {
          const pct = Math.min(100, Math.round((evt.downloaded / evt.contentLength) * 100));
          setInstallBtnText("updater.downloadingPct", { pct });
        } else if (evt.phase === "finished") {
          setInstallBtnText("updater.installing");
          applyUpdateStatus("updater.installing", {}, "info");
        }
      });

      applyUpdateStatus("updater.updateInstalled", {}, "ok");
      pendingUpdate = null;
      updateCheckFailed = false;
      syncSidebarUpdateButton();
      setTimeout(() => {
        transport?.relaunchApp?.().catch((err) => {
          console.error("[updater] relaunch failed:", err);
          applyUpdateStatus("updater.pleaseRestart", {}, "warn");
          updateCheckFailed = true;
          syncSidebarUpdateButton();
        });
      }, 600);
    } catch (err) {
      const msg = String(err?.message || err || t("errors.unknownError"));
      console.error("[updater] install failed:", err);
      applyUpdateStatus("updater.updateFailed", { message: msg }, "error");
      if (installUpdateBtn) {
        installUpdateBtn.disabled = false;
        setInstallBtnText("updater.retry");
      }
      updateCheckFailed = true;
      syncSidebarUpdateButton();
    } finally {
      updaterBusy = false;
      syncSidebarUpdateButton();
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = false;
    }
  }

  let isDevBuildCache = null;
  async function isDevBuild() {
    if (isDevBuildCache !== null) return isDevBuildCache;
    try {
      isDevBuildCache = !!(transport?.capabilities?.native && (await transport.isDev()));
    } catch {
      isDevBuildCache = false;
    }
    return isDevBuildCache;
  }

  async function initUpdaterUI() {
    if (!updaterSection) return;

    if (!transport?.hasUpdater) {
      updaterSection.hidden = true;
      syncSidebarUpdateButton();
      return;
    }
    // Capabilities can arrive asynchronously and may be re-emitted on reconnect.
    // Ensure the section becomes visible once native updater support is known.
    updaterSection.hidden = false;

    const appVersion = await loadAppVersion();

    if (await isDevBuild()) {
      applyUpdateStatus("updater.devBuild", {}, "info");
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
      syncSidebarUpdateButton();
      return;
    }

    if (isLocalPrereleaseBuild(appVersion)) {
      applyUpdateStatus("updater.prereleaseBuild", { version: appVersion }, "info");
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
      if (installUpdateBtn) installUpdateBtn.disabled = true;
      showInstallButton(null);
      syncSidebarUpdateButton();
      return;
    }

    if (uiInitialized) {
      syncSidebarUpdateButton();
      return;
    }
    uiInitialized = true;

    checkUpdatesBtn?.addEventListener("click", () => {
      checkForUpdates({ silent: false });
    });
    installUpdateBtn?.addEventListener("click", () => {
      installPendingUpdate();
    });

    startupCheckTimer = setTimeout(() => {
      checkForUpdates({ silent: true }).catch(() => {});
    }, 5_000);

    periodicCheckInterval = setInterval(
      () => {
        if (document.visibilityState === "visible") {
          checkForUpdates({ silent: true }).catch(() => {});
        }
      },
      6 * 60 * 60 * 1000,
    );
    // Keep references intentionally; helps future teardown work and makes
    // duplicate-initialization bugs obvious in devtools.
    void startupCheckTimer;
    void periodicCheckInterval;
    syncSidebarUpdateButton();
  }

  async function openUpdatesFromSidebar() {
    await onOpenSettings();
    updaterSection?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (pendingUpdate && installUpdateBtn && !installUpdateBtn.disabled) {
      installUpdateBtn.focus();
      return;
    }
    checkUpdatesBtn?.focus();
  }

  // Re-apply localized status/button text when the locale changes without
  // rechecking the network. Raw values (versions, raw error text) are unchanged.
  const unsubscribeLocaleChange = onLocaleChange(() => {
    if (currentStatusKey) {
      setUpdateStatus(t(currentStatusKey, currentStatusParams), currentStatusTone);
    }
    if (appVersionUnknown && appVersionValue) {
      appVersionValue.textContent = t("updater.unknown");
    }
    if (checkUpdatesBtn && currentCheckBtnKey) {
      checkUpdatesBtn.textContent = t(currentCheckBtnKey, currentCheckBtnParams);
    }
    if (updateInstallRow && !updateInstallRow.hidden) {
      if (currentInstallLabelKey && updateInstallLabel) {
        updateInstallLabel.textContent = t(currentInstallLabelKey, currentInstallLabelParams);
      }
      if (currentInstallBtnKey && installUpdateBtn) {
        installUpdateBtn.textContent = t(currentInstallBtnKey, currentInstallBtnParams);
      }
    }
    syncSidebarUpdateButton();
  });
  // Intentionally never unsubscribed — updater lives for the app lifetime.
  void unsubscribeLocaleChange;

  return {
    initUpdaterUI,
    openUpdatesFromSidebar,
  };
}
