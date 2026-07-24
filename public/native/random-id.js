// `crypto.randomUUID()` is only defined in secure contexts (HTTPS, or the
// `localhost`/127.0.0.1 loopback). Picot's LAN mode serves the app over plain
// `http://<lan-ip>:<port>`, which the browser treats as an *insecure*
// context — `crypto.randomUUID` is `undefined` there, so calling it directly
// throws a `TypeError` and can crash whichever module called it at import
// time (see `native/app.js`, which used to build its WebSocket `clientId`
// this way, breaking session list / model list / everything else on LAN).
//
// `crypto.getRandomValues()` remains available in insecure contexts, so we
// fall back to building a UUID-shaped random id from it instead of a weaker
// `Math.random()`-based fallback.
export function randomId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
