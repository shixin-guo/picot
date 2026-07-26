// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  collectAssistantTextFromSession,
  eventIndicatesAssistantText,
  extractAssistantTextFromMessage,
  protocolFromModelApi,
  runHttpModelHealthProbe,
  runLightweightModelProbe,
} from "./embedded-server.ts";

describe("health-check assistant text detection", () => {
  it("extracts text from assistant content blocks", () => {
    expect(
      extractAssistantTextFromMessage({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      }),
    ).toBe("OK");
    expect(
      extractAssistantTextFromMessage({
        role: "user",
        content: [{ type: "text", text: "hi" }],
      }),
    ).toBe("");
  });

  it("treats streaming text_delta as success", () => {
    expect(
      eventIndicatesAssistantText({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "O" },
      }),
    ).toBe(true);
  });

  it("treats buffered message_end with final text as success (relay path)", () => {
    expect(
      eventIndicatesAssistantText({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
        },
      }),
    ).toBe(true);
  });

  it("does not treat empty assistant message as success", () => {
    expect(
      eventIndicatesAssistantText({
        type: "message_end",
        message: { role: "assistant", content: [] },
      }),
    ).toBe(false);
  });

  it("collects last assistant text and error from session messages", () => {
    const { text, error } = collectAssistantTextFromSession({
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [{ type: "text", text: "first" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "OK" }],
          errorMessage: undefined,
        },
      ],
    });
    expect(text).toBe("OK");
    expect(error).toBeUndefined();

    const failed = collectAssistantTextFromSession({
      messages: [
        {
          role: "assistant",
          content: [],
          errorMessage: "upstream 401",
        },
      ],
    });
    expect(failed.text).toBe("");
    expect(failed.error).toBe("upstream 401");
  });

  it("maps model.api to probe protocol", () => {
    expect(protocolFromModelApi("anthropic-messages")).toBe("anthropic-messages");
    expect(protocolFromModelApi("openai-completions")).toBe("openai-completions");
    expect(protocolFromModelApi("openai-responses")).toBe("openai-completions");
    expect(protocolFromModelApi("google-generative-ai")).toBeNull();
  });

  it("runLightweightModelProbe uses completeSimple with tiny payload", async () => {
    const calls: unknown[] = [];
    const runtime = {
      completeSimple: async (model: unknown, context: unknown, options: unknown) => {
        calls.push({ model, context, options });
        return {
          role: "assistant",
          content: [{ type: "text", text: "pong" }],
          stopReason: "stop",
        };
      },
    };
    const result = await runLightweightModelProbe(runtime, {
      provider: "aisz-mom",
      id: "claude-sonnet-4-6",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toBe("pong");
    expect(calls).toHaveLength(1);
    const ctx = calls[0] as {
      context: { systemPrompt?: string; messages: unknown[]; tools?: unknown[] };
      options: { maxTokens?: number; reasoning?: string };
    };
    expect(ctx.context.systemPrompt).toBeUndefined();
    expect(ctx.context.tools).toEqual([]);
    expect(ctx.options.maxTokens).toBe(16);
    // reasoning must be omitted (not "off") so anthropic streamSimple disables thinking
    expect(ctx.options.reasoning).toBeUndefined();
  });

  it("runLightweightModelProbe surfaces 403-style errors", async () => {
    const runtime = {
      completeSimple: async () => ({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "403 Your request was blocked.",
      }),
    };
    const result = await runLightweightModelProbe(runtime, {
      provider: "aisz-mom",
      id: "claude-sonnet-4-6",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("403");
  });

  it("runHttpModelHealthProbe treats non-streaming 200 as healthy", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: "msg", content: [{ type: "text", text: "hi" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await runHttpModelHealthProbe({
        baseUrl: "https://api1.aisz.mom",
        apiKey: "sk-test",
        protocol: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      });
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("runHttpModelHealthProbe fails on real 403 from upstream", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("Your request was blocked.", {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      })) as typeof fetch;
    try {
      const result = await runHttpModelHealthProbe({
        baseUrl: "https://api1.aisz.mom",
        apiKey: "sk-test",
        protocol: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      });
      expect(result.ok).toBe(false);
      expect(result.status).toBe(403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
