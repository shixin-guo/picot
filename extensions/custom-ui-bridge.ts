// ABOUTME: Renders `ctx.ui.custom()` overlays headlessly so they reach the Picot WebView.
// ABOUTME: pi's RPC mode stubs custom() out, which hangs any extension that awaits it.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi's RPC-mode UI context implements `custom()` as `async () => undefined`: the
// factory is never invoked and the caller's `done` callback never fires. An
// extension that wraps the call in `new Promise(resolve => ctx.ui.custom(...))`
// — pi-mcp-adapter's `/mcp` panel does exactly this — therefore blocks forever.
//
// Every extension shares one mutable UI context object (ExtensionRunner exposes
// it through a `get ui()` accessor), so replacing `custom` here makes the real
// implementation visible to extensions Picot does not own. We drive the
// component the way a terminal would: render it to lines, ship those to the
// WebView, and feed keystrokes back in through the `picot-custom-ui` command.
//
// The wire format rides `ctx.ui.notify(JSON)` and the frontend correlates by
// panel id, mirroring the `picot-config` data plane (see
// public/native/extensions/custom-ui-panel.js).
//
// Overlays carry a real hidden state (`OverlayHandle.setHidden`), which is how
// extensions park a panel at session start and reveal it later from a command.
// The bridge honours it: a panel is shipped to the WebView only while it is the
// topmost non-hidden entry in the stack, and the first paint is deferred by a
// microtask so a panel hidden inside `onHandle` never flashes on screen.

/** When false, `registerCustomUiBridge` is a no-op and `custom()` stays stubbed. */
export const CUSTOM_UI_OVERLAY_ENABLED = true;

const DEFAULT_WIDTH = 82;
const MIN_WIDTH = 20;
const MAX_WIDTH = 200;
/** ESC — the conventional "close this overlay" key for pi-tui components. */
const ESCAPE = String.fromCharCode(27);

/** Structural subset of pi-tui's `Component` that a custom overlay must satisfy. */
type OverlayComponent = {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
};

type CustomUiOptions = {
  overlay?: boolean;
  overlayOptions?: { width?: number } | (() => { width?: number } | undefined);
  onHandle?: (handle: unknown) => void;
};

type Panel = {
  id: string;
  component: OverlayComponent;
  width: number;
  /** Temporarily hidden via the overlay handle; still stacked, just not painted. */
  hidden: boolean;
  settle: (result: unknown) => void;
};

function resolveWidth(options: CustomUiOptions | undefined): number {
  const raw =
    typeof options?.overlayOptions === "function"
      ? options.overlayOptions()
      : options?.overlayOptions;
  const width = raw?.width;
  if (typeof width !== "number" || !Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

export function registerCustomUiBridge(pi: ExtensionAPI, options?: { enabled?: boolean }): void {
  if (!(options?.enabled ?? CUSTOM_UI_OVERLAY_ENABLED)) return;

  // Panels form a stack so a component that opens a nested overlay behaves the
  // way it would in the TUI: input goes to the topmost visible panel.
  const stack: Panel[] = [];
  let nextPanelId = 0;
  /** Id of the panel the WebView is currently showing, or null when none is. */
  let shownId: string | null = null;

  const top = (): Panel | undefined => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const panel = stack[index];
      if (!panel.hidden) return panel;
    }
    return undefined;
  };

  const emit = (ui: ExtensionContext["ui"], payload: Record<string, unknown>): void => {
    ui.notify(JSON.stringify({ __picotCustomUi: payload }), "info");
  };

  const renderPanel = (panel: Panel): string[] => {
    try {
      return panel.component.render(panel.width) ?? [];
    } catch (error) {
      return [`Failed to render panel: ${error instanceof Error ? error.message : String(error)}`];
    }
  };

  /** Repaint a panel, but only while it is the one on screen. */
  const repaint = (ui: ExtensionContext["ui"], panel: Panel): void => {
    if (panel.id !== shownId) return;
    emit(ui, { op: "update", id: panel.id, lines: renderPanel(panel) });
  };

  /**
   * Bring the WebView in line with the stack. The frontend shows one panel at a
   * time, so a change of topmost-visible panel is a close of the old followed
   * by an open of the new — an `update` would be dropped, because the WebView
   * has already torn down the terminal for the panel that just went away.
   */
  const syncVisible = (ui: ExtensionContext["ui"]): void => {
    const next = top();
    if ((next?.id ?? null) === shownId) return;
    if (shownId) emit(ui, { op: "close", id: shownId });
    shownId = next?.id ?? null;
    if (next) emit(ui, { op: "open", id: next.id, width: next.width, lines: renderPanel(next) });
  };

  /**
   * The `OverlayHandle` pi-tui hands back from `showOverlay`. Visibility and
   * focus are the same thing here: the WebView paints exactly one panel, the
   * topmost visible one, and it always owns the keyboard.
   */
  const createOverlayHandle = (panel: Panel, ui: ExtensionContext["ui"]) => ({
    hide: () => panel.settle(undefined),
    setHidden: (hidden: boolean) => {
      if (panel.hidden === hidden) return;
      panel.hidden = hidden;
      syncVisible(ui);
    },
    isHidden: () => panel.hidden,
    focus: () => {
      panel.hidden = false;
      const index = stack.indexOf(panel);
      if (index >= 0 && index !== stack.length - 1) {
        stack.splice(index, 1);
        stack.push(panel);
      }
      syncVisible(ui);
    },
    unfocus: () => {
      // Drop below the rest of the stack so the next visible overlay takes
      // over, mirroring pi-tui's "release focus to the next capturing overlay".
      const index = stack.indexOf(panel);
      if (index >= 0) {
        stack.splice(index, 1);
        stack.unshift(panel);
      }
      syncVisible(ui);
    },
    isFocused: () => top() === panel,
  });

  // Tracked by identity rather than a marker property: the RPC host rebuilds
  // the UI context on every session rebind, and a copied marker would make a
  // genuinely unpatched context look patched.
  const patched = new WeakSet<object>();

  const ensurePatched = (ctx: ExtensionContext): void => {
    const ui = ctx.ui;
    if (!ui || patched.has(ui)) return;
    patched.add(ui);

    ui.custom = (<T>(
      factory: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => OverlayComponent | Promise<OverlayComponent>,
      options?: CustomUiOptions,
    ): Promise<T> => {
      const id = `panel-${++nextPanelId}`;
      const width = resolveWidth(options);

      return new Promise<T>((resolve) => {
        let panel: Panel | undefined;
        let settled = false;

        const settle = (result: unknown): void => {
          if (settled) return;
          settled = true;
          const index = stack.findIndex((entry) => entry.id === id);
          if (index >= 0) stack.splice(index, 1);
          try {
            panel?.component.dispose?.();
          } catch {
            // A failing dispose must not strand the awaiting extension.
          }
          syncVisible(ui);
          resolve(result as T);
        };

        const push = (): void => {
          if (settled || !panel) return;
          repaint(ui, panel);
        };

        // Components only ever ask the host to re-render; everything else they
        // need (`matchesKey`, width helpers) they import from pi-tui directly.
        const tui = { requestRender: push };
        // Passing no keybindings manager makes components fall back to pi-tui's
        // stock arrow/enter bindings, which is what the WebView sends.
        const keybindings = undefined;

        let created: OverlayComponent | Promise<OverlayComponent>;
        try {
          created = factory(tui, ui.theme, keybindings, (result: T) => settle(result));
        } catch (error) {
          emit(ui, {
            op: "error",
            id,
            message: error instanceof Error ? error.message : String(error),
          });
          settle(undefined);
          return;
        }

        void Promise.resolve(created)
          .then((component) => {
            if (settled) {
              // `done` fired synchronously inside the factory.
              component.dispose?.();
              return;
            }
            panel = { id, component, width, hidden: false, settle };
            stack.push(panel);
            options?.onHandle?.(createOverlayHandle(panel, ui));
            // Paint on the next microtask, not on the call. An extension that
            // parks a panel at session start opens it and hides it again from
            // inside `onHandle`; showing it synchronously would flash a modal
            // across the GUI. The TUI has the same grace period — it repaints
            // on the next frame.
            queueMicrotask(() => {
              if (!settled) syncVisible(ui);
            });
          })
          .catch((error) => {
            emit(ui, {
              op: "error",
              id,
              message: error instanceof Error ? error.message : String(error),
            });
            settle(undefined);
          });
      });
    }) as ExtensionContext["ui"]["custom"];
  };

  // Patch as early and as often as is cheap: `ensurePatched` is a single flag
  // check once the current UI context has been wrapped.
  pi.on("session_start", (_event, ctx) => ensurePatched(ctx));
  pi.on("input", (_event, ctx) => ensurePatched(ctx));
  pi.on("before_agent_start", (_event, ctx) => ensurePatched(ctx));

  // Abandoned panels would otherwise keep their caller blocked past shutdown.
  pi.on("session_shutdown", () => {
    for (const panel of [...stack].reverse()) panel.settle(undefined);
  });

  pi.registerCommand("picot-custom-ui", {
    description: "Picot internal: deliver input to a custom extension UI panel",
    handler: async (rawArguments, ctx) => {
      ensurePatched(ctx);
      let request: { id?: string; data?: string; cancel?: boolean };
      try {
        request = JSON.parse(rawArguments) as typeof request;
      } catch {
        return;
      }
      const panel = request.id ? stack.find((entry) => entry.id === request.id) : top();
      if (!panel) return;

      // Cancelling goes through the component's own close key rather than
      // straight to `settle`. A component typically resolves its caller from
      // inside that handler (pi-mcp-adapter's panel calls `done()` there), and
      // force-settling would leave the caller's own promise pending forever.
      const data = request.cancel ? ESCAPE : request.data;
      if (typeof data !== "string" || !data) return;

      try {
        panel.component.handleInput?.(data);
      } catch (error) {
        emit(ctx.ui, {
          op: "error",
          id: panel.id,
          message: error instanceof Error ? error.message : String(error),
        });
        panel.settle(undefined);
        return;
      }

      // The keystroke may have closed the panel, in which case `settle` has
      // already emitted `close` and repainting would resurrect it.
      if (!stack.includes(panel)) return;
      if (request.cancel) {
        // The component ignored its close key; fall back to force-settling so
        // the panel does not become unclosable from the WebView.
        panel.settle(undefined);
        return;
      }
      // Components normally repaint through `tui.requestRender()`, but repaint
      // unconditionally so a component that mutates state without asking for a
      // render still shows the result of the keystroke.
      repaint(ctx.ui, panel);
    },
  });
}
