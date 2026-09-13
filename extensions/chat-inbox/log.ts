import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

import type {
  AttachmentInput,
  AttachmentKind,
  ChatLogRecord,
  InboundMessageInput,
  ResolvedConversation,
  StoredAttachment,
} from "../types.js";

function guessAttachmentKind(path: string): AttachmentKind {
  const ext = extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if ([".mp3", ".wav", ".ogg", ".m4a"].includes(ext)) return "audio";
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  return "file";
}

function guessMimeType(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".json") return "application/json";
  if (ext === ".md") return "text/markdown";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  return undefined;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

async function ensureRegularFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isSymbolicLink()) return;
    await unlink(path);
    await writeFile(path, "", "utf8");
  } catch {
    await writeFile(path, "", { flag: "a" });
  }
}

function isInside(root: string, value: string): boolean {
  const rel = relative(resolve(root), resolve(value));
  return (
    rel === "" ||
    (!rel.startsWith("..") && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

export async function ensureConversationDirs(conversation: ResolvedConversation): Promise<void> {
  await mkdir(conversation.accountDir, { recursive: true });
  await mkdir(conversation.sharedDir, { recursive: true });
  await mkdir(conversation.conversationDir, { recursive: true });
  await mkdir(dirname(conversation.logPath), { recursive: true });
  await mkdir(dirname(conversation.lockPath), { recursive: true });
  await mkdir(conversation.workspaceDir, { recursive: true });
  await mkdir(conversation.filesDir, { recursive: true });
  await ensureRegularFile(conversation.accountMemoryPath);
  await ensureRegularFile(conversation.channelMemoryPath);
}

export async function readConversationLog(
  conversation: ResolvedConversation,
): Promise<ChatLogRecord[]> {
  try {
    const content = await readFile(conversation.logPath, "utf8");
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChatLogRecord)
      .sort((a, b) => a.recordId - b.recordId);
  } catch {
    return [];
  }
}

export async function appendConversationRecord(
  conversation: ResolvedConversation,
  record: ChatLogRecord,
): Promise<void> {
  await ensureConversationDirs(conversation);
  await appendFile(conversation.logPath, `${JSON.stringify(record)}\n`, "utf8");
}

function extractOwnerPid(owner: string): number | undefined {
  const match = owner.match(/^pi-chat-(\d+)-/);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : undefined;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : undefined;
    return code === "EPERM";
  }
}

// The lock is a claim, not a mutex: the newest *explicit* connect always wins
// (`preempt`), and the previous holder is expected to notice it lost ownership
// and stand down. A crashed — or, as seen in practice, a spinning orphaned —
// holder can therefore never keep a channel offline forever, which a
// liveness-only check could not guarantee: a process being alive says nothing
// about it still polling. `epoch` only ever grows, so a holder that slept
// through a takeover can tell "still mine" from "reclaimed by someone else"
// even when the newer holder has already released the lock.
export interface ConversationLockInfo {
  ownerId: string;
  pid?: number;
  epoch: number;
  claimedAt: string;
}

function parseLockContent(content: string): ConversationLockInfo | undefined {
  const trimmed = content.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<ConversationLockInfo>;
      if (typeof parsed.ownerId !== "string" || !parsed.ownerId) return undefined;
      return {
        ownerId: parsed.ownerId,
        pid: typeof parsed.pid === "number" ? parsed.pid : extractOwnerPid(parsed.ownerId),
        epoch: typeof parsed.epoch === "number" && parsed.epoch > 0 ? parsed.epoch : 1,
        claimedAt: typeof parsed.claimedAt === "string" ? parsed.claimedAt : "",
      };
    } catch {
      return undefined;
    }
  }
  // Pre-epoch lock files held a bare owner id. Adopt them as epoch 1 rather
  // than treating them as corrupt, so an upgrade cannot strand a channel.
  const ownerId = trimmed.split("\n")[0]?.trim();
  if (!ownerId) return undefined;
  return { ownerId, pid: extractOwnerPid(ownerId), epoch: 1, claimedAt: "" };
}

export async function readConversationLock(
  conversation: ResolvedConversation,
): Promise<ConversationLockInfo | undefined> {
  try {
    return parseLockContent(await readFile(conversation.lockPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function describeLockHolder(info: ConversationLockInfo | undefined): string {
  if (!info) return "another pi-chat session";
  const parts: string[] = [];
  if (info.pid !== undefined) parts.push(`pid ${info.pid}`);
  if (info.claimedAt) parts.push(`since ${info.claimedAt}`);
  return parts.length > 0 ? `${info.ownerId} (${parts.join(", ")})` : info.ownerId;
}

async function writeLock(
  conversation: ResolvedConversation,
  info: ConversationLockInfo,
): Promise<void> {
  // Write-then-rename so a reader never observes a half-written claim.
  const staging = `${conversation.lockPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(staging, `${JSON.stringify(info)}\n`, "utf8");
  try {
    await rename(staging, conversation.lockPath);
  } catch (error) {
    await unlink(staging).catch(() => undefined);
    throw error;
  }
}

export async function acquireConversationLock(
  conversation: ResolvedConversation,
  owner: string,
  options: { preempt?: boolean } = {},
): Promise<ConversationLockInfo> {
  await ensureConversationDirs(conversation);
  const existing = await readConversationLock(conversation);
  const claim = (epoch: number): ConversationLockInfo => ({
    ownerId: owner,
    pid: process.pid,
    epoch,
    claimedAt: new Date().toISOString(),
  });
  if (!existing) {
    const info = claim(1);
    await writeLock(conversation, info);
    return info;
  }
  if (existing.ownerId === owner) return existing;
  const takeable =
    options.preempt === true || (existing.pid !== undefined && !isPidAlive(existing.pid));
  if (!takeable)
    throw new Error(`Conversation is already locked by ${describeLockHolder(existing)}`);
  const info = claim(existing.epoch + 1);
  await writeLock(conversation, info);
  return info;
}

export async function holdsConversationLock(
  conversation: ResolvedConversation,
  owner: string,
): Promise<boolean> {
  const info = await readConversationLock(conversation);
  // A vanished lock counts as lost: whoever removed it is entitled to reclaim
  // it, and continuing to write under it would race that claim.
  return info?.ownerId === owner;
}

export async function releaseConversationLock(
  conversation: ResolvedConversation,
  owner?: string,
): Promise<void> {
  // Never delete a claim that is no longer ours — that would hand a third
  // session the channel out from under the instance that just took over.
  if (owner !== undefined && !(await holdsConversationLock(conversation, owner))) return;
  await unlink(conversation.lockPath).catch(() => undefined);
}

export async function materializeAttachments(
  conversation: ResolvedConversation,
  messageId: string,
  attachments: AttachmentInput[] | undefined,
): Promise<StoredAttachment[]> {
  if (!attachments?.length) return [];
  await ensureConversationDirs(conversation);
  const stored: StoredAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const fileStats = await lstat(attachment.path);
    if (!fileStats.isFile())
      throw new Error(`Attachment is not a regular file: ${attachment.path}`);
    const fileName = sanitizeFileName(attachment.name || basename(attachment.path));
    const targetPath = isInside(conversation.filesDir, attachment.path)
      ? attachment.path
      : join(conversation.filesDir, `${Date.now()}-${messageId}-${index + 1}-${fileName}`);
    if (targetPath !== attachment.path) await copyFile(attachment.path, targetPath);
    stored.push({
      kind: attachment.kind || guessAttachmentKind(attachment.path),
      name: fileName,
      mimeType: attachment.mimeType || guessMimeType(attachment.path),
      size: fileStats.size,
      remoteUrl: attachment.remoteUrl,
      originalPath: targetPath === attachment.path ? undefined : attachment.path,
      localPath: targetPath,
    });
  }
  return stored;
}

export function buildBaseRecordFields(conversation: ResolvedConversation, recordId: number) {
  return {
    recordId,
    timestamp: new Date().toISOString(),
    service: conversation.service,
    accountId: conversation.accountId,
    channelKey: conversation.channelKey,
    channelId: conversation.channel.id,
    scope: "channel" as const,
  };
}

export function nextMessageId(service: string): string {
  return `${service}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeInboundMessage(
  input: InboundMessageInput,
  _botName: string,
): InboundMessageInput {
  const text = input.text.trim();
  return {
    ...input,
    text,
    isBot: input.isBot ?? false,
  };
}
