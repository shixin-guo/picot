import { describe, expect, it, vi } from "vitest";
import { CUSTOM_UI_OVERLAY_ENABLED, registerCustomUiBridge } from "./custom-ui-bridge";

const ESCAPE = String.fromCharCode(27);

/**
 * Let a panel finish opening: one tick resolves the component factory, the
 * next runs the deferred first paint.
 */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

type Frame = { op: string; id: string; lines?: string[]; width?: number; message?: string };

/**
 * Minimal stand-in for the pi extension runtime: captures the handlers the
 * bridge registers, and models the shared, mutable `ctx.ui` object that the
 * bridge patches.
 */
function setup({ enabled = true }: { enabled?: boolean } = {}) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const notifications: string[] = [];

  const ui = {
    theme: { name: "test" },
    // The stub `custom` mirrors pi's RPC mode: it never invokes the factory,
    // so a test that sees the factory run proves the patch took effect.
    custom: async (..._args: unknown[]) => undefined,
    notify: (message: string) => notifications.push(message),
  };
  const ctx = { ui };

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, options.handler);
    },
  };

  registerCustomUiBridge(pi as never, { enabled });
  handlers.get("session_start")?.({}, ctx);

  const frames = (): Frame[] =>
    notifications.map((message) => JSON.parse(message).__picotCustomUi as Frame).filter(Boolean);

  return {
    ctx,
    frames,
    shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
    sessionStart: () => handlers.get("session_start")?.({}, ctx),
    input: (payload: Record<string, unknown>) =>
      commands.get("picot-custom-ui")?.(JSON.stringify(payload), ctx),
  };
}

/**
 * A pi-tui-shaped component whose close key resolves its caller, the way
 * pi-mcp-adapter's panel calls `done()` from its own quit handler.
 */
function createComponent(lines: string[] = ["line one"]) {
  let done: (result: unknown) => void = () => {};
  const component = {
    lines,
    keys: [] as string[],
    disposed: false,
    requestRender: () => {},
    render: () => component.lines,
    handleInput(data: string) {
      component.keys.push(data);
      if (data === ESCAPE) done("closed");
    },
    dispose() {
      component.disposed = true;
    },
    /** Factory adapter: binds the host's `done` and records its `tui`. */
    build(tui: { requestRender: () => void }, resolve: (result: unknown) => void) {
      component.requestRender = tui.requestRender;
      done = resolve;
      return component;
    },
  };
  return component;
}

/** Open a panel backed by `component` and hand back the caller's promise. */
function open(
  ctx: { ui: { custom: (factory: unknown, options?: unknown) => Promise<unknown> } },
  component: ReturnType<typeof createComponent>,
  options?: unknown,
) {
  return ctx.ui.custom(
    ((tui: { requestRender: () => void }, _theme, _keys, done: (result: unknown) => void) =>
      component.build(tui, done)) as never,
    options,
  );
}

describe("registerCustomUiBridge", () => {
  it("stays a no-op while the GUI overlay is disabled", async () => {
    expect(CUSTOM_UI_OVERLAY_ENABLED).toBe(true);
    const { ctx, frames } = setup({ enabled: false });
    const component = createComponent();

    void open(ctx, component, { overlay: true, overlayOptions: { width: 60 } });
    await flush();

    expect(frames()).toEqual([]);
    expect(await ctx.ui.custom()).toBeUndefined();
  });

  it("replaces the RPC stub so the component actually renders", async () => {
    const { ctx, frames } = setup();
    const component = createComponent();

    void open(ctx, component, { overlay: true, overlayOptions: { width: 60 } });
    await flush();

    expect(frames()).toEqual([{ op: "open", id: "panel-1", width: 60, lines: ["line one"] }]);
  });

  it("falls back to a default width when the overlay does not request one", async () => {
    const { ctx, frames } = setup();

    void open(ctx, createComponent());
    await flush();

    expect(frames()[0].width).toBe(82);
  });

  it("resolves the awaiting caller when the component calls done", async () => {
    const { ctx, input } = setup();
    const pending = open(ctx, createComponent());
    await flush();

    input({ id: "panel-1", data: ESCAPE });
    await expect(pending).resolves.toBe("closed");
  });

  it("routes keystrokes to the component and repaints", async () => {
    const { ctx, frames, input } = setup();
    const component = createComponent();
    void open(ctx, component);
    await flush();

    component.lines = ["line two"];
    input({ id: "panel-1", data: `${ESCAPE}[B` });

    expect(component.keys).toEqual([`${ESCAPE}[B`]);
    expect(frames().at(-1)).toEqual({ op: "update", id: "panel-1", lines: ["line two"] });
  });

  it("repaints when the component asks the host to re-render", async () => {
    const { ctx, frames } = setup();
    const component = createComponent();
    void open(ctx, component);
    await flush();

    component.lines = ["repainted"];
    component.requestRender();

    expect(frames().at(-1)).toEqual({ op: "update", id: "panel-1", lines: ["repainted"] });
  });

  it("cancel drives the component's own close key rather than force-settling", async () => {
    const { ctx, frames, input } = setup();
    const component = createComponent();
    const pending = open(ctx, component);
    await flush();

    input({ id: "panel-1", cancel: true });

    expect(component.keys).toEqual([ESCAPE]);
    await expect(pending).resolves.toBe("closed");
    // Closing must emit exactly one close frame and no trailing repaint.
    expect(frames().filter((frame) => frame.op === "close")).toHaveLength(1);
    expect(frames().at(-1)?.op).toBe("close");
    expect(component.disposed).toBe(true);
  });

  it("force-settles when a component ignores its close key", async () => {
    const { ctx, input } = setup();
    const pending = ctx.ui.custom(
      (() => ({ render: () => ["stubborn"], handleInput: () => {} })) as never,
      undefined,
    );
    await flush();

    input({ id: "panel-1", cancel: true });
    await expect(pending).resolves.toBeUndefined();
  });

  it("re-reveals the panel underneath when a nested overlay closes", async () => {
    const { ctx, frames, input } = setup();
    void open(ctx, createComponent(["outer"]));
    await flush();
    void open(ctx, createComponent(["inner"]));
    await flush();

    input({ id: "panel-2", cancel: true });

    // The WebView tore its terminal down when panel-2 opened, so the panel
    // underneath has to be re-opened rather than repainted.
    expect(frames().slice(-2)).toEqual([
      { op: "close", id: "panel-2" },
      { op: "open", id: "panel-1", width: 82, lines: ["outer"] },
    ]);
  });

  it("reports a factory that throws instead of hanging the caller", async () => {
    const { ctx, frames } = setup();
    const pending = ctx.ui.custom(
      (() => {
        throw new Error("boom");
      }) as never,
      undefined,
    );

    await expect(pending).resolves.toBeUndefined();
    // The panel never reached the WebView, so there is nothing to close.
    expect(frames().map((frame) => frame.op)).toEqual(["error"]);
    expect(frames()[0].message).toBe("boom");
  });

  it("releases panels still open at session shutdown", async () => {
    const { ctx, shutdown } = setup();
    const pending = open(ctx, createComponent());
    await flush();

    shutdown();
    await expect(pending).resolves.toBeUndefined();
  });

  it("re-patches a UI context rebuilt by a session switch", async () => {
    const { ctx, sessionStart } = setup();
    // The RPC host builds a fresh UI context on rebind; the bridge must notice
    // even though the replacement looks just like the one it already patched.
    const custom = vi.fn(async () => undefined);
    ctx.ui = { ...ctx.ui, custom } as never;
    sessionStart();

    void open(ctx, createComponent());
    await flush();

    expect(custom).not.toHaveBeenCalled();
  });

  it("never paints an overlay the extension hides from inside onHandle", async () => {
    const { ctx, frames } = setup();
    let handle: { setHidden: (hidden: boolean) => void } | undefined;

    // How an extension parks a panel at session start: open it, hide it, and
    // reveal it later from its own slash command.
    void open(ctx, createComponent(["mcp servers"]), {
      overlay: true,
      onHandle: (received: { setHidden: (hidden: boolean) => void }) => {
        handle = received;
        received.setHidden(true);
      },
    });
    await flush();

    expect(frames()).toEqual([]);

    handle?.setHidden(false);
    expect(frames()).toEqual([{ op: "open", id: "panel-1", width: 82, lines: ["mcp servers"] }]);
  });

  it("hides and re-reveals a parked overlay without disturbing the caller", async () => {
    const { ctx, frames } = setup();
    let handle: { setHidden: (hidden: boolean) => void; isHidden: () => boolean } | undefined;
    void open(ctx, createComponent(), {
      overlay: true,
      onHandle: (received: never) => {
        handle = received;
      },
    });
    await flush();

    handle?.setHidden(true);
    expect(handle?.isHidden()).toBe(true);
    expect(frames().at(-1)).toEqual({ op: "close", id: "panel-1" });

    handle?.setHidden(false);
    expect(frames().at(-1)).toEqual({
      op: "open",
      id: "panel-1",
      width: 82,
      lines: ["line one"],
    });
  });

  it("routes keystrokes past a hidden panel to the visible one", async () => {
    const { ctx, input } = setup();
    const parked = createComponent(["parked"]);
    let handle: { setHidden: (hidden: boolean) => void } | undefined;
    void open(ctx, parked, {
      overlay: true,
      onHandle: (received: never) => {
        handle = received;
      },
    });
    await flush();
    handle?.setHidden(true);

    const visible = createComponent(["visible"]);
    void open(ctx, visible);
    await flush();

    input({ data: "x" });

    expect(visible.keys).toEqual(["x"]);
    expect(parked.keys).toEqual([]);
  });

  it("ignores input for an unknown panel", () => {
    const { input } = setup();
    expect(() => input({ id: "missing", data: "x" })).not.toThrow();
  });
});
