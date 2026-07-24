const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const BETA_SETTINGS_KEY = "picot-settings-beta-updates";

function betaUpdatesEnabled() {
  return localStorage.getItem(BETA_SETTINGS_KEY) === "true";
}

export function setupAppUpdater({ settingsPanel, logger = console } = {}) {
  const relaunch = globalThis.__TAURI__?.process?.relaunch;
  const check = globalThis.__TAURI__?.updater?.check;
  const invoke = globalThis.__TAURI__?.core?.invoke;
  const statusEl = document.getElementById("setting-update-status");
  const checkBtn = document.getElementById("btn-check-updates");
  const sidebarBtn = document.getElementById("sidebar-update-btn");
  if (!statusEl || !checkBtn || typeof check !== "function") return null;

  let update = null;
  let lastCheckMs = 0;
  let checking = false;
  let installing = false;
  let totalBytes = 0;
  let downloadedBytes = 0;
  let silentTimer = null;

  function checkCurrentChannel() {
    if (!betaUpdatesEnabled()) return check();
    if (typeof invoke !== "function") throw new Error("Tauri core API is unavailable");
    return invoke("check_beta_update");
  }

  function installCurrentChannel() {
    if (!betaUpdatesEnabled()) return update?.downloadAndInstall?.();
    if (typeof invoke !== "function") throw new Error("Tauri core API is unavailable");
    return invoke("install_beta_update");
  }

  function setSidebarVisible(visible) {
    sidebarBtn?.classList.toggle("hidden", !visible);
  }

  function setState({ status, button, disabled = false, canInstall = false }) {
    statusEl.textContent = status;
    checkBtn.textContent = button;
    checkBtn.disabled = disabled;
    checkBtn.dataset.mode = canInstall ? "install" : "check";
    checkBtn.setAttribute("aria-busy", disabled ? "true" : "false");
  }

  function showIdle() {
    setState({ status: "Click to check", button: "Check now" });
    setSidebarVisible(false);
  }

  function showAvailable(nextUpdate) {
    const version = nextUpdate?.version ? `v${nextUpdate.version}` : "Update";
    setState({ status: `${version} available`, button: "Download & install", canInstall: true });
    setSidebarVisible(true);
  }

  async function checkNow({ silent = false } = {}) {
    if (checking || installing) return update;
    checking = true;
    lastCheckMs = Date.now();
    if (!silent) setState({ status: "Checking…", button: "Checking…", disabled: true });

    try {
      const result = await checkCurrentChannel();
      update = result
        ? betaUpdatesEnabled()
          ? { ...result, downloadAndInstall: installCurrentChannel }
          : result
        : null;
      if (update) showAvailable(update);
      else {
        setState({ status: "Up to date", button: "Check now" });
        setSidebarVisible(false);
      }
      return update;
    } catch (error) {
      if (!silent) setState({ status: "Check failed", button: "Check now" });
      logger.warn?.("[Updater] Check failed:", error);
      return null;
    } finally {
      checking = false;
    }
  }

  function formatProgress() {
    if (!totalBytes) return "Downloading…";
    const percent = Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100));
    return `Downloading ${percent}%…`;
  }

  async function installUpdate() {
    if (installing) return;
    if (!update) {
      await checkNow();
      if (!update) return;
    }

    installing = true;
    totalBytes = 0;
    downloadedBytes = 0;
    setSidebarVisible(false);
    setState({ status: "Preparing download…", button: "Installing…", disabled: true });

    try {
      if (betaUpdatesEnabled()) {
        await installCurrentChannel();
      } else {
        await update.downloadAndInstall((event) => {
          if (event?.event === "Started") {
            totalBytes = event.data?.contentLength || 0;
            downloadedBytes = 0;
            setState({ status: formatProgress(), button: "Installing…", disabled: true });
          } else if (event?.event === "Progress") {
            downloadedBytes += event.data?.chunkLength || 0;
            setState({ status: formatProgress(), button: "Installing…", disabled: true });
          } else if (event?.event === "Finished") {
            setState({ status: "Installing…", button: "Installing…", disabled: true });
          }
        });
      }
      setState({ status: "Installed. Relaunching…", button: "Relaunching…", disabled: true });
      if (typeof relaunch !== "function") {
        throw new Error("Tauri process plugin is unavailable");
      }
      await relaunch();
    } catch (error) {
      logger.warn?.("[Updater] Install failed:", error);
      setState({ status: "Install failed", button: "Try again", canInstall: true });
      setSidebarVisible(true);
    } finally {
      installing = false;
    }
  }

  function scheduleSilentChecks() {
    if (silentTimer) clearInterval(silentTimer);
    silentTimer = setInterval(() => {
      if (Date.now() - lastCheckMs >= CHECK_INTERVAL_MS) void checkNow({ silent: true });
    }, CHECK_INTERVAL_MS);
  }

  checkBtn.addEventListener("click", () => {
    if (update) void installUpdate();
    else void checkNow();
  });

  sidebarBtn?.addEventListener("click", () => {
    settingsPanel?.openSettings?.("general");
  });

  window.addEventListener("picot-update-channel-changed", () => {
    update = null;
    showIdle();
    void checkNow({ silent: true });
  });

  showIdle();
  void checkNow({ silent: true });
  scheduleSilentChecks();

  return { checkNow, installUpdate };
}
