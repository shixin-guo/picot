// ABOUTME: Appearance preferences for the dedicated Appearance settings page:
// ABOUTME: five-level font sizes (chat / preview / terminal), the preview
// ABOUTME: theme mode, and every terminal display preference (theme mode,
// ABOUTME: scrollback, smooth scroll, WebGL). The cookie is the synchronous
// ABOUTME: first-paint cache; the host preference DB is the durable truth.

/**
 * Shared five-level font size scale. Per-surface px maps live in the
 * *_FONT_SIZE_PX tables; `normal` always equals the previously hardcoded
 * value for that surface.
 */
export const FONT_SIZE_LEVELS = ["small", "normal", "medium", "large", "xlarge"];
export const DEFAULT_FONT_SIZE_LEVEL = "normal";

export const CHAT_FONT_SIZE_PX = { small: 14, normal: 16, medium: 18, large: 20, xlarge: 22 };
export const PREVIEW_FONT_SIZE_PX = { small: 11, normal: 13, medium: 15, large: 17, xlarge: 19 };
export const TERMINAL_FONT_SIZE_PX = { small: 12, normal: 15, medium: 18, large: 22, xlarge: 26 };

/** Preview color scheme modes: follow the Picot theme, or force one. */
export const PREVIEW_THEME_MODES = ["system", "light", "dark"];
export const DEFAULT_PREVIEW_THEME_MODE = "system";

/** Terminal color scheme modes: follow the Picot theme, or force one. */
export const TERMINAL_THEME_MODES = ["system", "light", "dark"];
export const DEFAULT_TERMINAL_THEME_MODE = "dark";
export const DEFAULT_SCROLLBACK_LIMIT = 1000;
export const DEFAULT_SMOOTH_SCROLL_DURATION = 0;

const APPEARANCE_COOKIE = "picot-appearance";
const APPEARANCE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

export function normalizeFontLevel(value) {
  return FONT_SIZE_LEVELS.includes(value) ? value : DEFAULT_FONT_SIZE_LEVEL;
}

/**
 * Map a legacy pixel value onto the closest level of `pxMap`. Ties pick the
 * lower level; non-finite input falls back to the default level.
 */
export function nearestFontLevel(px, pxMap) {
  const value = Number(px);
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE_LEVEL;
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of FONT_SIZE_LEVELS) {
    const distance = Math.abs(pxMap[level] - value);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** Unknown/stale preview theme values fall back to system. */
export function normalizePreviewThemeMode(value) {
  return PREVIEW_THEME_MODES.includes(value) ? value : DEFAULT_PREVIEW_THEME_MODE;
}

/** Unknown/stale terminal theme values fall back to dark. */
export function normalizeThemeMode(value) {
  return TERMINAL_THEME_MODES.includes(value) ? value : DEFAULT_TERMINAL_THEME_MODE;
}

function clampNumber(value, fallback, min, max) {
  if (value === "" || value === null || value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.round(Math.min(max, Math.max(min, number)));
}

export function normalizeScrollbackLimit(value) {
  return clampNumber(value, DEFAULT_SCROLLBACK_LIMIT, 100, 50000);
}

export function normalizeSmoothScrollDuration(value) {
  return clampNumber(value, DEFAULT_SMOOTH_SCROLL_DURATION, 0, 1000);
}

/**
 * WebGL renderer is opt-in per platform: default ON on macOS/Linux, OFF on
 * Windows until GPU driver coverage is validated. `userAgent` is injectable
 * for tests.
 */
export function defaultWebglRenderer(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
) {
  return !/Windows/i.test(userAgent);
}

/**
 * Resolve the effective preview color scheme: "light"/"dark" force a side,
 * "system" follows the active Picot theme's dark flag.
 */
export function resolvePreviewTheme(mode, picotThemeIsDark) {
  if (mode === "light") return "light";
  if (mode === "dark") return "dark";
  return picotThemeIsDark ? "dark" : "light";
}

function readAppearanceCookieRaw() {
  try {
    const prefix = `${APPEARANCE_COOKIE}=`;
    const entry = document.cookie.split("; ").find((cookie) => cookie.startsWith(prefix));
    if (!entry) return null;
    return JSON.parse(decodeURIComponent(entry.slice(prefix.length)));
  } catch {
    return null;
  }
}

function writeAppearanceCookieRaw(value) {
  try {
    const serialized = encodeURIComponent(JSON.stringify(value));
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async; the synchronous first-paint cache needs document.cookie (same as themes.js)
    document.cookie = `${APPEARANCE_COOKIE}=${serialized}; Max-Age=${APPEARANCE_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — sandboxed contexts fall back to defaults until a DB reconcile
  }
}

/**
 * Normalized appearance values from the cookie cache; defaults when
 * absent/corrupt. `terminalWebglRenderer` is the one field without a static
 * default — absent means "never touched", which defers to the platform
 * default (defaultWebglRenderer), so it stays undefined instead.
 */
export function loadAppearanceCookie() {
  const raw = readAppearanceCookieRaw() || {};
  return {
    chatFontSize: normalizeFontLevel(raw.chatFontSize),
    previewFontSize: normalizeFontLevel(raw.previewFontSize),
    previewTheme: normalizePreviewThemeMode(raw.previewTheme),
    terminalFontSize: normalizeFontLevel(raw.terminalFontSize),
    terminalThemeMode: normalizeThemeMode(raw.terminalThemeMode),
    terminalScrollbackLimit: normalizeScrollbackLimit(raw.terminalScrollbackLimit),
    terminalSmoothScrollDuration: normalizeSmoothScrollDuration(raw.terminalSmoothScrollDuration),
    terminalWebglRenderer:
      typeof raw.terminalWebglRenderer === "boolean" ? raw.terminalWebglRenderer : undefined,
  };
}

/** Merge a patch into the cookie cache (values normalized before writing). */
export function saveAppearanceCookie(patch) {
  const merged = { ...loadAppearanceCookie(), ...(patch || {}) };
  writeAppearanceCookieRaw({
    chatFontSize: normalizeFontLevel(merged.chatFontSize),
    previewFontSize: normalizeFontLevel(merged.previewFontSize),
    previewTheme: normalizePreviewThemeMode(merged.previewTheme),
    terminalFontSize: normalizeFontLevel(merged.terminalFontSize),
    terminalThemeMode: normalizeThemeMode(merged.terminalThemeMode),
    terminalScrollbackLimit: normalizeScrollbackLimit(merged.terminalScrollbackLimit),
    terminalSmoothScrollDuration: normalizeSmoothScrollDuration(
      merged.terminalSmoothScrollDuration,
    ),
    terminalWebglRenderer:
      typeof merged.terminalWebglRenderer === "boolean" ? merged.terminalWebglRenderer : undefined,
  });
}

/**
 * Mirror the rendered appearance onto the document: font-size custom
 * properties, plus the preview theme attribute CSS scopes its light/dark
 * overrides against. In "system" mode the attribute is REMOVED so the panel
 * keeps the active Picot theme's own palette; only forced modes set it.
 */
export function applyAppearanceToDom({
  chatFontSize,
  previewFontSize,
  previewTheme,
  picotThemeIsDark,
}) {
  const root = document.documentElement;
  root.style.setProperty(
    "--chat-font-size",
    `${CHAT_FONT_SIZE_PX[normalizeFontLevel(chatFontSize)]}px`,
  );
  root.style.setProperty(
    "--preview-font-size",
    `${PREVIEW_FONT_SIZE_PX[normalizeFontLevel(previewFontSize)]}px`,
  );
  const mode = normalizePreviewThemeMode(previewTheme);
  if (mode === "system") {
    root.removeAttribute("data-preview-theme");
  } else {
    root.setAttribute("data-preview-theme", resolvePreviewTheme(mode, picotThemeIsDark));
  }
}

/**
 * One-time migration: the terminal display preferences used to live in a
 * per-origin localStorage payload (each workspace window runs on a different
 * port, so those values never synced across windows or machines). Lift the
 * customized legacy fields onto the global cookie — seeding only values the
 * user actually changed — and delete the storage key. Idempotent;
 * best-effort (defaults apply on any unexpected input).
 */
export function migrateLegacyTerminalPreferences(storage) {
  const KEY = "picot.terminal.preferences";
  if (!storage) return;
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return;
    let legacy;
    try {
      legacy = JSON.parse(raw);
    } catch {
      legacy = null;
    }
    storage.removeItem(KEY);
    if (!legacy || typeof legacy !== "object") return;
    const seed = {};
    if (Number.isFinite(Number(legacy.fontSize))) {
      const level = nearestFontLevel(legacy.fontSize, TERMINAL_FONT_SIZE_PX);
      if (level !== DEFAULT_FONT_SIZE_LEVEL) seed.terminalFontSize = level;
    }
    const themeMode = normalizeThemeMode(legacy.themeMode);
    if (themeMode !== DEFAULT_TERMINAL_THEME_MODE) seed.terminalThemeMode = themeMode;
    const scrollback = normalizeScrollbackLimit(legacy.scrollbackLimit);
    if (scrollback !== DEFAULT_SCROLLBACK_LIMIT) seed.terminalScrollbackLimit = scrollback;
    const smooth = normalizeSmoothScrollDuration(legacy.smoothScrollDuration);
    if (smooth !== DEFAULT_SMOOTH_SCROLL_DURATION) seed.terminalSmoothScrollDuration = smooth;
    if (
      typeof legacy.webglRenderer === "boolean" &&
      legacy.webglRenderer !== defaultWebglRenderer()
    ) {
      seed.terminalWebglRenderer = legacy.webglRenderer;
    }
    if (Object.keys(seed).length > 0) saveAppearanceCookie(seed);
  } catch {
    // best-effort migration; defaults apply when anything unexpected happens
  }
}
