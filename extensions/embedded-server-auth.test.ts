// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  persistProviderApiKey,
  refreshRegistryAfterAuthChange,
  removeProviderApiKey,
  resolveRegistryCredentialStore,
} from "./embedded-server.ts";

describe("resolveRegistryCredentialStore", () => {
  it("prefers ModelRegistry.runtime.credentials (pi ≥0.80.8)", () => {
    const credentials = {
      modify: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const store = resolveRegistryCredentialStore({
      runtime: { credentials },
      authStorage: undefined,
    });
    expect(store).toBe(credentials);
  });

  it("falls back to top-level credentials", () => {
    const credentials = {
      modify: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    expect(resolveRegistryCredentialStore({ credentials })).toBe(credentials);
  });

  it("adapts legacy authStorage.set/remove", async () => {
    const set = vi.fn();
    const remove = vi.fn();
    const store = resolveRegistryCredentialStore({
      authStorage: { set, remove },
    });
    expect(store).not.toBeNull();
    await persistProviderApiKey(store!, "openai", "sk-test");
    expect(set).toHaveBeenCalledWith("openai", { type: "api_key", key: "sk-test" });
    await removeProviderApiKey(store!, "openai");
    expect(remove).toHaveBeenCalledWith("openai");
  });

  it("returns null when registry has no credential write path", () => {
    expect(resolveRegistryCredentialStore({})).toBeNull();
    expect(resolveRegistryCredentialStore(null)).toBeNull();
    // Broken post-0.80 shape that caused Settings "保存密钥失败"
    expect(resolveRegistryCredentialStore({ authStorage: undefined })).toBeNull();
  });
});

describe("persistProviderApiKey / removeProviderApiKey", () => {
  it("writes api_key credentials through CredentialStore.modify", async () => {
    const modify = vi.fn(async (_provider: string, fn: (c: unknown) => Promise<unknown>) =>
      fn(undefined),
    );
    const deleteFn = vi.fn(async () => undefined);
    await persistProviderApiKey({ modify, delete: deleteFn }, "anthropic", "sk-live");
    expect(modify).toHaveBeenCalledWith("anthropic", expect.any(Function));
    const written = await modify.mock.calls[0][1](undefined);
    expect(written).toEqual({ type: "api_key", key: "sk-live" });
  });

  it("deletes via CredentialStore.delete", async () => {
    const modify = vi.fn(async () => undefined);
    const deleteFn = vi.fn(async () => undefined);
    await removeProviderApiKey({ modify, delete: deleteFn }, "anthropic");
    expect(deleteFn).toHaveBeenCalledWith("anthropic");
  });
});

describe("refreshRegistryAfterAuthChange", () => {
  it("awaits runtime.refresh with allowNetwork false when present", async () => {
    const refresh = vi.fn(async () => ({ ok: true }));
    await refreshRegistryAfterAuthChange({ runtime: { refresh } });
    expect(refresh).toHaveBeenCalledWith({ allowNetwork: false });
  });

  it("awaits registry.refresh fallback", async () => {
    const refresh = vi.fn(async () => undefined);
    await refreshRegistryAfterAuthChange({ refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
