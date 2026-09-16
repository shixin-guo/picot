import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  CHAT_CONFIG_PATH,
  loadChatConfig,
  removeAccountStorage,
  removeChannelStorage,
  saveChatConfig,
} from "../config.js";
import type { ChatAccountConfig, ChatConfig, TelegramAccountConfig } from "../core/config-types.js";
import { selectItem, showNotice } from "./dialogs.js";
import {
  addTelegramObservedTargetToAccount,
  createTelegramAccountWithGuidedSetup,
} from "./telegram-setup.js";

function accountDescription(account: ChatAccountConfig): string {
  const parts: string[] = [account.service];
  if (account.name) parts.push(account.name);
  if (account.botUsername) parts.push(`@${account.botUsername}`);
  parts.push(
    `${Object.values(account.channels).filter((channel) => channel.dm === true).length} configured DM${Object.values(account.channels).filter((channel) => channel.dm === true).length === 1 ? "" : "s"}`,
  );
  return parts.join(" • ");
}

async function configureConfiguredChannel(
  ctx: ExtensionContext,
  config: ChatConfig,
  accountId: string,
  channelKey: string,
): Promise<void> {
  const account = config.accounts[accountId];
  const channel = account?.channels[channelKey];
  if (!account || !channel) return;
  while (true) {
    const choice = await selectItem(ctx, `${accountId}/${channelKey}`, [
      { value: "delete", label: "Delete DM", description: "Remove this configured DM" },
      { value: "back", label: "Back" },
    ]);
    if (!choice || choice === "back") return;
    if (choice === "delete") {
      const ok = await ctx.ui.confirm("Delete configured DM", `Delete ${accountId}/${channelKey}?`);
      if (!ok) continue;
      delete account.channels[channelKey];
      await saveChatConfig(config);
      await removeChannelStorage(accountId, channelKey, ctx.cwd);
      await showNotice(ctx, "DM deleted", `Deleted ${accountId}/${channelKey}`, "info");
      return;
    }
  }
}

async function configureTelegramAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
  while (true) {
    const config = await loadChatConfig();
    const account = config.accounts[accountId] as TelegramAccountConfig | undefined;
    if (account?.service !== "telegram") return;
    const channelChoices = Object.entries(account.channels)
      .filter(([, channel]) => channel.dm === true)
      .map(([key, channel]) => ({
        value: key,
        label: key,
        description: channel.name ?? channel.id,
      }));
    const choice = await selectItem(ctx, `${accountId} (@${account.botUsername ?? "bot"})`, [
      { value: "add-dm", label: "Add DM", description: "Pair a DM by sending /start to the bot" },
      {
        value: "delete",
        label: "Delete account",
        description: "Remove account and all configured DMs",
      },
      ...channelChoices,
      { value: "back", label: "Back" },
    ]);
    if (!choice || choice === "back") return;
    if (choice === "add-dm") {
      await addTelegramObservedTargetToAccount(ctx, config, accountId, account);
      continue;
    }
    if (choice === "delete") {
      const ok = await ctx.ui.confirm(
        "Delete account",
        `Delete ${accountId} and all configured DMs?`,
      );
      if (!ok) continue;
      delete config.accounts[accountId];
      await saveChatConfig(config);
      await removeAccountStorage(accountId, ctx.cwd);
      await showNotice(ctx, "Account deleted", `Deleted ${accountId}`, "info");
      return;
    }
    await configureConfiguredChannel(ctx, config, accountId, choice);
  }
}

async function configureAccount(ctx: ExtensionContext, accountId: string): Promise<void> {
  const config = await loadChatConfig();
  const account = config.accounts[accountId];
  if (!account) return;
  if (account.service === "telegram") return configureTelegramAccount(ctx, accountId);
}

export async function runChatConfigUI(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(CHAT_CONFIG_PATH, "info");
    return;
  }
  while (true) {
    const config = await loadChatConfig();
    const telegramAccountIds = Object.keys(config.accounts)
      .filter((accountId) => config.accounts[accountId]?.service === "telegram")
      .sort();
    const choice = await selectItem(ctx, "pi-chat accounts", [
      ...telegramAccountIds.map((accountId) => ({
        value: accountId,
        label: accountId,
        description: accountDescription(config.accounts[accountId]),
      })),
      {
        value: "__create__",
        label: "+ Create account",
        description: "Create a Telegram DM bot account",
      },
    ]);
    if (!choice) return;
    if (choice === "__create__") {
      const accountId = await createTelegramAccountWithGuidedSetup(ctx, config);
      if (accountId) await configureAccount(ctx, accountId);
      continue;
    }
    await configureAccount(ctx, choice);
  }
}
