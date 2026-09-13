// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConversation } from "./chat-inbox/core/config-types.ts";
import {
  acquireConversationLock,
  describeLockHolder,
  ensureConversationDirs,
  holdsConversationLock,
  readConversationLock,
  releaseConversationLock,
} from "./chat-inbox/log.ts";
import { ConversationRuntime } from "./chat-inbox/runtime.ts";

const tempRoots: string[] = [];

function buildConversation(root: string): ResolvedConversation {
  const accountDir = join(root, "account");
  const conversationDir = join(root, "dm");
  const workspaceDir = join(conversationDir, "workspace");
  return {
    service: "telegram",
    botName: "picot",
    accountId: "telegram-main",
    account: {
      service: "telegram",
      botToken: "test-token",
      botUsername: "picot",
      channels: {},
    },
    channelKey: "dm-user",
    channel: { id: "100", name: "DM User", dm: true, access: { ignoreBots: true } },
    conversationId: "telegram-main/dm-user",
    conversationName: "Telegram / DM User",
    access: { ignoreBots: true },
    accountDir,
    sharedDir: join(accountDir, "shared"),
    conversationDir,
    workspaceDir,
    accountMemoryPath: join(accountDir, "shared", "memory.md"),
    channelMemoryPath: join(workspaceDir, "memory.md"),
    logPath: join(conversationDir, "channel.jsonl"),
    filesDir: join(workspaceDir, "incoming"),
    lockPath: join(conversationDir, ".lock"),
  };
}

async function newConversation(): Promise<ResolvedConversation> {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-lock-"));
  tempRoots.push(root);
  return buildConversation(root);
}

// A holder is always the process that wrote its own claim, so tests seed lock
// files directly to stand in for another process.
async function seedLock(
  conversation: ResolvedConversation,
  ownerId: string,
  pid: number,
): Promise<void> {
  await ensureConversationDirs(conversation);
  await writeFile(
    conversation.lockPath,
    `${JSON.stringify({ ownerId, pid, epoch: 1, claimedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

// pid 1 always exists, so this holder cannot be mistaken for a dead one — the
// exact case the old liveness-only check got stuck on.
const LIVE_OWNER = "pi-chat-1-aaaaaaaa";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("conversation lock takeover", () => {
  it("refuses a non-preempting claim while a live owner holds the channel", async () => {
    const conversation = await newConversation();
    await seedLock(conversation, LIVE_OWNER, 1);
    await expect(acquireConversationLock(conversation, "pi-chat-2-b")).rejects.toThrow(
      /already locked by .*pid 1/,
    );
  });

  it("lets an explicit connect take the channel and bumps the epoch", async () => {
    const conversation = await newConversation();
    await seedLock(conversation, LIVE_OWNER, 1);
    expect((await readConversationLock(conversation))?.epoch).toBe(1);
    const second = await acquireConversationLock(conversation, "pi-chat-2-b", { preempt: true });
    expect(second.epoch).toBe(2);
    expect(await holdsConversationLock(conversation, LIVE_OWNER)).toBe(false);
    expect(await holdsConversationLock(conversation, "pi-chat-2-b")).toBe(true);
  });

  it("still reclaims a lock whose owner process is gone, without preempting", async () => {
    const conversation = await newConversation();
    // 2^22 is above every platform's pid_max, so this owner cannot be alive.
    await seedLock(conversation, "pi-chat-4194304-dead", 4194304);
    const claimed = await acquireConversationLock(conversation, "pi-chat-5-e");
    expect(claimed.ownerId).toBe("pi-chat-5-e");
  });

  it("adopts a pre-epoch plain-text lock file instead of stranding the channel", async () => {
    const conversation = await newConversation();
    await ensureConversationDirs(conversation);
    await writeFile(conversation.lockPath, `${LIVE_OWNER}\n`, "utf8");
    const legacy = await readConversationLock(conversation);
    expect(legacy).toMatchObject({ ownerId: LIVE_OWNER, pid: 1, epoch: 1 });
    await expect(acquireConversationLock(conversation, "pi-chat-2-b")).rejects.toThrow(
      /already locked by/,
    );
    const taken = await acquireConversationLock(conversation, "pi-chat-2-b", { preempt: true });
    expect(taken.epoch).toBe(2);
  });

  it("does not delete a lock that now belongs to someone else", async () => {
    const conversation = await newConversation();
    await seedLock(conversation, LIVE_OWNER, 1);
    await acquireConversationLock(conversation, "pi-chat-2-b", { preempt: true });
    await releaseConversationLock(conversation, LIVE_OWNER);
    expect(await holdsConversationLock(conversation, "pi-chat-2-b")).toBe(true);
    await releaseConversationLock(conversation, "pi-chat-2-b");
    expect(await readConversationLock(conversation)).toBeUndefined();
  });

  it("names the holder with a pid so the status line can explain itself", async () => {
    const conversation = await newConversation();
    await acquireConversationLock(conversation, LIVE_OWNER);
    expect(describeLockHolder(await readConversationLock(conversation))).toContain(
      `pid ${process.pid}`,
    );
  });
});

describe("ConversationRuntime under takeover", () => {
  it("reports the loss once and stops writing to the log", async () => {
    const conversation = await newConversation();
    const lost: string[] = [];
    const runtime = await ConversationRuntime.connect(conversation, "pi-chat-100-first", {
      onLockLost: (holder) => lost.push(holder),
    });
    runtime.armAfterCurrentTail();
    await runtime.appendError("before takeover");
    const before = await readFile(conversation.logPath, "utf8");

    await acquireConversationLock(conversation, "pi-chat-200-second", { preempt: true });

    expect(await runtime.stillOwnsChannel()).toBe(false);
    expect(runtime.hasLostLock()).toBe(true);
    await runtime.appendError("after takeover");
    expect(await readFile(conversation.logPath, "utf8")).toBe(before);
    // Repeated checks must not re-notify: eviction is a one-shot transition.
    await runtime.stillOwnsChannel();
    expect(lost).toHaveLength(1);
    expect(lost[0]).toContain("pi-chat-200-second");
  });

  it("keeps the new holder's claim when the evicted runtime disconnects", async () => {
    const conversation = await newConversation();
    const first = await ConversationRuntime.connect(conversation, "pi-chat-100-first");
    const second = await ConversationRuntime.connect(conversation, "pi-chat-200-second", {
      preempt: true,
    });
    expect(second.getLockEpoch()).toBe(2);
    await first.disconnect();
    expect(await holdsConversationLock(conversation, "pi-chat-200-second")).toBe(true);
  });

  it("hands the Telegram cursor over to the instance that took the channel", async () => {
    const conversation = await newConversation();
    const first = await ConversationRuntime.connect(conversation, "pi-chat-100-first");
    first.armAfterCurrentTail();
    await first.noteCheckpoint({ cursor: "4242", messageId: "17" });
    const second = await ConversationRuntime.connect(conversation, "pi-chat-200-second", {
      preempt: true,
    });
    expect(second.getLastCheckpoint()).toEqual({ cursor: "4242", messageId: "17" });
  });
});
