// @vitest-environment node

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConversation } from "./chat-inbox/core/config-types.ts";
import { connectTelegramLive } from "./chat-inbox/live/telegram.ts";
import type { LiveConnectionHandlers } from "./chat-inbox/live/types.ts";

afterEach(() => vi.unstubAllGlobals());

function buildConversation(): ResolvedConversation {
  const root = join("/tmp", "pi-chat-eviction-unused");
  return {
    service: "telegram",
    botName: "picot",
    accountId: "telegram-main",
    account: {
      service: "telegram",
      botToken: "token",
      botUsername: "picot",
      botUserId: "999",
      channels: {},
    },
    channelKey: "dm-user",
    channel: { id: "100", name: "DM User", dm: true },
    conversationId: "telegram-main/dm-user",
    conversationName: "Telegram / DM User",
    access: { ignoreBots: true },
    accountDir: root,
    sharedDir: join(root, "shared"),
    conversationDir: root,
    workspaceDir: join(root, "workspace"),
    accountMemoryPath: join(root, "shared", "memory.md"),
    channelMemoryPath: join(root, "workspace", "memory.md"),
    logPath: join(root, "channel.jsonl"),
    filesDir: join(root, "workspace", "incoming"),
    lockPath: join(root, ".lock"),
  };
}

function buildHandlers(overrides: Partial<LiveConnectionHandlers> = {}): LiveConnectionHandlers {
  return {
    onMessage: async () => {},
    onCaughtUp: async () => {},
    onError: async () => {},
    ...overrides,
  };
}

function telegramReply(body: unknown) {
  return { ok: true, json: async () => body };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("Telegram poller under takeover", () => {
  it("stands down on a 409 once another instance owns the channel", async () => {
    let owner = true;
    const evicted: string[] = [];
    const errors: string[] = [];
    let polls = 0;
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/setMyCommands")) return telegramReply({ ok: true, result: true });
      polls += 1;
      if (polls === 1) return telegramReply({ ok: true, result: [] });
      // The replacement poller's first call is what kicks us out of the long
      // poll, so the conflict and the lost lock arrive together.
      owner = false;
      return telegramReply({
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      });
    });
    vi.stubGlobal("fetch", fetch);

    const connection = await connectTelegramLive(
      buildConversation(),
      buildHandlers({
        isStillOwner: async () => owner,
        onEvicted: async (reason) => {
          evicted.push(reason);
        },
        onError: async (error) => {
          errors.push(error.message);
        },
      }),
    );
    await settle();

    expect(evicted).toHaveLength(1);
    // A takeover is terminal, so it must not be reported as a retryable error.
    expect(errors).toEqual([]);
    const pollsAfterEviction = polls;
    await settle();
    expect(polls).toBe(pollsAfterEviction);
    await connection.disconnect();
  });

  it("keeps retrying a 409 while the channel is still ours", async () => {
    const evicted: string[] = [];
    const errors: string[] = [];
    let polls = 0;
    const fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/setMyCommands")) return telegramReply({ ok: true, result: true });
      polls += 1;
      if (polls === 1) return telegramReply({ ok: true, result: [] });
      return telegramReply({
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      });
    });
    vi.stubGlobal("fetch", fetch);

    const connection = await connectTelegramLive(
      buildConversation(),
      buildHandlers({
        isStillOwner: async () => true,
        onEvicted: async (reason) => {
          evicted.push(reason);
        },
        onError: async (error) => {
          errors.push(error.message);
        },
      }),
    );
    await settle();

    // Nobody took the lock, so the conflict is an outside poller: report it and
    // keep the connection alive instead of silently giving the channel away.
    expect(evicted).toEqual([]);
    expect(errors[0]).toContain("Conflict");
    await connection.disconnect();
  });
});
