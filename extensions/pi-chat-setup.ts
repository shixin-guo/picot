export const TELEGRAM_MAIN_ACCOUNT_ID = "telegram-main";
export const TELEGRAM_MAIN_CHANNEL_ID = "dm-main";

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

export interface TelegramBotIdentity {
  id: string;
  name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface ObservedTelegramDm {
  chatId: string;
  chatName: string;
  userId: string;
  userName?: string;
}

interface ChatConfigLike {
  accounts?: Record<string, ChatAccountLike>;
  [key: string]: unknown;
}

interface ChatAccountLike {
  service?: string;
  botToken?: string;
  botUserId?: string;
  botUsername?: string;
  channels?: Record<string, ChatChannelLike>;
  [key: string]: unknown;
}

interface ChatChannelLike {
  id?: string;
  name?: string;
  dm?: boolean;
  access?: {
    allowedUserIds?: string[];
    ignoreBots?: boolean;
  };
  [key: string]: unknown;
}

export interface TelegramDmSetupInput {
  botToken: string;
  identity: TelegramBotIdentity;
  dm: ObservedTelegramDm;
}

export interface TelegramWorkerStatusLike {
  state?: string;
  conversationId?: string;
  updatedAt?: string;
  lastError?: string;
}

export type TelegramDoctorStatus = "ok" | "warning" | "error";
export type TelegramDoctorSummary = "ready" | "warning" | "error";

export interface TelegramDoctorCheck {
  id: "config" | "bot" | "dm" | "security" | "listener";
  label: string;
  status: TelegramDoctorStatus;
  message: string;
}

export interface TelegramDoctorReport {
  summary: TelegramDoctorSummary;
  configured: boolean;
  bot: {
    ok: boolean;
    id?: string;
    username?: string;
    name?: string;
    message: string;
  };
  dm: {
    ok: boolean;
    chatId?: string;
    name?: string;
    message: string;
  };
  security: {
    ok: boolean;
    allowedUserIds: string[];
    message: string;
  };
  listener: {
    ok: boolean;
    state?: string;
    conversationId?: string;
    updatedAt?: string;
    message: string;
  };
  checks: TelegramDoctorCheck[];
}

export interface TelegramDoctorInput {
  bot?: TelegramBotIdentity;
  botError?: string;
  workerStatuses?: TelegramWorkerStatusLike[];
}

function displayName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined;
  return (
    user.username || [user.first_name, user.last_name].filter(Boolean).join(" ") || String(user.id)
  );
}

function chatDisplayName(chat: TelegramChat): string {
  return (
    chat.title ||
    chat.username ||
    [chat.first_name, chat.last_name].filter(Boolean).join(" ") ||
    String(chat.id)
  );
}

async function callTelegram<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: options?.signal,
  });
  const data = (await response.json()) as TelegramApiResponse<T>;
  if (!response.ok || !data.ok || data.result === undefined) {
    throw new Error(data.description || `Telegram API ${method} failed`);
  }
  return data.result;
}

export async function getTelegramBotIdentity(
  botToken: string,
  options?: { signal?: AbortSignal },
): Promise<TelegramBotIdentity> {
  const user = await callTelegram<TelegramUser>(botToken, "getMe", {}, options);
  const name =
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
  return {
    id: String(user.id),
    name,
    username: user.username,
  };
}

export async function getLatestTelegramUpdateId(
  botToken: string,
  options?: { signal?: AbortSignal },
): Promise<number | undefined> {
  const updates = await callTelegram<TelegramUpdate[]>(
    botToken,
    "getUpdates",
    {
      offset: -1,
      limit: 1,
      timeout: 0,
    },
    options,
  );
  return updates.at(-1)?.update_id;
}

function matchPrivateDm(
  message: TelegramMessage | undefined,
  botUserId: string,
): ObservedTelegramDm | undefined {
  if (message?.chat.type !== "private") return undefined;
  const userId = message.from ? String(message.from.id) : String(message.chat.id);
  if (!userId || userId === botUserId) return undefined;
  return {
    chatId: String(message.chat.id),
    chatName: chatDisplayName(message.chat),
    userId,
    userName: displayName(message.from),
  };
}

export async function observeTelegramPrivateDm(
  botToken: string,
  botUserId: string,
  options?: {
    afterUpdateId?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<ObservedTelegramDm | undefined> {
  const timeoutMs = Math.max(5_000, Math.min(options?.timeoutMs ?? 90_000, 180_000));
  const deadline = Date.now() + timeoutMs;
  await callTelegram(botToken, "deleteWebhook", { drop_pending_updates: false }, options);
  let offset = options?.afterUpdateId ?? (await getLatestTelegramUpdateId(botToken, options)) ?? 0;

  while (Date.now() < deadline) {
    if (options?.signal?.aborted) return undefined;
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeoutSeconds = Math.max(1, Math.min(30, Math.ceil(remainingMs / 1000)));
    const updates = await callTelegram<TelegramUpdate[]>(
      botToken,
      "getUpdates",
      {
        offset: offset + 1,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "edited_message"],
      },
      options,
    );
    for (const update of updates) {
      offset = update.update_id;
      const observed = matchPrivateDm(update.message || update.edited_message, botUserId);
      if (observed) return observed;
    }
  }
  return undefined;
}

export function buildTelegramDmConfig(
  existingConfig: ChatConfigLike | undefined,
  setup: TelegramDmSetupInput,
): ChatConfigLike {
  const existingAccounts = existingConfig?.accounts ?? {};
  const nonTelegramAccounts = Object.fromEntries(
    Object.entries(existingAccounts).filter(([, account]) => account?.service !== "telegram"),
  );
  return {
    ...(existingConfig ?? {}),
    accounts: {
      ...nonTelegramAccounts,
      [TELEGRAM_MAIN_ACCOUNT_ID]: {
        service: "telegram",
        name: "Telegram",
        botToken: setup.botToken,
        botUserId: setup.identity.id,
        botUsername: setup.identity.username,
        channels: {
          [TELEGRAM_MAIN_CHANNEL_ID]: {
            id: setup.dm.chatId,
            name: setup.dm.userName || setup.dm.chatName,
            dm: true,
            access: {
              ignoreBots: true,
              allowedUserIds: [setup.dm.userId],
            },
          },
        },
      },
    },
  };
}

function getTelegramAccount(config: ChatConfigLike | undefined) {
  return Object.entries(config?.accounts ?? {}).find(
    ([, account]) => account?.service === "telegram",
  );
}

function getDmChannel(account: ChatAccountLike | undefined) {
  return Object.entries(account?.channels ?? {}).find(([, channel]) => channel?.dm === true);
}

function checkStatus(ok: boolean, warning = false): TelegramDoctorStatus {
  if (ok) return "ok";
  return warning ? "warning" : "error";
}

function buildSummary(checks: TelegramDoctorCheck[]): TelegramDoctorSummary {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ready";
}

export function buildTelegramDoctorReport(
  config: ChatConfigLike | undefined,
  input: TelegramDoctorInput = {},
): TelegramDoctorReport {
  const accountEntry = getTelegramAccount(config);
  const accountId = accountEntry?.[0];
  const account = accountEntry?.[1];
  const dmEntry = getDmChannel(account);
  const channelKey = dmEntry?.[0];
  const dm = dmEntry?.[1];
  const configured = Boolean(account?.botToken);
  const botOk = Boolean(input.bot || account?.botUserId || account?.botUsername);
  const allowedUserIds = dm?.access?.allowedUserIds ?? [];
  const conversationId = accountId && channelKey ? `${accountId}/${channelKey}` : undefined;
  const listenerStatus = (input.workerStatuses ?? []).find(
    (status) =>
      status.conversationId === conversationId ||
      (!conversationId && status.conversationId?.startsWith("telegram")),
  );
  const listenerOk = listenerStatus?.state === "connected";
  const checks: TelegramDoctorCheck[] = [
    {
      id: "config",
      label: "Config",
      status: checkStatus(configured),
      message: configured
        ? "Telegram bot token is saved in Picot chat config."
        : "Telegram is not connected.",
    },
    {
      id: "bot",
      label: "Bot",
      status: checkStatus(botOk),
      message: input.bot
        ? `Bot @${input.bot.username || input.bot.name || input.bot.id} is reachable.`
        : input.botError
          ? `Bot check failed: ${input.botError}`
          : botOk
            ? "Bot identity is saved in config."
            : "Bot identity is missing.",
    },
    {
      id: "dm",
      label: "DM",
      status: checkStatus(Boolean(dm?.id)),
      message: dm?.id
        ? `Private DM is bound to ${dm.name || dm.id}.`
        : "No private Telegram DM is bound.",
    },
    {
      id: "security",
      label: "Security",
      status: checkStatus(allowedUserIds.length > 0, true),
      message:
        allowedUserIds.length > 0
          ? `Telegram is restricted to allowed user ${allowedUserIds.join(", ")}.`
          : "No allowed Telegram user is configured; restrict access before enabling remote intake.",
    },
    {
      id: "listener",
      label: "Listener",
      status: checkStatus(listenerOk, true),
      message: listenerOk
        ? "Telegram listener is connected."
        : listenerStatus?.lastError
          ? `Telegram listener is ${listenerStatus.state || "not connected"}: ${listenerStatus.lastError}`
          : listenerStatus?.state
            ? `Telegram listener is ${listenerStatus.state}.`
            : "No live Telegram listener status was found.",
    },
  ];

  return {
    summary: buildSummary(checks),
    configured,
    bot: {
      ok: botOk,
      id: (input.bot?.id || account?.botUserId) as string,
      username: (input.bot?.username || account?.botUsername) as string,
      name: (input.bot?.name || account?.name) as string,
      message: checks[1].message,
    },
    dm: {
      ok: Boolean(dm?.id),
      chatId: dm?.id,
      name: dm?.name,
      message: checks[2].message,
    },
    security: {
      ok: allowedUserIds.length > 0,
      allowedUserIds,
      message: checks[3].message,
    },
    listener: {
      ok: listenerOk,
      state: listenerStatus?.state,
      conversationId: listenerStatus?.conversationId,
      updatedAt: listenerStatus?.updatedAt,
      message: checks[4].message,
    },
    checks,
  };
}
