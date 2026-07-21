import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupVoiceInput } from "./app/voice-input.js";
import { initI18n } from "./i18n.js";

class FakeRecognition extends EventTarget {
  constructor() {
    super();
    this.lang = "";
    this.continuous = false;
    this.interimResults = false;
    this.started = false;
  }
  start() {
    this.started = true;
  }
  stop() {
    this.started = false;
    this.dispatchEvent(new Event("end"));
  }
}

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/en.json")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ voice: { voiceInput: "Voice", stopRecording: "Stop" } }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

describe("setupVoiceInput cleanup", () => {
  it("returns a no-op cleanup when elements are missing", () => {
    const cleanup = setupVoiceInput({ micBtn: null, messageInput: null });
    expect(typeof cleanup).toBe("function");
    expect(() => cleanup()).not.toThrow();
  });

  it("returns a cleanup on unsupported browsers and hides the button", () => {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    const micBtn = document.createElement("button");
    const messageInput = document.createElement("textarea");
    const cleanup = setupVoiceInput({ micBtn, messageInput });
    expect(typeof cleanup).toBe("function");
    expect(micBtn.style.display).toBe("none");
    expect(() => cleanup()).not.toThrow();
  });

  it("stops recording, removes the click listener, and is idempotent", () => {
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = undefined;
    const micBtn = document.createElement("button");
    const messageInput = document.createElement("textarea");
    document.body.append(micBtn, messageInput);
    const removeSpy = vi.spyOn(micBtn, "removeEventListener");

    const cleanup = setupVoiceInput({ micBtn, messageInput });
    micBtn.click();
    expect(micBtn.classList.contains("recording")).toBe(true);

    cleanup();
    expect(micBtn.classList.contains("recording")).toBe(false);
    expect(removeSpy).toHaveBeenCalled();
    // idempotent
    expect(() => cleanup()).not.toThrow();
    // after cleanup, clicking no longer starts recording
    micBtn.click();
    expect(micBtn.classList.contains("recording")).toBe(false);

    micBtn.remove();
    messageInput.remove();
    delete window.SpeechRecognition;
  });
});
