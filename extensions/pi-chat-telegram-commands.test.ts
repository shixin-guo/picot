// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { syncTelegramCommandMenu } from "./pi-chat-src/live/telegram.ts";

afterEach(() => vi.unstubAllGlobals());

describe("Telegram slash command menu", () => {
  it("registers the supported command menu", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: true }),
    });
    vi.stubGlobal("fetch", fetch);

    await syncTelegramCommandMenu("token");

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain("/setMyCommands");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.commands.map((command: { command: string }) => command.command)).toEqual([
      "new",
      "stop",
      "status",
      "tasks",
      "agents",
      "task",
      "compact",
      "models",
      "health",
      "errors",
      "help",
    ]);
  });
});
