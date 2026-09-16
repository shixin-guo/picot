// ABOUTME: One xterm.js terminal instance adapter: input/size events to client
// ABOUTME: calls, snapshot/output application, and idempotent teardown. Never
// ABOUTME: puts terminal bytes or OSC titles into HTML (textContent only, elsewhere).

/**
 * TerminalTab wraps one xterm.js Terminal + Fit/Serialize addons behind an
 * injectable factory so jsdom tests assert Picot behavior, not xterm internals.
 * Production passes `globalThis.PicotXterm` factories.
 */
import { loadTerminalFont } from "./terminal-font.js";

export class TerminalTab {
  constructor({
    terminalId,
    generation,
    container,
    terminalFactory,
    fitAddonFactory,
    serializeAddonFactory,
    sendInput,
    sendResize,
    fontFamily,
    fontSize,
    initialTheme,
    loadFont = () => loadTerminalFont({ family: fontFamily, fontSize }),
  }) {
    this.terminalId = terminalId;
    this.generation = generation;
    this.sendInput = sendInput;
    this.sendResize = sendResize;
    this.lastAppliedSequence = 0;
    this.destroyed = false;
    this.resizeTimer = null;
    this.webglAddon = null;
    this._fontReady = Promise.resolve()
      .then(() => loadFont())
      .catch(() => undefined);

    this.terminal = terminalFactory();
    this.fitAddon = fitAddonFactory();
    this.serializeAddon = serializeAddonFactory();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(this.serializeAddon);
    if (container) {
      this.terminal.open(container);
    }
    if (this.terminal.options) {
      this.terminal.options.theme = initialTheme || picotThemeToXterm();
    }

    this._dataDisposable = this.terminal.onData((data) => {
      if (this.destroyed) {
        return;
      }
      this.sendInput?.(this.terminalId, this.generation, encodeBase64(toBytes(data)));
    });
    this._resizeDisposable = this.terminal.onResize(({ cols, rows }) => {
      this._scheduleResize(cols, rows);
    });
    // Never measure xterm cells against the fallback font. Callers can await
    // `ready` when they need to know the first fit has completed.
    this.ready = this._fontReady.then(() => this._fit());
  }

  refit() {
    return this._fontReady.then(() => this._fit());
  }

  _fit() {
    if (this.destroyed) return;
    try {
      this.fitAddon.fit();
    } catch {
      // Container not measurable yet (hidden/collapsed); caller refits on activation.
    }
  }

  focus() {
    try {
      this.terminal.focus();
    } catch {
      // Ignore focus errors during teardown.
    }
  }

  writeSnapshot(snapshotBase64) {
    const text = decodeBase64(snapshotBase64);
    try {
      this.terminal.reset();
      this.terminal.write(text);
    } catch {
      // Ignore write errors during teardown.
    }
  }

  writeOutput(dataBase64) {
    const bytes = decodeBase64(dataBase64);
    try {
      this.terminal.write(bytes);
    } catch {
      // Ignore write errors during teardown.
    }
  }

  ack(sequence) {
    this.lastAppliedSequence = sequence;
  }

  /** Serialize the screen plus up to `scrollback` lines for a checkpoint. */
  serializeForCheckpoint(scrollback = 2000) {
    return this.serializeAddon.serialize({ scrollback });
  }

  setGeneration(generation) {
    this.generation = generation;
  }

  setTheme(theme) {
    if (!this.destroyed && this.terminal?.options) {
      this.terminal.options.theme = theme;
      // xterm 6 should redraw on theme change, but force a refresh in case the
      // renderer does not pick up the new background immediately.
      try {
        this.terminal.refresh(0, (this.terminal.rows || 1) - 1);
      } catch {
        // refresh is best-effort across xterm versions
      }
    }
  }

  /**
   * Apply display-only xterm options without recreating the live terminal.
   * `fontSize` triggers a refit; scrollback and smooth scrolling take effect
   * through xterm's mutable option surface.
   */
  applyPreferences(prefs = {}) {
    if (this.destroyed || !this.terminal?.options) {
      return false;
    }
    let changed = false;
    let refit = false;
    const options = this.terminal.options;
    if (Number.isFinite(prefs.fontSize) && options.fontSize !== prefs.fontSize) {
      options.fontSize = prefs.fontSize;
      changed = true;
      refit = true;
    }
    if (Number.isFinite(prefs.scrollback) && options.scrollback !== prefs.scrollback) {
      options.scrollback = prefs.scrollback;
      changed = true;
    }
    if (
      Number.isFinite(prefs.smoothScrollDuration) &&
      options.smoothScrollDuration !== prefs.smoothScrollDuration
    ) {
      options.smoothScrollDuration = prefs.smoothScrollDuration;
      changed = true;
    }
    if (refit) {
      this._fontReady.then(() => this._fit());
    }
    return changed;
  }

  /**
   * Upgrade a DOM-rendered tab to WebGL at runtime (settings toggle).
   * Returns whether the upgrade succeeded; on failure the DOM renderer stays.
   */
  enableWebgl(factory) {
    if (this.destroyed || this.webglAddon || typeof factory !== "function") {
      return false;
    }
    try {
      this.webglAddon = factory();
      this.terminal.loadAddon(this.webglAddon);
    } catch {
      this.webglAddon = null;
    }
    return this.webglAddon !== null;
  }

  /** Drop the WebGL renderer and return to the DOM renderer. */
  disableWebgl() {
    if (this.destroyed || !this.webglAddon) {
      return false;
    }
    try {
      this.webglAddon.dispose();
    } catch {
      // Already gone.
    }
    this.webglAddon = null;
    return true;
  }

  /** Destroy listeners, addons, and the terminal. Idempotent. */
  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    this._dataDisposable?.dispose?.();
    this._resizeDisposable?.dispose?.();
    this._dataDisposable = null;
    this._resizeDisposable = null;
    if (this.webglAddon) {
      try {
        this.webglAddon.dispose();
      } catch {
        // Already gone.
      }
      this.webglAddon = null;
    }
    try {
      this.terminal?.dispose?.();
    } catch {
      // Ignore double-dispose.
    }
  }

  _scheduleResize(cols, rows) {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
    }
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      if (this.destroyed) {
        return;
      }
      this.sendResize?.(this.terminalId, this.generation, cols, rows);
    }, 100);
  }
}

function toBytes(str) {
  return new TextEncoder().encode(str);
}

export function encodeBase64(bytes) {
  let bin = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export function decodeBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

const TERMINAL_DARK_THEMES = new Set(["night", "dawn", "midnight"]);
const ANSI_DARK = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};
const ANSI_LIGHT = {
  black: "#000000",
  red: "#c72424",
  green: "#008000",
  yellow: "#b58900",
  blue: "#0000ff",
  magenta: "#a020f0",
  cyan: "#008080",
  white: "#ffffff",
  brightBlack: "#808080",
  brightRed: "#dc3232",
  brightGreen: "#00b300",
  brightYellow: "#d4a900",
  brightBlue: "#4040ff",
  brightMagenta: "#b340d0",
  brightCyan: "#00b3b3",
  brightWhite: "#ffffff",
};

/** Bridge the active Picot theme (CSS variables) into an xterm theme object. */
export function picotThemeToXterm() {
  const cs = getComputedStyle(document.documentElement);
  const get = (name) => cs.getPropertyValue(name).trim();
  const themeId = document.documentElement.getAttribute("data-theme") || "night";
  const ansi = TERMINAL_DARK_THEMES.has(themeId) ? ANSI_DARK : ANSI_LIGHT;
  return {
    background: get("--bg-solid") || "#000000",
    foreground: get("--text-primary") || "#e5e5e5",
    cursor: get("--text-primary") || "#e5e5e5",
    cursorAccent: get("--bg-solid") || "#000000",
    selection: get("--bg-glass-active") || "rgba(255,255,255,0.2)",
    ...ansi,
  };
}

// Canonical chrome for forced modes: picked from Picot's own dark/light theme
// surfaces (night --bg-solid #212121, clean --bg-solid #ffffff) so a forced
// terminal stays readable regardless of the active Picot theme.
const FORCED_DARK_CHROME = {
  background: "#212121",
  foreground: "rgba(255, 255, 255, 0.88)",
  cursor: "rgba(255, 255, 255, 0.88)",
  cursorAccent: "#212121",
  selection: "rgba(255, 255, 255, 0.2)",
};
const FORCED_LIGHT_CHROME = {
  background: "#ffffff",
  foreground: "rgba(0, 0, 0, 0.88)",
  cursor: "rgba(0, 0, 0, 0.88)",
  cursorAccent: "#ffffff",
  selection: "rgba(0, 0, 0, 0.2)",
};

/**
 * Resolve the xterm theme for a terminal themeMode preference: "system"
 * follows the active Picot theme; "light"/"dark" force a canonical palette.
 * Unknown modes fall back to the system behavior.
 */
export function resolveTerminalTheme(mode) {
  if (mode === "dark") {
    return { ...FORCED_DARK_CHROME, ...ANSI_DARK };
  }
  if (mode === "light") {
    return { ...FORCED_LIGHT_CHROME, ...ANSI_LIGHT };
  }
  return picotThemeToXterm();
}
