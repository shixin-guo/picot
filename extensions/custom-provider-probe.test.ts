// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  buildModelsJsonProviderEntry,
  detectProviderProtocol,
  mergeProviderIntoModelsJson,
  normalizeBaseUrl,
  resolveProviderId,
  sanitizeProviderId,
  suggestProviderIdFromBaseUrl,
  testProviderConnectivity,
} from "./custom-provider-probe.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("normalizeBaseUrl / sanitizeProviderId", () => {
  it("normalizes trailing slash and rejects bad schemes", () => {
    expect(normalizeBaseUrl("https://relay.example.com/v1/")).toBe(
      "https://relay.example.com/v1",
    );
    expect(() => normalizeBaseUrl("ftp://x")).toThrow(/http/);
    expect(() => normalizeBaseUrl("not-a-url")).toThrow(/valid/);
  });

  it("sanitizes provider ids", () => {
    expect(sanitizeProviderId(" My Relay ")).toBe("my-relay");
    expect(() => sanitizeProviderId("!!!")).toThrow(/required/);
  });

  it("suggests and resolves id from base URL when raw is empty or Chinese-only", () => {
    expect(suggestProviderIdFromBaseUrl("https://api.example.com/v1")).toBe("example-com");
    expect(resolveProviderId("", "https://relay.foo.io/v1")).toBe("foo-io");
    expect(resolveProviderId("中转站", "https://api.my-relay.net/v1")).toBe("my-relay-net");
    expect(resolveProviderId("My Relay", "https://ignored.example/v1")).toBe("my-relay");
  });
});

describe("detectProviderProtocol", () => {
  it("detects OpenAI-compatible /v1/models", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/v1/models") && !String(url).includes("messages")) {
        // first openai probe
        return jsonResponse({
          object: "list",
          data: [{ id: "gpt-4o-mini", owned_by: "openai", context_window: 32768, max_output_tokens: 4096 }],
        });
      }
      return jsonResponse({ error: { type: "not_found_error" } }, 404);
    }) as unknown as typeof fetch;

    const result = await detectProviderProtocol({
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-test",
      fetchImpl,
    });
    expect(result.protocol).toBe("openai-completions");
    expect(result.models.map((m) => m.id)).toContain("gpt-4o-mini");
    expect(result.models[0]).toMatchObject({ contextWindow: 32768, maxTokens: 4096 });
    expect(result.confidence).not.toBe("none");
  });

  it("detects Claude when OpenAI list fails and Anthropic models work", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers || {}) as Record<string, string>;
      if (u.endsWith("/v1/models") && headers.Authorization) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (u.endsWith("/v1/models") && headers["x-api-key"]) {
        return jsonResponse({
          data: [{ id: "claude-3-5-sonnet-latest", display_name: "Sonnet" }],
        });
      }
      return jsonResponse({ error: "no" }, 404);
    }) as unknown as typeof fetch;

    const result = await detectProviderProtocol({
      baseUrl: "https://claude-relay.example.com",
      apiKey: "sk-ant",
      fetchImpl,
    });
    expect(result.protocol).toBe("anthropic-messages");
    expect(result.models[0]?.id).toContain("claude");
  });
});

describe("testProviderConnectivity", () => {
  it("treats HTTP 200 chat completions as ok with latency", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    ) as unknown as typeof fetch;
    const result = await testProviderConnectivity({
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk",
      protocol: "openai-completions",
      modelId: "gpt-4o-mini",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.endpoint).toContain("/chat/completions");
  });
});

describe("models.json merge helpers", () => {
  it("builds openai entry and merges without clobbering other providers", () => {
    const entry = buildModelsJsonProviderEntry({
      baseUrl: "https://relay.example.com/v1",
      protocol: "openai-completions",
      models: [
        "gpt-4o-mini",
        { id: "deepseek-v3", name: "DeepSeek", contextWindow: 65536, maxTokens: 8192 },
      ],
    });
    expect(entry.api).toBe("openai-completions");
    expect(entry.compat).toBeTruthy();
    expect(entry.authHeader).toBe(true);
    expect(entry.models[0]).toMatchObject({
      id: "gpt-4o-mini",
      contextWindow: 128000,
      maxTokens: 16384,
    });
    expect(entry.models[1]).toMatchObject({
      id: "deepseek-v3",
      contextWindow: 65536,
      maxTokens: 8192,
    });
    const merged = mergeProviderIntoModelsJson(
      { providers: { ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [] } } },
      "My Relay",
      entry,
    );
    expect(Object.keys(merged.providers || {}).sort()).toEqual(["my-relay", "ollama"]);
    expect(merged.providers?.["my-relay"]?.models.map((m) => m.id)).toEqual([
      "gpt-4o-mini",
      "deepseek-v3",
    ]);
  });

  it("fills Claude defaults for anthropic protocol models", () => {
    const entry = buildModelsJsonProviderEntry({
      baseUrl: "https://api.relay.example",
      protocol: "anthropic-messages",
      models: ["claude-sonnet-4-6"],
    });
    expect(entry.api).toBe("anthropic-messages");
    expect(entry.models[0]).toMatchObject({
      id: "claude-sonnet-4-6",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 8192,
    });
  });
});
