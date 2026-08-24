import { describe, expect, it, vi } from "vitest";
import {
  claimDeviceAccess,
  createClaimSecret,
  createDeviceAccessRequest,
  isLoopbackHost,
  pendingDeviceRequest,
  remoteDeviceId,
  resolveRemoteAuth,
} from "./remote-auth.js";

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

  it("requires remote authorization for an unpaired LAN client", async () => {
    const auth = await resolveRemoteAuth({
      location: { href: "http://192.168.1.10:9000/app" },
      history: { replaceState: vi.fn() },
      storage: storage(),
      fetchImpl: vi.fn(),
    });
    expect(auth).toEqual({ clientType: "remote", deviceToken: "" });
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

  it("creates a bounded proof-of-possession request and persists only its pending state", async () => {
    const localStorage = storage();
    const random = { getRandomValues: (bytes) => bytes.fill(7) };
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ requestId: "request-1", expiresAt: 4_000_000_000, pollAfterMs: 1200 }),
    }));
    const pending = await createDeviceAccessRequest({
      storage: localStorage,
      cryptoImpl: random,
      navigatorImpl: { platform: "iPhone", userAgent: "Safari" },
      fetchImpl,
    });
    expect(pending.claimSecret).toHaveLength(64);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v2/auth/device-requests",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"deviceName":"iPhone · Safari"'),
      }),
    );
    expect(pendingDeviceRequest(localStorage)).toMatchObject({
      requestId: "request-1",
      deviceId: pending.deviceId,
    });
  });

  it("fails closed without Web Crypto and posts claims to only the claim endpoint", async () => {
    expect(() => createClaimSecret({})).toThrow("Secure device approval");
    const fetchImpl = vi.fn(async () => ({
      status: 202,
      ok: false,
      json: async () => ({ status: "pending" }),
    }));
    await expect(
      claimDeviceAccess({
        requestId: "request-1",
        deviceId: "device-1",
        claimSecret: "a".repeat(64),
        fetchImpl,
      }),
    ).resolves.toEqual({ status: 202, body: { status: "pending" } });
    expect(fetchImpl.mock.calls[0][0]).toBe("/v2/auth/device-requests/request-1/claim");
  });
});
