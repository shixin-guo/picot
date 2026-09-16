import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";

export async function selectItem(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  helpText = "↑↓ navigate • enter select • esc cancel",
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
    const list = new SelectList(items, Math.min(Math.max(items.length, 3), 12), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", helpText), 1, 0));
    container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

export async function showNotice(
  ctx: ExtensionContext,
  title: string,
  message: string,
  kind: "info" | "warning" | "error" = "info",
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    const container = new Container();
    const color = kind === "error" ? "error" : kind === "warning" ? "warning" : "accent";
    container.addChild(new DynamicBorder((value: string) => theme.fg(color, value)));
    container.addChild(new Text(theme.fg(color, theme.bold(title)), 1, 0));
    for (const line of message.split("\n")) {
      container.addChild(new Text(line, 1, 0));
    }
    container.addChild(new Text(theme.fg("dim", "enter/esc close"), 1, 0));
    container.addChild(new DynamicBorder((value: string) => theme.fg(color, value)));
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (
          matchesKey(data, Key.enter) ||
          matchesKey(data, Key.escape) ||
          matchesKey(data, "ctrl+c")
        )
          done(undefined);
        tui.requestRender();
      },
    };
  });
}

export async function runWithLoader<T>(
  ctx: ExtensionContext,
  message: string,
  work: () => Promise<T>,
): Promise<{ value?: T; error?: string }> {
  let started = false;
  const runWork = async (): Promise<{ value?: T; error?: string }> => {
    started = true;
    try {
      return { value: await work() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  if (!ctx.hasUI) return runWork();
  const result = await ctx.ui.custom<{ value?: T; error?: string }>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
    void (async () => {
      done(await runWork());
    })();
    return loader;
  });
  return result ?? (started ? {} : runWork());
}
