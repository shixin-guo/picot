import { afterEach, describe, expect, it } from "vitest";
import { randomId } from "./random-id.js";

const originalCrypto = globalThis.crypto;

describe("randomId", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", {
      value: originalCrypto,
      configurable: true,
    });
  });

  it("uses crypto.randomUUID when available (secure contexts)", () => {
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("falls back to crypto.getRandomValues when randomUUID is missing", () => {
    // Simulates an insecure context (e.g. Picot opened over LAN via plain
    // http://<lan-ip>:<port>), where crypto.randomUUID is undefined but
    // crypto.getRandomValues remains available.
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
      configurable: true,
    });
    const id = randomId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("falls back to a Math.random-based id when crypto is entirely unavailable", () => {
    Object.defineProperty(globalThis, "crypto", {
      value: undefined,
      configurable: true,
    });
    const id = randomId();
    expect(id).toMatch(/^id-\d+-[0-9a-f]+$/);
  });
});
