/**
 * Internationalization — zero-dependency i18n for Picot.
 *
 * Storage note: language preference is persisted in a cookie (not
 * localStorage) for the same reason as themes — workspace windows run on
 * different localhost ports and localStorage is partitioned per origin.
 * A single `picot-language` cookie is visible to every workspace window.
 */

const LANGUAGE_COOKIE = "picot-language";
const LANGUAGE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

const SUPPORTED_PREFERENCES = new Set(["system", "en", "zh", "ja", "es"]);
const BCP47_TAG = { en: "en", zh: "zh-CN", ja: "ja", es: "es" };

/** English messages — loaded at init, serve as the fallback. */
let enMessages = {};
/** Active locale messages — may be the same object as enMessages. */
let activeMessages = {};
let currentLocale = "en";
let currentPreference = "system";
let initialized = false;
let localeLoadSequence = 0;
const listeners = new Set();
const warnedKeys = new Set();

export const LANGUAGES = [
  { value: "system", labelKey: "settings.language.systemDefault" },
  { value: "en", nativeLabel: "English" },
  { value: "zh", nativeLabel: "中文" },
  { value: "ja", nativeLabel: "日本語" },
  { value: "es", nativeLabel: "Español" },
];

// ── Preference normalization ──────────────────────────────────────────

function normalizePreference(preference) {
  return SUPPORTED_PREFERENCES.has(preference) ? preference : "system";
}

export function resolveLocale(preference, systemLanguage = navigator.language) {
  const pref = normalizePreference(preference);
  if (pref === "en") return "en";
  if (pref === "zh") return "zh";
  if (pref === "ja") return "ja";
  if (pref === "es") return "es";
  // system
  const lang = systemLanguage?.toLowerCase() ?? "";
  if (lang.startsWith("zh")) return "zh";
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("es")) return "es";
  return "en";
}

// ── Cookie helpers (mirrors public/themes.js pattern) ─────────────────

function readLanguageCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      const name = entry.slice(0, eq);
      if (name !== LANGUAGE_COOKIE) continue;
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

function writeLanguageCookie(preference) {
  try {
    const value = encodeURIComponent(preference);
    // biome-ignore lint/suspicious/noDocumentCookie: synchronous cross-port language persistence
    document.cookie = `${LANGUAGE_COOKIE}=${value}; Max-Age=${LANGUAGE_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

export function getLanguagePreference() {
  return normalizePreference(readLanguageCookie());
}

export function getLocale() {
  return currentLocale;
}

// ── Locale fetching & loading ─────────────────────────────────────────

async function fetchLocale(locale) {
  const res = await fetch(`/locales/${locale}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load locale ${locale}: ${res.status}`);
  return res.json();
}

/**
 * Returns one of:
 * - { locale: "en", messages: enMessages, fallback: false }
 * - { locale, messages, fallback: false }  (successful non-English fetch)
 * - { locale: "en", messages: enMessages, fallback: true, failedLocale } (failed non-English fetch)
 */
async function loadMessagesForLocale(locale) {
  if (locale === "en") {
    return { locale: "en", messages: enMessages, fallback: false };
  }
  try {
    const messages = await fetchLocale(locale);
    return { locale, messages, fallback: false };
  } catch {
    return { locale: "en", messages: enMessages, fallback: true, failedLocale: locale };
  }
}

// ── Lookup & interpolation ────────────────────────────────────────────

function lookup(messages, key) {
  if (!messages || typeof messages !== "object") return undefined;
  const parts = key.split(".");
  let current = messages;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return typeof current === "string" ? current : undefined;
}

function interpolate(text, params) {
  if (!params || typeof params !== "object") return text;
  return text.replace(/\{(\w+)\}/g, (_, name) => {
    const val = params[name];
    return val !== undefined && val !== null ? String(val) : "";
  });
}

export function t(key, params = {}) {
  const fromActive = lookup(activeMessages, key);
  if (fromActive !== undefined) return interpolate(fromActive, params);
  const fromEn = lookup(enMessages, key);
  if (fromEn !== undefined) return interpolate(fromEn, params);
  if (initialized && !warnedKeys.has(key)) {
    warnedKeys.add(key);
    console.warn(`[i18n] missing key: ${key}`);
  }
  return key;
}

// ── DOM translation application ───────────────────────────────────────

/**
 * Translate every `data-i18n*` attribute under `root`. Exported for components
 * that build their DOM after startup (a dialog created on first open): the
 * document-wide pass has already run by then, so the new subtree has to be
 * translated explicitly.
 */
export function applyTranslations(root = document) {
  if (!root) return;

  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  });
  root.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.setAttribute("alt", t(el.dataset.i18nAlt));
  });
}

function notifyLocaleChange() {
  for (const listener of listeners) {
    try {
      listener(currentLocale, currentPreference);
    } catch (e) {
      console.warn("[i18n] locale-change listener error:", e);
    }
  }

  window.dispatchEvent(
    new CustomEvent("picot:locale-change", {
      detail: { locale: currentLocale, preference: currentPreference },
    }),
  );
}

// ── Initialization ────────────────────────────────────────────────────

export async function initI18n() {
  try {
    // Always load English first — it's the fallback for everything.
    try {
      enMessages = await fetchLocale("en");
    } catch (e) {
      console.warn("[i18n] failed to load English locale:", e);
      enMessages = {};
    }
    activeMessages = enMessages;

    currentPreference = getLanguagePreference();
    const targetLocale = resolveLocale(currentPreference);

    if (targetLocale !== "en") {
      const result = await loadMessagesForLocale(targetLocale);
      activeMessages = result.messages;
      currentLocale = result.locale;
    } else {
      currentLocale = "en";
    }
  } catch (e) {
    // initI18n must never throw — degrade to English silently.
    console.warn("[i18n] initialization error, falling back to English:", e);
    activeMessages = enMessages;
    currentLocale = "en";
    currentPreference = "system";
  }

  initialized = true;
  document.documentElement.lang = BCP47_TAG[currentLocale] || "en";
  applyTranslations(document);
  notifyLocaleChange();
}

// ── Locale switching ──────────────────────────────────────────────────

export async function setLocale(preference) {
  const sequence = ++localeLoadSequence;
  const pref = normalizePreference(preference);
  const targetLocale = resolveLocale(pref);

  const result = await loadMessagesForLocale(targetLocale);

  // Discard stale result — a later setLocale call has superseded us.
  if (sequence !== localeLoadSequence) return;

  activeMessages = result.messages;
  currentLocale = result.locale;
  currentPreference = result.fallback ? "system" : pref;

  // Only persist the cookie when the requested locale loaded successfully.
  if (!result.fallback) {
    writeLanguageCookie(pref);
  }

  document.documentElement.lang = BCP47_TAG[currentLocale] || "en";
  applyTranslations(document);
  notifyLocaleChange();
}

export function onLocaleChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
