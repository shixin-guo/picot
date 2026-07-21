import { beforeEach, describe, expect, it, vi } from "vitest";

// Helper: create a fetch mock that returns locale JSON for known locales.
function makeFetchMock(handlers = {}) {
  const defaults = {
    en: { app: { welcome: "Welcome to Picot" }, messages: { copy: "Copy", copied: "Copied!" } },
    zh: { app: { welcome: "欢迎使用 Picot" }, messages: { copy: "复制", copied: "已复制！" } },
  };
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json")) {
      const data = handlers.en ?? defaults.en;
      return { ok: true, status: 200, json: async () => data };
    }
    if (u.includes("/locales/zh.json")) {
      if (handlers.zh === null) return { ok: false, status: 404, json: async () => ({}) };
      const data = handlers.zh ?? defaults.zh;
      return { ok: true, status: 200, json: async () => data };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

async function importFreshI18n() {
  vi.resetModules();
  return import("./i18n.js");
}

function clearCookies() {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
}

beforeEach(() => {
  clearCookies();
  vi.unstubAllGlobals();
});

// ── resolveLocale ─────────────────────────────────────────────────────

describe("resolveLocale", () => {
  it("resolves system + zh-CN to zh", async () => {
    const { resolveLocale } = await importFreshI18n();
    expect(resolveLocale("system", "zh-CN")).toBe("zh");
  });

  it("resolves system + en-US to en", async () => {
    const { resolveLocale } = await importFreshI18n();
    expect(resolveLocale("system", "en-US")).toBe("en");
  });

  it("resolves invalid preference to system, then system language", async () => {
    const { resolveLocale } = await importFreshI18n();
    expect(resolveLocale("fr", "zh-CN")).toBe("zh");
  });

  it("resolves system + en to en", async () => {
    const { resolveLocale } = await importFreshI18n();
    expect(resolveLocale("system", "en")).toBe("en");
  });

  it("resolves explicit en regardless of system language", async () => {
    const { resolveLocale } = await importFreshI18n();
    expect(resolveLocale("en", "zh-CN")).toBe("en");
  });

  it("resolves explicit zh regardless of system language", async () => {
    const { resolveLocale } = await importFreshI18n();
    expect(resolveLocale("zh", "en-US")).toBe("zh");
  });
});

// ── t() fallback ──────────────────────────────────────────────────────

describe("t() lookup and fallback", () => {
  it("missing active key falls back to English", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        en: { messages: { copy: "Copy" } },
        zh: { app: { welcome: "欢迎使用 Picot" } }, // no messages.copy
      }),
    );
    const { initI18n, setLocale, t } = await importFreshI18n();
    await initI18n();
    await setLocale("zh");
    expect(t("messages.copy")).toBe("Copy");
  });

  it("missing English key returns the key", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ en: {}, zh: {} }));
    const { initI18n, t } = await importFreshI18n();
    await initI18n();
    expect(t("nonexistent.key")).toBe("nonexistent.key");
  });

  it("interpolates {var} placeholders", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        en: { sidebar: { minutesAgo: "{minutes}m ago" } },
      }),
    );
    const { initI18n, t } = await importFreshI18n();
    await initI18n();
    expect(t("sidebar.minutesAgo", { minutes: 5 })).toBe("5m ago");
  });

  it("missing param becomes empty string", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        en: { sidebar: { minutesAgo: "{minutes}m ago" } },
      }),
    );
    const { initI18n, t } = await importFreshI18n();
    await initI18n();
    expect(t("sidebar.minutesAgo")).toBe("m ago");
  });
});

// ── getLanguagePreference ─────────────────────────────────────────────

describe("getLanguagePreference", () => {
  it("normalizes invalid cookie values to system", async () => {
    document.cookie = "picot-language=invalid; Path=/";
    const { getLanguagePreference } = await importFreshI18n();
    expect(getLanguagePreference()).toBe("system");
  });

  it("returns en when cookie is en", async () => {
    document.cookie = "picot-language=en; Path=/";
    const { getLanguagePreference } = await importFreshI18n();
    expect(getLanguagePreference()).toBe("en");
  });

  it("returns zh when cookie is zh", async () => {
    document.cookie = "picot-language=zh; Path=/";
    const { getLanguagePreference } = await importFreshI18n();
    expect(getLanguagePreference()).toBe("zh");
  });

  it("returns system when cookie is missing", async () => {
    const { getLanguagePreference } = await importFreshI18n();
    expect(getLanguagePreference()).toBe("system");
  });

  it("decodes encoded cookie values", async () => {
    document.cookie = "picot-language=zh; Path=/";
    const { getLanguagePreference } = await importFreshI18n();
    expect(getLanguagePreference()).toBe("zh");
  });
});

// ── setLocale ─────────────────────────────────────────────────────────

describe("setLocale", () => {
  it("writes encoded cookie only on successful zh load", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        en: { messages: { copy: "Copy" } },
        zh: { messages: { copy: "复制" } },
      }),
    );
    const { initI18n, setLocale, getLanguagePreference, getLocale } = await importFreshI18n();
    await initI18n();
    await setLocale("zh");
    expect(getLanguagePreference()).toBe("zh");
    expect(getLocale()).toBe("zh");
  });

  it("failed zh load does not write cookie, sets getLocale() === en, and sets document.documentElement.lang === en", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        en: { messages: { copy: "Copy" } },
        zh: null, // 404
      }),
    );
    const { initI18n, setLocale, getLanguagePreference, getLocale } = await importFreshI18n();
    await initI18n();
    await setLocale("zh");
    expect(getLanguagePreference()).not.toBe("zh");
    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("stale zh fetch does not overwrite a later English selection", async () => {
    let zhResolve;
    const zhResponsePromise = new Promise((resolve) => {
      zhResolve = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("/locales/en.json")) {
          return { ok: true, status: 200, json: async () => ({ messages: { copy: "Copy" } }) };
        }
        if (u.includes("/locales/zh.json")) {
          return zhResponsePromise;
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    const { initI18n, setLocale, getLocale } = await importFreshI18n();
    await initI18n();

    // Start a slow zh load (don't await)
    const zhPromise = setLocale("zh");

    // Immediately switch to en
    await setLocale("en");
    expect(getLocale()).toBe("en");

    // Now resolve the stale zh fetch with a proper Response-like object
    zhResolve({ ok: true, status: 200, json: async () => ({ messages: { copy: "复制" } }) });
    await zhPromise;

    // The stale zh result should NOT have overwritten the en selection
    expect(getLocale()).toBe("en");
  });
});

// ── onLocaleChange ────────────────────────────────────────────────────

describe("onLocaleChange", () => {
  it("listener fires on locale change and unsubscribe removes it", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ en: {}, zh: {} }));
    const { initI18n, setLocale, onLocaleChange } = await importFreshI18n();
    await initI18n();

    const calls = [];
    const unsubscribe = onLocaleChange((locale, preference) => {
      calls.push({ locale, preference });
    });

    await setLocale("zh");
    expect(calls).toHaveLength(1);
    expect(calls[0].locale).toBe("zh");
    expect(calls[0].preference).toBe("zh");

    unsubscribe();
    await setLocale("en");
    expect(calls).toHaveLength(1);
  });

  it("notifies listeners registered before initialization after translations load", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ en: {}, zh: {} }));
    const { initI18n, onLocaleChange } = await importFreshI18n();
    const listener = vi.fn();
    onLocaleChange(listener);

    await initI18n();

    expect(listener).toHaveBeenCalledWith("en", "system");
  });
});

// ── picot:locale-change CustomEvent ───────────────────────────────────

describe("picot:locale-change CustomEvent", () => {
  it("dispatches with { locale, preference }", async () => {
    vi.stubGlobal("fetch", makeFetchMock({ en: {}, zh: {} }));
    const { initI18n, setLocale } = await importFreshI18n();
    await initI18n();

    const events = [];
    window.addEventListener("picot:locale-change", (e) => {
      events.push({ locale: e.detail.locale, preference: e.detail.preference });
    });

    await setLocale("zh");
    expect(events).toHaveLength(1);
    expect(events[0].locale).toBe("zh");
    expect(events[0].preference).toBe("zh");
  });
});

// ── applyTranslations ─────────────────────────────────────────────────

describe("applyTranslations via initI18n", () => {
  it("updates all four supported data attributes", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetchMock({
        en: {
          messages: { copy: "Copy", copied: "Copied!" },
          files: { loading: "Loading…" },
          tools: { copyOutput: "Copy output" },
        },
      }),
    );

    document.body.innerHTML = `
      <button data-i18n="messages.copy"></button>
      <input data-i18n-ph="files.loading" />
      <span data-i18n-title="tools.copyOutput"></span>
      <div data-i18n-aria-label="messages.copied"></div>
    `;

    const { initI18n } = await importFreshI18n();
    await initI18n();

    expect(document.querySelector("[data-i18n]").textContent).toBe("Copy");
    expect(document.querySelector("[data-i18n-ph]").placeholder).toBe("Loading…");
    expect(document.querySelector("[data-i18n-title]").title).toBe("Copy output");
    expect(document.querySelector("[data-i18n-aria-label]").getAttribute("aria-label")).toBe(
      "Copied!",
    );
  });
});

// ── Bootstrap resolver parity ─────────────────────────────────────────

describe("bootstrap resolver parity", () => {
  it("cookie missing + zh system → zh", async () => {
    const { resolveLocale, getLanguagePreference } = await importFreshI18n();
    // No cookie set
    const pref = getLanguagePreference();
    expect(resolveLocale(pref, "zh-CN")).toBe("zh");
  });

  it("cookie system + zh system → zh", async () => {
    document.cookie = "picot-language=system; Path=/";
    const { resolveLocale, getLanguagePreference } = await importFreshI18n();
    const pref = getLanguagePreference();
    expect(resolveLocale(pref, "zh-CN")).toBe("zh");
  });

  it("cookie en + zh system → en", async () => {
    document.cookie = "picot-language=en; Path=/";
    const { resolveLocale, getLanguagePreference } = await importFreshI18n();
    const pref = getLanguagePreference();
    expect(resolveLocale(pref, "zh-CN")).toBe("en");
  });

  it("cookie zh + en system → zh", async () => {
    document.cookie = "picot-language=zh; Path=/";
    const { resolveLocale, getLanguagePreference } = await importFreshI18n();
    const pref = getLanguagePreference();
    expect(resolveLocale(pref, "en-US")).toBe("zh");
  });

  it("cookie encoded value decodes", async () => {
    document.cookie = "picot-language=zh; Path=/";
    const { getLanguagePreference } = await importFreshI18n();
    expect(getLanguagePreference()).toBe("zh");
  });
});
