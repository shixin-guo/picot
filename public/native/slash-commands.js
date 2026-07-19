function normalizeNativeCommand(command) {
  const scope =
    command.location ??
    (typeof command.path === "string" && command.path.includes("/.pi/agent/")
      ? "global"
      : "global");
  return {
    ...command,
    type: command.source ?? "extension",
    scope,
    capabilityState: command.capabilityState ?? "enabled",
  };
}

export function buildCommandCatalog({ builtIns = [], nativeCommands = [] } = {}) {
  const catalog = new Map();
  for (const command of builtIns) {
    catalog.set(command.name, {
      ...command,
      type: "builtin",
      source: "picot",
      scope: "picot",
      capabilityState: command.capabilityState ?? "enabled",
    });
  }
  for (const command of nativeCommands) {
    if (!catalog.has(command.name)) catalog.set(command.name, normalizeNativeCommand(command));
  }
  return catalog;
}

export function resolveComposerInput(input, catalog, options = {}) {
  const message = String(input ?? "");
  if (message.startsWith("//")) {
    return runtimeIntent("prompt", message.slice(1), options.images);
  }
  if (message.startsWith("/")) {
    const match = /^\/([^\s]+)(?:\s+(.*))?$/s.exec(message);
    const name = match?.[1] ?? "";
    const args = match?.[2] ?? "";
    const command = catalog.get(name);
    if (!command) return { kind: "rejected", reason: `Unknown command: /${name}` };
    if (command.capabilityState !== "enabled") {
      return { kind: "rejected", reason: `Command unavailable: /${name}` };
    }
    if (options.working && command.streamingCompatible === false) {
      return {
        kind: "rejected",
        reason: `Command cannot run while the agent is working: /${name}`,
      };
    }
    if (command.type === "builtin") {
      return { kind: "builtin", action: command.action, arguments: args };
    }
    return runtimeIntent("prompt", message, options.images);
  }
  if (!options.working) return runtimeIntent("prompt", message, options.images);
  return runtimeIntent(options.altKey ? "follow_up" : "steer", message, options.images);
}

function runtimeIntent(type, message, images) {
  return {
    kind: "runtime",
    command: {
      type,
      message,
      ...(images?.length ? { images } : {}),
    },
  };
}
