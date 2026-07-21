import { beforeEach, describe, expect, it, vi } from "vitest";

const LAN_URL = "http://192.168.1.42:5173/session/ws/s";

function setupDom() {
  document.body.innerHTML = `
    <button id="lan-qr-btn" type="button">QR</button>
    <div id="lan-qr-modal" class="hidden">
      <div id="lan-qr-modal-backdrop"></div>
      <button id="lan-qr-modal-close" type="button">Close</button>
      <div id="lan-qr-loading"></div>
      <img id="lan-qr-image" class="hidden" alt="QR" />
      <button id="lan-qr-open-link" type="button" class="hidden">Open link</button>
    </div>
  `;
}

describe("LAN QR modal", () => {
  beforeEach(() => {
    vi.resetModules();
    setupDom();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ dataUrl: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E", url: LAN_URL }),
    });
  });

  it("opens the QR link through the native control gateway when available", async () => {
    const control = { openExternal: vi.fn().mockResolvedValue(undefined) };
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const { setupLanQr } = await import("./lan-qr.js");

    setupLanQr({ control });
    document.getElementById("lan-qr-btn").click();

    await vi.waitFor(() => {
      expect(document.getElementById("lan-qr-open-link").classList.contains("hidden")).toBe(false);
    });

    document.getElementById("lan-qr-open-link").click();

    expect(control.openExternal).toHaveBeenCalledWith(LAN_URL);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
