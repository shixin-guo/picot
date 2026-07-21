import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "./i18n.js";
import { DialogHandler } from "./ui/dialogs.js";

const en = {
  dialogs: {
    cancel: "Cancel",
    no: "No",
    yes: "Yes",
    submit: "Submit",
    save: "Save",
    selectOption: "Select",
    confirm: "Confirm",
    input: "Input",
    editor: "Editor",
  },
};
const zh = {
  dialogs: { cancel: "取消", no: "否", yes: "是", submit: "提交", save: "保存" },
};

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/en.json")) return { ok: true, status: 200, json: async () => en };
      if (u.includes("/zh.json")) return { ok: true, status: 200, json: async () => zh };
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

describe("DialogHandler", () => {
  it("dispatches extension_ui_response through the injected send callback", () => {
    const sent = [];
    const container = document.createElement("div");
    const handler = new DialogHandler({ container, send: (m) => sent.push(m) });
    handler.showConfirm({ id: "r1", title: "Sure?" });
    container.querySelector(".dialog-yes").click();
    expect(sent).toContainEqual({ type: "extension_ui_response", id: "r1", confirmed: true });
  });

  it("scopes notifications to the provided notification container", () => {
    const notifications = document.createElement("div");
    const handler = new DialogHandler({
      container: document.createElement("div"),
      notificationContainer: notifications,
      send: () => {},
    });
    handler.showNotification({ message: "hello", notifyType: "info" });
    expect(notifications.textContent).toContain("hello");
  });

  it("destroy() clears the dialog, unsubscribes locale, and is idempotent", async () => {
    const container = document.createElement("div");
    const handler = new DialogHandler({ container, send: () => {} });
    handler.showInput({ id: "r2", title: "Name", timeout: 100000 });
    expect(container.querySelector(".dialog-input")).toBeTruthy();

    handler.destroy();
    expect(() => handler.destroy()).not.toThrow();
    expect(container.querySelector(".dialog-input")).toBeFalsy();
    // A locale change after destroy must not throw or re-localize.
    await setLocale("zh");
  });
});
