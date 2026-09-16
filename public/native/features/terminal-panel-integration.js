// ABOUTME: Wires the native Host terminal protocol to the reusable terminal UI modules.
// ABOUTME: Keeps PTY transport and panel lifecycle out of the native app composition root.

import { onLocaleChange, t } from "../../i18n.js";
import { TerminalClient } from "../../terminal-client.js";
import {
  loadTerminalFont,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_STACK,
} from "../../terminal-font.js";
import { TerminalPanel } from "../../terminal-panel.js";
import { encodeBase64, resolveTerminalTheme, TerminalTab } from "../../terminal-tab.js";
import { onThemeChange } from "../../themes.js";
import {
  defaultWebglRenderer,
  loadAppearanceCookie,
  migrateLegacyTerminalPreferences,
  TERMINAL_FONT_SIZE_PX,
} from "../settings/appearance-preferences.js";

/**
 * Terminal display preferences now live in the global appearance store
 * (cookie first-paint cache + host preference DB). The legacy per-origin
 * localStorage payload migrates once on first setup.
 */
function currentTerminalPreferences() {
  migrateLegacyTerminalPreferences(typeof localStorage !== "undefined" ? localStorage : null);
  const cookie = loadAppearanceCookie();
  return {
    fontSize: TERMINAL_FONT_SIZE_PX[cookie.terminalFontSize],
    themeMode: cookie.terminalThemeMode,
    scrollbackLimit: cookie.terminalScrollbackLimit,
    smoothScrollDuration: cookie.terminalSmoothScrollDuration,
    webglRenderer:
      typeof cookie.terminalWebglRenderer === "boolean"
        ? cookie.terminalWebglRenderer
        : defaultWebglRenderer(),
  };
}

export function setupTerminalPanel({ adapter, getWorkspaceId }) {
  if (!globalThis.PicotXterm) return null;

  let prefs = currentTerminalPreferences();
  let panel;
  const client = new TerminalClient({
    send: (envelope) => {
      adapter.send({ ...envelope, workspaceId: getWorkspaceId() });
      return envelope.requestId;
    },
    createTab: (terminalId, generation) => {
      const tab = new TerminalTab({
        terminalId,
        generation,
        container: panel.getTabContainer(terminalId),
        terminalFactory: () =>
          new globalThis.PicotXterm.Terminal({
            fontFamily: TERMINAL_FONT_STACK,
            fontSize: prefs.fontSize,
            fontWeight: 400,
            scrollback: prefs.scrollbackLimit,
            smoothScrollDuration: prefs.smoothScrollDuration,
          }),
        fontFamily: TERMINAL_FONT_FAMILY,
        fontSize: prefs.fontSize,
        initialTheme: resolveTerminalTheme(prefs.themeMode),
        loadFont: () =>
          loadTerminalFont({ family: TERMINAL_FONT_FAMILY, fontSize: prefs.fontSize }),
        fitAddonFactory: () => new globalThis.PicotXterm.FitAddon(),
        serializeAddonFactory: () => new globalThis.PicotXterm.SerializeAddon(),
        sendInput: (id, gen, dataBase64) =>
          client.command({
            type: "terminal_input",
            terminalId: id,
            generation: gen,
            dataBase64,
          }),
        sendResize: (id, gen, cols, rows) =>
          client.command({ type: "terminal_resize", terminalId: id, generation: gen, cols, rows }),
      });
      if (prefs.webglRenderer && globalThis.PicotXterm.WebglAddon) {
        tab.enableWebgl(() => new globalThis.PicotXterm.WebglAddon());
      }
      return tab;
    },
  });

  panel = new TerminalPanel({
    native: true,
    subscribeLocale: onLocaleChange,
    getAvailableHeight: () => document.querySelector(".workspace")?.clientHeight || 600,
    getFullscreenBounds: getChatPanelFullscreenBounds,
    client: createPanelClient(client, () => panel),
  });
  const workspace = document.querySelector(".workspace");
  const toolbar = document.querySelector(".workspace .header-right");
  if (!workspace || !toolbar) return null;
  panel.mount({ toggleContainer: toolbar, panelContainer: workspace });
  const fileToggle = toolbar.querySelector("#file-sidebar-toggle");
  if (fileToggle && panel.toggleEl) toolbar.insertBefore(panel.toggleEl, fileToggle);

  client.setWorkspaceGeneration(0);
  adapter.setReceiver((frame) => handleTerminalFrame(frame, client, panel));
  adapter.setConnectionListener((connected) => {
    if (connected) client.requestList();
  });
  // xterm paints its own viewport, so it cannot inherit the theme from CSS.
  // Re-derive the xterm theme for every open tab whenever the app theme
  // changes, honoring a forced terminal theme mode; otherwise a terminal keeps
  // the background of the theme it was created under.
  const unsubscribeTheme = onThemeChange(() => {
    const theme = resolveTerminalTheme(prefs.themeMode);
    for (const entry of client.tabs.values()) {
      entry.tab?.setTheme?.(theme);
    }
  });

  /**
   * Apply appearance-driven display preferences to every live tab and to all
   * future tabs. Only the fields present in the patch are touched.
   */
  function applyPreferences(patch = {}) {
    if (Number.isFinite(patch.fontSize)) prefs = { ...prefs, fontSize: patch.fontSize };
    if (patch.themeMode) prefs = { ...prefs, themeMode: patch.themeMode };
    if (Number.isFinite(patch.scrollbackLimit)) {
      prefs = { ...prefs, scrollbackLimit: patch.scrollbackLimit };
    }
    if (Number.isFinite(patch.smoothScrollDuration)) {
      prefs = { ...prefs, smoothScrollDuration: patch.smoothScrollDuration };
    }
    if (typeof patch.webglRenderer === "boolean") {
      prefs = { ...prefs, webglRenderer: patch.webglRenderer };
    }
    const theme = resolveTerminalTheme(prefs.themeMode);
    for (const entry of client.tabs.values()) {
      entry.tab?.applyPreferences?.({
        fontSize: prefs.fontSize,
        scrollback: prefs.scrollbackLimit,
        smoothScrollDuration: prefs.smoothScrollDuration,
      });
      entry.tab?.setTheme?.(theme);
      if (prefs.webglRenderer && globalThis.PicotXterm.WebglAddon) {
        entry.tab?.enableWebgl?.(() => new globalThis.PicotXterm.WebglAddon());
      } else {
        entry.tab?.disableWebgl?.();
      }
    }
  }

  return { client, panel, applyPreferences, unsubscribeTheme };
}

function getChatPanelFullscreenBounds() {
  const workspace = document.querySelector(".workspace");
  const workspaceContent = document.querySelector(".workspace-content");
  const main = document.querySelector(".workspace .main");
  if (!workspace || !workspaceContent || !main) return null;

  const workspaceRect = workspace.getBoundingClientRect();
  const contentRect = workspaceContent.getBoundingClientRect();
  const mainRect = main.getBoundingClientRect();
  return {
    left: mainRect.left - workspaceRect.left,
    top: contentRect.top - workspaceRect.top,
    right: workspaceRect.right - mainRect.right,
  };
}

function createPanelClient(client, getPanel) {
  return {
    create: (profileId) => client.command({ type: "terminal_create", profileId }),
    close: (terminalId, generation) =>
      client.command({ type: "terminal_close", terminalId, generation }),
    restart: (terminalId, generation, profileId) =>
      client.command({ type: "terminal_restart", terminalId, generation, profileId }),
    focusTab: (id) => client.tabs.get(id)?.tab?.focus?.(),
    refitTab: (id) => client.tabs.get(id)?.tab?.refit?.(),
    refitAll: () => {
      for (const entry of client.tabs.values()) entry.tab?.refit?.();
    },
    setPanelHeight: (heightPx) => client.command({ type: "terminal_set_panel_height", heightPx }),
    checkpointAll: async () => {
      const pending = [];
      for (const [terminalId, entry] of client.tabs) {
        const snapshot = entry.tab.serializeForCheckpoint?.(2000);
        if (!snapshot) continue;
        pending.push(
          client.sendAndAwait(
            {
              type: "terminal_checkpoint",
              terminalId,
              generation: entry.generation,
              watermark: entry.lastAppliedSequence,
              snapshotBase64: encodeBase64(new TextEncoder().encode(snapshot)),
            },
            (message) =>
              message.type === "terminal_checkpoint_acked" && message.terminalId === terminalId,
          ),
        );
      }
      await Promise.all(pending);
    },
    closeAll: async () => {
      for (const [terminalId, entry] of client.tabs) {
        client.command({ type: "terminal_close", terminalId, generation: entry.generation });
      }
      client.reset();
      getPanel().setTabs([]);
    },
  };
}

export function formatTerminalStartError(message) {
  if (typeof message === "string" && message.includes("Git for Windows")) {
    return t("terminal.gitBashMissing");
  }
  return message || t("terminal.statusFailed");
}

export function handleTerminalFrame(frame, client, panel) {
  if (frame?.type === "error") {
    if (frame.error?.code === "terminal_command_failed") {
      panel.showStartError?.(formatTerminalStartError(frame.error.message));
      client.requestList();
    }
    return;
  }
  if (frame?.type === "terminal_event") {
    const payload = frame.payload || {};
    if (payload.type === "terminal_output") {
      client.applyOutput(payload);
      panel.markActivity(payload.terminalId);
    } else if (payload.type === "terminal_exited" || payload.type === "terminal_failed") {
      client.removeTab(payload.terminalId, payload.generation);
      client.requestList();
    }
    return;
  }
  if (typeof frame?.type !== "string" || !frame.type.startsWith("terminal_")) return;
  client.resolveResponse(frame);
  if (frame.type === "terminal_listed") {
    client.applyListed(frame);
    panel.setTabs(
      (frame.tabs || []).map(
        ({ terminalId, generation, label, profileId, status, historyGap, failReason }) => ({
          terminalId,
          generation,
          label,
          profileId,
          status,
          historyGap,
          failReason: failReason ? formatTerminalStartError(failReason) : undefined,
        }),
      ),
    );
    if (Number.isFinite(frame.panelHeightPx)) panel.setHeight(frame.panelHeightPx);
  } else if (["terminal_created", "terminal_restarted", "terminal_closed"].includes(frame.type)) {
    client.requestList();
  }
}
