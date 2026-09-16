// ABOUTME: Owns the Appearance settings page controls: three five-level font
// sliders (chat / preview / terminal), preview + terminal theme selects, and
// the terminal display inputs. The cookie is the synchronous first-paint
// cache applied immediately on every change; the host preference DB is the
// durable truth reconciled on activation. Terminal changes are delegated to
// the injected terminal integration, never applied to terminal DOM here.

import { onLocaleChange, t } from "../../i18n.js";
import { themes } from "../../themes.js";
import {
  applyAppearanceToDom,
  loadAppearanceCookie,
  normalizeFontLevel,
  normalizePreviewThemeMode,
  normalizeScrollbackLimit,
  normalizeSmoothScrollDuration,
  normalizeThemeMode,
  PREVIEW_THEME_MODES,
  saveAppearanceCookie,
  TERMINAL_FONT_SIZE_PX,
  TERMINAL_THEME_MODES,
} from "./appearance-preferences.js";

const PREFERENCE_KEYS = Object.freeze({
  chatFontSize: "ui.chatFontSize",
  previewFontSize: "ui.previewFontSize",
  previewTheme: "ui.previewTheme",
  terminalFontSize: "ui.terminalFontSize",
  terminalThemeMode: "ui.terminalThemeMode",
  terminalScrollbackLimit: "ui.terminalScrollbackLimit",
  terminalSmoothScrollDuration: "ui.terminalSmoothScrollDuration",
  terminalWebglRenderer: "ui.terminalWebglRenderer",
});

function currentPicotThemeIsDark() {
  const themeId = document.documentElement.getAttribute("data-theme");
  return themes[themeId]?.dark ?? true;
}

function applyDom() {
  applyAppearanceToDom({
    chatFontSize: loadAppearanceCookie().chatFontSize,
    previewFontSize: loadAppearanceCookie().previewFontSize,
    previewTheme: loadAppearanceCookie().previewTheme,
    picotThemeIsDark: currentPicotThemeIsDark(),
  });
}

/**
 * Render one five-dot segmented control: checked radio, active class, level
 * name, and the sliding thumb. Same visual contract as the thinking-effort
 * control, but purely local — the thinking control is runtime-coupled.
 */
function renderSegmented({ group, name, marker, value, nameFor }) {
  const dots = Array.from(group.querySelectorAll(".thinking-effort-dot"));
  const index = dots.findIndex((dot) => dot.dataset.level === value);
  if (index === -1) return;
  for (let i = 0; i < dots.length; i++) {
    dots[i].checked = i === index;
    dots[i].classList.toggle("active", i === index);
  }
  if (name) name.textContent = nameFor(value);
  if (marker && dots[index]) {
    const button = dots[index];
    const offset = button.offsetLeft + (button.offsetWidth - marker.offsetWidth) / 2;
    marker.style.left = `${offset}px`;
  }
}

function levelLabel(level) {
  return t(`settings.fontLevel.${level}`);
}

export function setupAppearanceSettings({ preferences, terminal } = {}) {
  const controls = [
    {
      key: "chatFontSize",
      group: document.getElementById("settings-chat-font-size"),
      name: document.getElementById("settings-chat-font-size-name"),
      marker: document.getElementById("settings-chat-font-size-marker"),
    },
    {
      key: "previewFontSize",
      group: document.getElementById("settings-preview-font-size"),
      name: document.getElementById("settings-preview-font-size-name"),
      marker: document.getElementById("settings-preview-font-size-marker"),
    },
    {
      key: "terminalFontSize",
      group: document.getElementById("settings-terminal-font-size"),
      name: document.getElementById("settings-terminal-font-size-name"),
      marker: document.getElementById("settings-terminal-font-size-marker"),
    },
  ].filter((control) => control.group);

  const previewThemeSelect = document.getElementById("settings-preview-theme-select");
  const terminalThemeSelect = document.getElementById("settings-terminal-theme-select");
  const scrollbackInput = document.getElementById("settings-terminal-scrollback-input");
  const smoothScrollInput = document.getElementById("settings-terminal-smooth-scroll-input");
  const webglToggle = document.getElementById("toggle-terminal-webgl");

  // Best-effort persistence: a preference-gateway failure must never block
  // the local (cookie + DOM) application of a setting.
  const persist = (key, value) => {
    preferences?.set(key, value).catch(() => {});
  };
  const localChangeVersions = new Map();
  let reconcileRunId = 0;

  function markLocalChange(field) {
    localChangeVersions.set(field, (localChangeVersions.get(field) || 0) + 1);
  }

  function renderControls() {
    const cookie = loadAppearanceCookie();
    for (const control of controls) {
      renderSegmented({
        group: control.group,
        name: control.name,
        marker: control.marker,
        value: cookie[control.key],
        nameFor: levelLabel,
      });
    }
    fillThemeSelect(previewThemeSelect, PREVIEW_THEME_MODES, cookie.previewTheme, {
      system: "settings.preview.themeSystem",
      light: "settings.preview.themeLight",
      dark: "settings.preview.themeDark",
    });
    fillThemeSelect(terminalThemeSelect, TERMINAL_THEME_MODES, cookie.terminalThemeMode, {
      system: "settings.terminal.themeSystem",
      light: "settings.terminal.themeLight",
      dark: "settings.terminal.themeDark",
    });
    if (scrollbackInput) scrollbackInput.value = String(cookie.terminalScrollbackLimit);
    if (smoothScrollInput) smoothScrollInput.value = String(cookie.terminalSmoothScrollDuration);
    if (webglToggle) {
      const enabled =
        typeof cookie.terminalWebglRenderer === "boolean"
          ? cookie.terminalWebglRenderer
          : undefined;
      // Absent means "never touched": leave the switch off but do not persist
      // a platform default the user never chose. The terminal integration
      // applies the real platform default when creating tabs.
      webglToggle.classList.toggle("on", enabled === true);
      webglToggle.setAttribute("aria-checked", String(enabled === true));
    }
  }

  function setFontLevel(key, level) {
    markLocalChange(key);
    saveAppearanceCookie({ [key]: level });
    applyDom();
    persist(PREFERENCE_KEYS[key], level);
    if (key === "terminalFontSize") {
      terminal?.applyPreferences?.({ fontSize: TERMINAL_FONT_SIZE_PX[level] });
    }
    renderControls();
  }

  function setPreviewTheme(mode) {
    const normalized = normalizePreviewThemeMode(mode);
    markLocalChange("previewTheme");
    saveAppearanceCookie({ previewTheme: normalized });
    applyDom();
    persist(PREFERENCE_KEYS.previewTheme, normalized);
    renderControls();
  }

  function setTerminalTheme(mode) {
    const normalized = normalizeThemeMode(mode);
    markLocalChange("terminalThemeMode");
    saveAppearanceCookie({ terminalThemeMode: normalized });
    terminal?.applyPreferences?.({ themeMode: normalized });
    persist(PREFERENCE_KEYS.terminalThemeMode, normalized);
    renderControls();
  }

  function setScrollback(value) {
    const normalized = normalizeScrollbackLimit(value);
    markLocalChange("terminalScrollbackLimit");
    saveAppearanceCookie({ terminalScrollbackLimit: normalized });
    if (scrollbackInput) scrollbackInput.value = String(normalized);
    terminal?.applyPreferences?.({ scrollbackLimit: normalized });
    persist(PREFERENCE_KEYS.terminalScrollbackLimit, normalized);
  }

  function setSmoothScroll(value) {
    const normalized = normalizeSmoothScrollDuration(value);
    markLocalChange("terminalSmoothScrollDuration");
    saveAppearanceCookie({ terminalSmoothScrollDuration: normalized });
    if (smoothScrollInput) smoothScrollInput.value = String(normalized);
    terminal?.applyPreferences?.({ smoothScrollDuration: normalized });
    persist(PREFERENCE_KEYS.terminalSmoothScrollDuration, normalized);
  }

  function setWebgl(enabled) {
    markLocalChange("terminalWebglRenderer");
    saveAppearanceCookie({ terminalWebglRenderer: enabled });
    if (webglToggle) {
      webglToggle.classList.toggle("on", enabled);
      webglToggle.setAttribute("aria-checked", String(enabled));
    }
    terminal?.applyPreferences?.({ webglRenderer: enabled });
    persist(PREFERENCE_KEYS.terminalWebglRenderer, enabled);
  }

  for (const control of controls) {
    control.group.addEventListener("change", (event) => {
      const dot = event.target.closest(".thinking-effort-dot");
      if (dot) setFontLevel(control.key, normalizeFontLevel(dot.dataset.level));
    });
    control.group.addEventListener("click", (event) => {
      // Keep the label/thumb hit behavior: clicking anywhere on a dot's
      // position selects that level (radios already handle this; this covers
      // clicks on the thumb overlay).
      const dot = event.target.closest(".thinking-effort-dot");
      if (dot && !dot.checked) dot.click();
    });
  }
  previewThemeSelect?.addEventListener("change", () => setPreviewTheme(previewThemeSelect.value));
  terminalThemeSelect?.addEventListener("change", () =>
    setTerminalTheme(terminalThemeSelect.value),
  );
  scrollbackInput?.addEventListener("change", () => setScrollback(scrollbackInput.value));
  smoothScrollInput?.addEventListener("change", () => setSmoothScroll(smoothScrollInput.value));
  webglToggle?.addEventListener("click", () => {
    setWebgl(webglToggle.getAttribute("aria-checked") !== "true");
  });

  // Theme switches change the "system" resolution of the preview theme.
  const observer = new MutationObserver(() => applyDom());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  const unsubscribeLocale = onLocaleChange(renderControls);
  applyDom();
  renderControls();

  /**
   * DB is the durable truth; the cookie is the render cache. Existing DB
   * values win and refresh the cookie + DOM; missing DB values are seeded
   * from the cookie so a fresh install converges without user action.
   */
  async function reconcile() {
    const runId = ++reconcileRunId;
    const startedVersions = new Map(localChangeVersions);
    const isCurrent = (field) =>
      runId === reconcileRunId && localChangeVersions.get(field) === startedVersions.get(field);
    const readPreference = async (key) => {
      try {
        return { ok: true, value: await preferences?.get(key) };
      } catch {
        return { ok: false, value: undefined };
      }
    };
    const entries = [
      { key: PREFERENCE_KEYS.chatFontSize, field: "chatFontSize", normalize: normalizeFontLevel },
      {
        key: PREFERENCE_KEYS.previewFontSize,
        field: "previewFontSize",
        normalize: normalizeFontLevel,
      },
      {
        key: PREFERENCE_KEYS.previewTheme,
        field: "previewTheme",
        normalize: normalizePreviewThemeMode,
      },
      {
        key: PREFERENCE_KEYS.terminalFontSize,
        field: "terminalFontSize",
        normalize: normalizeFontLevel,
      },
      {
        key: PREFERENCE_KEYS.terminalThemeMode,
        field: "terminalThemeMode",
        normalize: normalizeThemeMode,
      },
      {
        key: PREFERENCE_KEYS.terminalScrollbackLimit,
        field: "terminalScrollbackLimit",
        normalize: normalizeScrollbackLimit,
      },
      {
        key: PREFERENCE_KEYS.terminalSmoothScrollDuration,
        field: "terminalSmoothScrollDuration",
        normalize: normalizeSmoothScrollDuration,
      },
    ];
    for (const entry of entries) {
      const result = await readPreference(entry.key);
      if (!isCurrent(entry.field) || !result.ok) continue;
      const current = loadAppearanceCookie();
      if (result.value === null || result.value === undefined) {
        persist(entry.key, current[entry.field]);
        continue;
      }
      const normalized = entry.normalize(result.value);
      if (normalized !== current[entry.field]) {
        saveAppearanceCookie({ [entry.field]: normalized });
      }
    }
    // WebGL: DB boolean wins; otherwise the cookie's explicit choice (or
    // absence, deferring to the platform default) stays. A failed read must
    // not be mistaken for a missing preference and must never trigger a write.
    const webglResult = await readPreference(PREFERENCE_KEYS.terminalWebglRenderer);
    if (isCurrent("terminalWebglRenderer") && webglResult.ok) {
      const current = loadAppearanceCookie();
      if (
        typeof webglResult.value === "boolean" &&
        webglResult.value !== current.terminalWebglRenderer
      ) {
        saveAppearanceCookie({ terminalWebglRenderer: webglResult.value });
      }
    }
    if (runId !== reconcileRunId) return;
    applyDom();
    renderControls();
    const updated = loadAppearanceCookie();
    terminal?.applyPreferences?.({
      fontSize: TERMINAL_FONT_SIZE_PX[updated.terminalFontSize],
      themeMode: updated.terminalThemeMode,
      scrollbackLimit: updated.terminalScrollbackLimit,
      smoothScrollDuration: updated.terminalSmoothScrollDuration,
      ...(typeof updated.terminalWebglRenderer === "boolean"
        ? { webglRenderer: updated.terminalWebglRenderer }
        : {}),
    });
  }

  return {
    activate: () => {
      renderControls();
      void reconcile();
    },
    reconcile,
    dispose: () => {
      reconcileRunId += 1;
      observer.disconnect();
      unsubscribeLocale();
    },
  };
}

function fillThemeSelect(select, modes, current, labelKeys) {
  if (!select) return;
  select.replaceChildren();
  for (const mode of modes) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = t(labelKeys[mode]);
    option.selected = mode === current;
    select.append(option);
  }
}
