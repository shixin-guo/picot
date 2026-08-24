import { randomId } from "../utils/random-id.js";

const DEVICE_ID_KEY = "picot-remote-device-id";
export const DEVICE_TOKEN_KEY = "picot-remote-device-token";
export const PENDING_DEVICE_REQUEST_KEY = "picot-remote-pending-device-request";
const MAX_DEVICE_NAME_LENGTH = 128;

export function isLoopbackHost(hostname = globalThis.location?.hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function remoteDeviceId(storage = globalThis.localStorage) {
  let deviceId = storage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = `device-${randomId()}`;
    storage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

export function deviceLabel({ navigatorImpl = globalThis.navigator } = {}) {
  const platform = navigatorImpl?.platform || navigatorImpl?.userAgentData?.platform || "browser";
  const userAgent = navigatorImpl?.userAgent || "web browser";
  const clean = `${platform} - ${userAgent}`.replace(/\p{Cc}/gu, "");
  return clean.slice(0, MAX_DEVICE_NAME_LENGTH) || "Web browser";
}

export function createClaimSecret(cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.getRandomValues)
    throw new Error("Secure device approval is unavailable in this browser.");
  const bytes = new Uint8Array(32);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readPending(storage) {
  try {
    const value = JSON.parse(storage.getItem(PENDING_DEVICE_REQUEST_KEY) || "null");
    if (!value || typeof value !== "object") return null;
    if (
      !value.requestId ||
      !value.claimSecret ||
      !value.deviceId ||
      !Number.isFinite(value.expiresAt)
    )
      return null;
    if (value.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    return value;
  } catch {
    return null;
  }
}

export function pendingDeviceRequest(storage = globalThis.localStorage) {
  const pending = readPending(storage);
  if (!pending) {
    try {
      storage.removeItem(PENDING_DEVICE_REQUEST_KEY);
    } catch {
      /* best effort */
    }
  }
  return pending;
}

export function clearPendingDeviceRequest(storage = globalThis.localStorage) {
  try {
    storage.removeItem(PENDING_DEVICE_REQUEST_KEY);
  } catch {
    /* best effort */
  }
}

export async function createDeviceAccessRequest({
  fetchImpl = globalThis.fetch,
  storage = globalThis.localStorage,
  cryptoImpl = globalThis.crypto,
  navigatorImpl = globalThis.navigator,
} = {}) {
  const deviceId = remoteDeviceId(storage);
  const claimSecret = createClaimSecret(cryptoImpl);
  const response = await fetchImpl("/v2/auth/device-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ deviceId, deviceName: deviceLabel({ navigatorImpl }), claimSecret }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.requestId || !Number.isFinite(body.expiresAt)) {
    throw new Error(body?.error?.message || "Picot could not create an access request.");
  }
  const pending = {
    requestId: body.requestId,
    claimSecret,
    deviceId,
    expiresAt: body.expiresAt,
    pollAfterMs: Number.isFinite(body.pollAfterMs) ? body.pollAfterMs : 1500,
  };
  try {
    storage.setItem(PENDING_DEVICE_REQUEST_KEY, JSON.stringify(pending));
  } catch {
    throw new Error("Picot could not save the access request in this browser.");
  }
  return pending;
}

export async function claimDeviceAccess({
  requestId,
  deviceId,
  claimSecret,
  fetchImpl = globalThis.fetch,
} = {}) {
  const response = await fetchImpl(
    `/v2/auth/device-requests/${encodeURIComponent(requestId)}/claim`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ deviceId, claimSecret }),
    },
  );
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

export function installRemoteAuthFetch(
  deviceToken,
  { fetchImpl = globalThis.fetch, location = globalThis.location } = {},
) {
  if (!deviceToken || typeof fetchImpl !== "function") return fetchImpl;
  const origin = location?.origin || "";
  const authenticatedFetch = (input, init = {}) => {
    let sameOrigin = true;
    try {
      sameOrigin =
        new URL(typeof input === "string" ? input : input.url, location?.href).origin === origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) return fetchImpl(input, init);
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${deviceToken}`);
    return fetchImpl(input, { ...init, headers });
  };
  globalThis.fetch = authenticatedFetch;
  return authenticatedFetch;
}

export async function resolveRemoteAuth({
  location = globalThis.location,
  storage = globalThis.localStorage,
} = {}) {
  const url = new URL(location.href);
  const deviceToken = storage.getItem(DEVICE_TOKEN_KEY) || "";
  if (isLoopbackHost(url.hostname)) return { clientType: "desktop", deviceToken: "" };
  return { clientType: "remote", deviceToken };
}
