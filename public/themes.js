/**
 * Theme system — four themes: two light, two dark
 *
 * Storage note: the active theme is persisted in a cookie (not
 * localStorage). Pi Studio spawns one pi process per workspace, each on
 * its own port, and every workspace window is loaded from
 * `http://localhost:<port>`. localStorage is partitioned per origin, so
 * `localhost:3001` and `localhost:3002` would each see a different
 * `pi-studio-theme` value — meaning any new project window would forget
 * the user's theme and fall back to the OS default (usually dark). Cookies
 * on `localhost` are shared across ports, so a single cookie is visible
 * to every workspace window.
 */

export const themes = {
  night: {
    name: 'Dusk',
    dark: true,
    colors: ['#212121', '#a0a0a0', '#777777', '#666666'],
    vars: {},
  },
  dawn: {
    name: 'Dawn',
    dark: true,
    colors: ['#1a1d26', '#7a8ab0', '#6a5a80', '#5a7a9a'],
    vars: {},
  },
  midnight: {
    name: 'Midnight',
    dark: true,
    colors: ['#000000', '#5a7a9a', '#4a5565', '#4a5a72'],
    vars: {},
  },
  clean: {
    name: 'Clean',
    dark: false,
    colors: ['#ffffff', '#0580c4', '#007aff', '#5ac8fa'],
    vars: {},
  },
  terracotta: {
    name: 'Terracotta',
    dark: false,
    colors: ['#f4f1ec', '#b06a48', '#5c2860', '#3a6a9b'],
    vars: {},
  },
  sage: {
    name: 'Sage',
    dark: false,
    colors: ['#f0f2ec', '#6a7d5a', '#4a3860', '#3a6a7a'],
    vars: {},
  },
};

const THEME_COOKIE = 'pi-studio-theme';
const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

function readThemeCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split('; ') : [];
    for (const entry of cookies) {
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      const name = entry.slice(0, eq);
      if (name !== THEME_COOKIE) continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {
    // document.cookie can throw in sandboxed contexts; treat as missing.
  }
  return null;
}

function writeThemeCookie(themeId) {
  try {
    const value = encodeURIComponent(themeId);
    document.cookie = `${THEME_COOKIE}=${value}; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

// One-time migration: lift any previously saved value out of the per-origin
// localStorage and into the cross-port cookie. Old key is left in place so
// downgrades stay readable; new writes always go to the cookie.
function migrateLegacyLocalStorageValue() {
  try {
    if (readThemeCookie()) return;
    const legacy = localStorage.getItem(THEME_COOKIE);
    if (legacy) writeThemeCookie(legacy);
  } catch {
    // localStorage may be unavailable; nothing to migrate
  }
}

migrateLegacyLocalStorageValue();

export function applyTheme(themeId) {
  const root = document.documentElement;
  if (!themes[themeId]) themeId = 'night';
  root.setAttribute('data-theme', themeId);
  writeThemeCookie(themeId);
}

export function getCurrentTheme() {
  const saved = readThemeCookie();
  if (saved === 'dark') return 'night';
  if (saved === 'light') return 'terracotta';
  if (saved && themes[saved]) return saved;
  if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'terracotta';
  return 'night';
}

// Track OS theme changes only when the user hasn't picked a theme yet.
// As soon as a cookie exists (set by applyTheme) this listener becomes a
// no-op, so the user's explicit choice wins.
if (!readThemeCookie()) {
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!readThemeCookie()) {
      const root = document.documentElement;
      root.setAttribute('data-theme', e.matches ? 'terracotta' : 'night');
    }
  });
}
