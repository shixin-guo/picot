// ABOUTME: Loads and enforces the shared Picot core-command classification manifest.
// ABOUTME: Gates RPC commands in the embedded ephemeral Pi process and related surfaces.

import manifest from "../protocol/picot-core-commands.json";

export type EphemeralPermission = "allowed" | "deniedSessionLifecycle" | "desktopOwnerOnly";

const PERMISSION_VALUES: ReadonlySet<EphemeralPermission> = new Set([
  "allowed",
  "deniedSessionLifecycle",
  "desktopOwnerOnly",
]);

const GENERIC_DENY_MESSAGE = "Command is not available in temporary chat";

type ManifestShape = { version: unknown; commands: Record<string, unknown> };

function parseManifest(raw: unknown): ReadonlyMap<string, EphemeralPermission> {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("picot-core-commands manifest must be an object");
  }
  const { version, commands } = raw as ManifestShape;
  if (version !== 1) {
    throw new Error("picot-core-commands manifest must declare version 1");
  }
  if (typeof commands !== "object" || commands === null) {
    throw new Error("picot-core-commands manifest must declare a commands object");
  }
  const parsed = new Map<string, EphemeralPermission>();
  for (const [name, value] of Object.entries(commands)) {
    if (!name) {
      throw new Error("picot-core-commands manifest contains an invalid command name");
    }
    if (typeof value !== "string" || !PERMISSION_VALUES.has(value as EphemeralPermission)) {
      throw new Error("picot-core-commands manifest contains an invalid permission");
    }
    parsed.set(name, value as EphemeralPermission);
  }
  return parsed;
}

const COMMANDS = parseManifest(manifest);

export function classifyCoreCommand(type: string): EphemeralPermission | null {
  return COMMANDS.get(type) ?? null;
}

export function assertEphemeralCommandAllowed(
  type: string,
  authenticatedDesktopOwner: boolean,
): void {
  const permission = COMMANDS.get(type);
  if (permission === undefined || permission === "deniedSessionLifecycle") {
    throw new Error(GENERIC_DENY_MESSAGE);
  }
  if (permission === "desktopOwnerOnly" && !authenticatedDesktopOwner) {
    throw new Error(GENERIC_DENY_MESSAGE);
  }
}
