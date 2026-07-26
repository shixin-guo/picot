/**
 * Lightweight display-language (i18n) helper for Picot public UI.
 * Storage key: pi-studio-locale  (localStorage; per origin/port)
 */

import en from "./en.js";
import zh from "./zh.js";

export const LOCALE_STORAGE_KEY = "pi-studio-locale";
export const SUPPORTED_LOCALES = ["en", "zh"];

const dictionaries = { en, zh };
const listeners = new Set();

function detectDefaultLocale() {
  try {
    const lang = String(navigator.language || navigator.userLanguage || "en").toLowerCase();
    if (lang.startsWith("zh")) return "zh";
  } catch {
    /* ignore */
  }
  return "en";
}

function readStoredLocale() {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (raw && SUPPORTED_LOCALES.includes(raw)) return raw;
  } catch {
    /* ignore */
  }
  return null;
}

function normalizeLocale(locale) {
  const value = String(locale || "").toLowerCase();
  if (value.startsWith("zh")) return "zh";
  if (value.startsWith("en")) return "en";
  if (SUPPORTED_LOCALES.includes(value)) return value;
  return null;
}

let currentLocale = readStoredLocale() || detectDefaultLocale();

function interpolate(template, params) {
  if (!params || typeof template !== "string") return template;
  return template.replace(/\{(\w+)\}/g, (_, key) =>
    params[key] == null ? `{${key}}` : String(params[key]),
  );
}

export function getLocale() {
  return currentLocale;
}

export function setLocale(locale, { persist = true } = {}) {
  const next = normalizeLocale(locale) || "en";
  const changed = next !== currentLocale;
  currentLocale = next;
  if (persist) {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* ignore quota / private mode */
    }
  }
  try {
    document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.locale = next;
  } catch {
    /* ignore */
  }
  if (changed) {
    for (const fn of listeners) {
      try {
        fn(next);
      } catch (err) {
        console.error("[i18n] onLocaleChange listener failed:", err);
      }
    }
  }
  return next;
}

export function t(key, params) {
  const dict = dictionaries[currentLocale] || en;
  const fallback = en[key];
  const value = dict[key] ?? fallback ?? key;
  return interpolate(value, params);
}

export function onLocaleChange(fn) {
  if (typeof fn !== "function") return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applyAttr(el, attrName, dataAttr) {
  const key = el.getAttribute(dataAttr);
  if (!key) return;
  const value = t(key);
  if (attrName === "text") {
    el.textContent = value;
  } else {
    el.setAttribute(attrName, value);
  }
}

/**
 * Apply translations to elements under root.
 * Supports: data-i18n, data-i18n-placeholder, data-i18n-title, data-i18n-aria-label
 * Also syncs document.documentElement.lang.
 */
export function applyI18n(root = document) {
  try {
    document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
    document.documentElement.dataset.locale = currentLocale;
  } catch {
    /* ignore */
  }

  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => applyAttr(el, "text", "data-i18n"));
  scope
    .querySelectorAll("[data-i18n-placeholder]")
    .forEach((el) => applyAttr(el, "placeholder", "data-i18n-placeholder"));
  scope
    .querySelectorAll("[data-i18n-title]")
    .forEach((el) => applyAttr(el, "title", "data-i18n-title"));
  scope
    .querySelectorAll("[data-i18n-aria-label]")
    .forEach((el) => applyAttr(el, "aria-label", "data-i18n-aria-label"));
}

// Ensure html lang matches current locale as soon as this module evaluates.
try {
  document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.locale = currentLocale;
} catch {
  /* ignore */
}

export default {
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  getLocale,
  setLocale,
  t,
  applyI18n,
  onLocaleChange,
};
