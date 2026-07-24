import { randomId } from "./random-id.js";

const DEVICE_ID_KEY = "picot-remote-device-id";
const DEVICE_TOKEN_KEY = "picot-remote-device-token";
const PAIRING_QUERY_KEY = "pairingToken";

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

export async function resolveRemoteAuth({
  location = globalThis.location,
  history = globalThis.history,
  storage = globalThis.localStorage,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(location.href);
  const pairingToken = url.searchParams.get(PAIRING_QUERY_KEY);
  if (pairingToken) {
    const response = await fetchImpl("/v2/auth/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingToken,
        deviceId: remoteDeviceId(storage),
      }),
    });
    if (!response.ok) throw new Error("LAN pairing expired. Generate a new QR code from Picot.");
    const body = await response.json();
    if (!body?.deviceToken) throw new Error("LAN pairing did not return a device token.");
    storage.setItem(DEVICE_TOKEN_KEY, body.deviceToken);
    url.searchParams.delete(PAIRING_QUERY_KEY);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  const deviceToken = storage.getItem(DEVICE_TOKEN_KEY) || "";
  if (!deviceToken || isLoopbackHost(url.hostname)) {
    return { clientType: "desktop", deviceToken: "" };
  }
  return { clientType: "remote", deviceToken };
}
