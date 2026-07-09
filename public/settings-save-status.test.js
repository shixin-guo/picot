import { beforeEach, describe, expect, it, vi } from "vitest";

function makeFetchMock(handlers = {}) {
  const defaults = {
    en: { status: { saved: "Saved", saving: "Saving..." }, actions: { save: "Save" } },
    zh: { status: { saved: "已保存", saving: "保存中..." }, actions: { save: "保存" } },
  };
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/locales/en.json"))
      return { ok: true, status: 200, json: async () => handlers.en ?? defaults.en };
    if (u.includes("/locales/zh.json"))
      return { ok: true, status: 200, json: async () => handlers.zh ?? defaults.zh };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

async function importFreshWithI18n() {
  vi.resetModules();
  const i18n = await import("./i18n.js");
  await i18n.initI18n();
  const mod = await import("./settings-save-status.js");
  return { ...i18n, ...mod };
}

beforeEach(() => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.unstubAllGlobals();
});

describe("settings-save-status localization", () => {
  it("setSettingsSaveButtonSaving(true) uses status.saving", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { setSettingsSaveButtonSaving } = await importFreshWithI18n();
    const btn = document.createElement("button");
    setSettingsSaveButtonSaving(btn, true);
    expect(btn.textContent).toBe("Saving...");
    expect(btn.disabled).toBe(true);
  });

  it("setSettingsSaveButtonSaving(false) uses actions.save", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { setSettingsSaveButtonSaving } = await importFreshWithI18n();
    const btn = document.createElement("button");
    setSettingsSaveButtonSaving(btn, false);
    expect(btn.textContent).toBe("Save");
    expect(btn.disabled).toBe(false);
  });

  it("default showSettingsSaveSuccess uses status.saved", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { showSettingsSaveSuccess } = await importFreshWithI18n();
    const el = document.createElement("div");
    showSettingsSaveSuccess(el);
    expect(el.textContent).toBe("Saved");
    expect(el.dataset.tone).toBe("ok");
  });

  it("showSettingsSaveSuccess with customMessage keeps caller-provided text untranslated", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { showSettingsSaveSuccess } = await importFreshWithI18n();
    const el = document.createElement("div");
    showSettingsSaveSuccess(el, "Custom message from caller");
    expect(el.textContent).toBe("Custom message from caller");
  });

  it("auto-clear timer still hides the message after locale changes", async () => {
    vi.stubGlobal("fetch", makeFetchMock());
    const { showSettingsSaveSuccess, setLocale } = await importFreshWithI18n();
    const el = document.createElement("div");
    showSettingsSaveSuccess(el);
    expect(el.textContent).toBe("Saved");

    // Switch locale while the auto-clear timer is pending
    await setLocale("zh");
    expect(el.textContent).toBe("Saved"); // custom message was NOT provided, but default is cached

    // Wait for the timer to fire
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(el.textContent).toBe("");
    expect(el.classList.contains("hidden")).toBe(true);
  });
});
