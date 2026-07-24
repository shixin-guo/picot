import { describe, expect, it, vi } from "vitest";
import { isLoopbackHost, remoteDeviceId, resolveRemoteAuth } from "./remote-auth.js";

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe("remote auth", () => {
  it("treats localhost as a desktop client", async () => {
    const auth = await resolveRemoteAuth({
      location: { href: "http://127.0.0.1:9000/app/workspaces/a/sessions/b" },
      history: { replaceState: vi.fn() },
      storage: storage(),
      fetchImpl: vi.fn(),
    });
    expect(auth).toEqual({ clientType: "desktop", deviceToken: "" });
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  it("exchanges a LAN pairing token, stores the device token, and cleans the URL", async () => {
    const localStorage = storage();
    const replaceState = vi.fn();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ deviceToken: "picot-device-token" }),
    }));

    const auth = await resolveRemoteAuth({
      location: {
        href: "http://192.168.1.10:9000/app/workspaces/a/sessions/b?pairingToken=pair-1#hash",
      },
      history: { replaceState },
      storage: localStorage,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v2/auth/exchange",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"pairingToken":"pair-1"'),
      }),
    );
    expect(auth).toEqual({ clientType: "remote", deviceToken: "picot-device-token" });
    expect(replaceState).toHaveBeenCalledWith(null, "", "/app/workspaces/a/sessions/b#hash");
  });

  it("reuses a stable remote device id", () => {
    const localStorage = storage();
    const first = remoteDeviceId(localStorage);
    expect(remoteDeviceId(localStorage)).toBe(first);
  });
});
