import { describe, expect, it, vi } from "vitest";
import { HOST_UI_CAPABILITY_KEY, registerHostUiCapabilityReporter } from "./host-ui-capabilities";

function setup() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const notifications: string[] = [];
  const calls: string[] = [];

  const ui = {
    notify: (message: string) => notifications.push(message),
    onTerminalInput: (..._args: unknown[]) => {
      calls.push("onTerminalInput");
      return () => {};
    },
    setFooter: (..._args: unknown[]) => calls.push("setFooter"),
    setHeader: (..._args: unknown[]) => calls.push("setHeader"),
    setEditorComponent: (..._args: unknown[]) => calls.push("setEditorComponent"),
  };
  const ctx = { ui };

  registerHostUiCapabilityReporter({
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as never);
  handlers.get("session_start")?.({}, ctx);

  const reported = (): string[] =>
    notifications
      .map((message) => JSON.parse(message)[HOST_UI_CAPABILITY_KEY]?.capability)
      .filter(Boolean);

  return { ctx, calls, reported, sessionStart: () => handlers.get("session_start")?.({}, ctx) };
}

describe("registerHostUiCapabilityReporter", () => {
  it("reports terminal-only surfaces without swallowing the original call", () => {
    const { ctx, calls, reported } = setup();

    ctx.ui.setFooter(() => undefined);
    ctx.ui.setHeader(() => undefined);
    ctx.ui.setEditorComponent(() => undefined);
    ctx.ui.onTerminalInput(() => {});

    expect(reported()).toEqual(["setFooter", "setHeader", "setEditorComponent", "onTerminalInput"]);
    expect(calls).toEqual(["setFooter", "setHeader", "setEditorComponent", "onTerminalInput"]);
  });

  it("stays quiet when an extension restores pi's own default surface", () => {
    const { ctx, calls, reported } = setup();

    ctx.ui.setFooter(undefined);
    ctx.ui.setHeader(undefined);
    ctx.ui.setEditorComponent(undefined);

    expect(reported()).toEqual([]);
    expect(calls).toEqual(["setFooter", "setHeader", "setEditorComponent"]);
  });

  it("wraps each UI context exactly once", () => {
    const { ctx, reported, sessionStart } = setup();
    sessionStart();
    sessionStart();

    ctx.ui.setFooter(() => undefined);

    expect(reported()).toEqual(["setFooter"]);
  });

  it("re-patches a UI context rebuilt by a session switch", () => {
    const { ctx, sessionStart } = setup();
    const notify = vi.fn();
    ctx.ui = { ...ctx.ui, notify, setFooter: () => {} } as never;
    sessionStart();

    ctx.ui.setFooter(() => undefined);

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
