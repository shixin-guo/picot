// ABOUTME: Selects a platform-native opener without invoking a shell.
// ABOUTME: Returns an executable and argument vector so callers can preserve paths verbatim.

import * as path from "node:path";

export type OpenCommand = { command: string; args: string[] };

export function getOpenCommand(platform: string, target: string): OpenCommand {
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open";
  return { command, args: [target] };
}

export function resolveHomePath(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}
