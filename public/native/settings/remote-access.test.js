import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupRemoteAccessPanel } from "./remote-access.js";

function render() {
  document.body.innerHTML = `
    <section>
      <span id="remote-access-url"></span>
      <button id="remote-access-copy" type="button">Copy URL</button>
      <span id="remote-access-copy-status" role="status"></span>
      <button id="remote-access-refresh-qr" type="button">Refresh QR</button>
      <img id="remote-access-qr" hidden alt="QR" />
      <p id="remote-access-error"></p>
    </section>
  `;
}

describe("Remote Access settings", () => {
  beforeEach(() => {
    render();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders the plain launcher URL and never includes a pairing credential", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        url: "http://192.168.1.10:57620/app",
        dataUrl: "data:image/svg+xml;base64,qr",
      }),
    });
    const panel = setupRemoteAccessPanel({ fetchImpl });

    await panel.load();

    expect(document.getElementById("remote-access-url").textContent).toBe(
      "http://192.168.1.10:57620/app",
    );
    expect(fetchImpl).toHaveBeenCalledWith("/v2/remote-access", { cache: "no-store" });
    expect(document.getElementById("remote-access-qr").hidden).toBe(false);
    expect(document.getElementById("remote-access-qr").src).toContain("base64,qr");
    expect(document.body.textContent).not.toContain("pairingToken");
  });

  it("rejects session URLs or query-bearing URLs instead of treating them as the launcher", async () => {
    const panel = setupRemoteAccessPanel({
      fetchImpl: vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          url: "http://192.168.1.10:57620/app/workspaces/workspace-a/sessions/session-a?pairingToken=secret",
          dataUrl: "qr-data",
        }),
      }),
    });

    await panel.load();

    expect(document.getElementById("remote-access-url").textContent).toBe("");
    expect(document.getElementById("remote-access-error").textContent).not.toBe("");
  });

  it("copies the URL and refreshes the QR with accessible status feedback", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "http://192.168.1.10:57620/app", dataUrl: "qr-old" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ url: "http://192.168.1.11:57620/app", dataUrl: "qr-new" }),
      });
    const panel = setupRemoteAccessPanel({ fetchImpl });
    await panel.load();

    document.getElementById("remote-access-copy").click();
    await vi.waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("http://192.168.1.10:57620/app"),
    );
    expect(document.getElementById("remote-access-copy-status").textContent).not.toBe("");

    document.getElementById("remote-access-refresh-qr").click();
    await vi.waitFor(() =>
      expect(document.getElementById("remote-access-url").textContent).toBe(
        "http://192.168.1.11:57620/app",
      ),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(document.getElementById("remote-access-qr").src).toContain("qr-new");
    expect(document.getElementById("remote-access-copy-status").textContent).not.toBe("");
  });
});
