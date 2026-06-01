/**
 * Tauri bridge — exposes native IPC to the existing pi-web-ui frontend.
 * Only active when running inside the Tauri desktop app (window.__TAURI__ is set).
 *
 * Instead of hack approaches (osascript, no-op session switches), we use:
 *   - newSession(port)          → RPC cmd to pi: create new session
 *   - switchSession(port, path) → RPC cmd to pi: switch to session file
 *   - openWorkspace(cwd)        → spawn new pi process + new OS window
 *   - pickFolder()              → native macOS folder picker
 *   - stopInstance(port)        → kill a pi instance
 */

(function () {
  const tauriCore = window.__TAURI__?.core;
  if (!tauriCore || typeof tauriCore.invoke !== 'function') {
    console.error('[tauri-bridge] Tauri core API unavailable');
    return;
  }
  const invoke = (cmd, args) => tauriCore.invoke(cmd, args);

  function currentPort() {
    return parseInt(location.port) || 47821;
  }

  // ── Updater (tauri-plugin-updater + tauri-plugin-process) ────────────────
  // We talk to the plugins directly via `invoke('plugin:<name>|<cmd>')`
  // instead of bundling `@tauri-apps/plugin-updater` / `-process`, because
  // the rest of the frontend is plain (un-bundled) ES code and the plugin
  // packages are tiny `invoke()` wrappers anyway. Same observable behavior,
  // no extra build step.
  //
  // Channel: the plugin streams download progress through a Tauri `Channel`
  // (window.__TAURI__.core.Channel). It implements the right serialization
  // out of the box, so we just create one, attach an `onmessage`, and pass
  // it in the invoke args — the Rust side calls back into it for each
  // `Started` / `Progress` / `Finished` event.
  const Channel = window.__TAURI__?.core?.Channel;

  let lastUpdateRid = null;

  async function checkForUpdate() {
    const metadata = await invoke('plugin:updater|check', {});
    lastUpdateRid = metadata?.rid ?? null;
    if (!metadata) return null;
    return {
      available: true,
      rid: metadata.rid,
      version: metadata.version,
      currentVersion: metadata.currentVersion,
      date: metadata.date ?? null,
      notes: metadata.body ?? '',
    };
  }

  async function downloadAndInstallUpdate(onProgress) {
    if (!Channel) {
      throw new Error('Tauri Channel API unavailable; cannot stream update progress');
    }

    // Always check first so we have a fresh resource handle (the plugin
    // closes the previous one as soon as install finishes).
    const metadata = await invoke('plugin:updater|check', {});
    if (!metadata) {
      return { installed: false, reason: 'no_update' };
    }
    lastUpdateRid = metadata.rid;

    const channel = new Channel();
    let contentLength = 0;
    let downloaded = 0;
    channel.onmessage = (event) => {
      switch (event.event) {
        case 'Started':
          contentLength = event.data?.contentLength ?? 0;
          onProgress?.({ phase: 'started', contentLength });
          break;
        case 'Progress':
          downloaded += event.data?.chunkLength ?? 0;
          onProgress?.({ phase: 'progress', downloaded, contentLength });
          break;
        case 'Finished':
          onProgress?.({ phase: 'finished', downloaded: contentLength, contentLength });
          break;
      }
    };

    await invoke('plugin:updater|download_and_install', {
      onEvent: channel,
      rid: metadata.rid,
    });

    return { installed: true, version: metadata.version };
  }

  async function relaunchApp() {
    try {
      await invoke('plugin:process|restart');
    } catch (err) {
      // Fall back to exit(0) if restart isn't available — the OS-level
      // installer will have already replaced the binary on disk; the user
      // just needs to re-open the app.
      console.warn('[tauri-bridge] restart failed, falling back to exit:', err);
      try {
        await invoke('plugin:process|exit', { code: 0 });
      } catch (e2) {
        console.error('[tauri-bridge] exit also failed:', e2);
        throw err;
      }
    }
  }

  // Probe: assume the updater plugin is available iff we're inside Tauri.
  // We don't actually call `check()` here because that would hit the
  // network on every window load.
  const hasUpdater = true;
  void lastUpdateRid;

  window.tauriNative = {
    isTauri: true,

    pickFolder: () =>
      invoke('cmd_pick_folder'),

    // `forceNewSession` defaults to `false`: a freshly-spawned pi already boots
    // into a brand-new session, so the extra `new_session` RPC was redundant
    // and caused a second extension reload (see workspace-actions.js for the
    // longer rationale). Callers that genuinely want a new chat pass `true`.
    openWorkspace: (cwd, options = {}) =>
      invoke('cmd_open_workspace', {
        cwd,
        sessionPath: options.sessionPath ?? null,
        forceNewSession: options.forceNewSession ?? false,
        openWindow: options.openWindow ?? true,
        waitForSessions: options.waitForSessions ?? false,
      }),

    newSession: (port) =>
      invoke('cmd_new_session', { port: port ?? currentPort() }),

    switchSession: (sessionPath, port) =>
      invoke('cmd_switch_session', { port: port ?? currentPort(), sessionPath }),

    stopInstance: (port) =>
      invoke('cmd_stop_instance', { port: port ?? currentPort() }),

    spawnSessionProcess: (sessionFile, cwd) =>
      invoke('cmd_spawn_session_process', {
        workspacePort: currentPort(),
        sessionFile,
        cwd,
      }),

    getPiVersion: () =>
      invoke('cmd_get_pi_version'),

    getAppVersion: () =>
      invoke('cmd_get_app_version'),

    isDev: () =>
      invoke('cmd_is_dev'),

    checkForUpdate,
    downloadAndInstallUpdate,
    relaunchApp,
    hasUpdater,

    currentPort,
  };

  console.log('[tauri-bridge] Native APIs ready on port', currentPort());
})();
