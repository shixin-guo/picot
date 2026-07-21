// @vitest-environment node

// ABOUTME: Verifies the shared core-command manifest and its TS enforcement.
// ABOUTME: Asserts schema, exhaustive source parity, and fail-closed authorization.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../protocol/picot-core-commands.json";
import { assertEphemeralCommandAllowed, classifyCoreCommand } from "./command-policy.ts";

// Commands that Task 6/11 add as embedded-server case labels but are predeclared
// in the manifest so the parity check stays green across that change.
const PREDECLARED_EPHEMERAL_COMMANDS = ["ephemeral_snapshot_request", "extension_ui_response"];

function readHandleCommandCases(): Set<string> {
  const sourcePath = fileURLToPath(new URL("./embedded-server.ts", import.meta.url));
  const source = readFileSync(sourcePath, "utf8");
  const labels = new Set<string>();
  for (const match of source.matchAll(/case\s+"([A-Za-z0-9_]+)"\s*:/g)) {
    labels.add(match[1]);
  }
  return labels;
}

describe("picot-core-commands manifest", () => {
  it("declares schema version 1", () => {
    expect(manifest.version).toBe(1);
  });

  it("uses only the three declared permission values", () => {
    const allowed = new Set(["allowed", "deniedSessionLifecycle", "desktopOwnerOnly"]);
    for (const value of Object.values(manifest.commands)) {
      expect(allowed.has(value)).toBe(true);
    }
  });

  it("classifies every handleCommand case plus the two predeclared ephemeral commands", () => {
    const manifestNames = new Set(Object.keys(manifest.commands));
    const sourceCases = readHandleCommandCases();
    for (const label of sourceCases) {
      expect(manifestNames.has(label)).toBe(true);
    }
    for (const label of PREDECLARED_EPHEMERAL_COMMANDS) {
      expect(manifestNames.has(label)).toBe(true);
    }
    // Exact parity via set union: every handled case plus the predeclared
    // commands, with no stale/unhandled entry lingering in the manifest.
    const expectedCommands = new Set([...sourceCases, ...PREDECLARED_EPHEMERAL_COMMANDS]);
    expect(Object.keys(manifest.commands).length).toBe(expectedCommands.size);
    for (const name of Object.keys(manifest.commands)) {
      expect(expectedCommands.has(name)).toBe(true);
    }
  });
});

describe("classifyCoreCommand", () => {
  it("classifies prompt as allowed", () => {
    expect(classifyCoreCommand("prompt")).toBe("allowed");
  });

  it("classifies new_session as deniedSessionLifecycle", () => {
    expect(classifyCoreCommand("new_session")).toBe("deniedSessionLifecycle");
  });

  it("classifies set_api_key as desktopOwnerOnly", () => {
    expect(classifyCoreCommand("set_api_key")).toBe("desktopOwnerOnly");
  });

  it("returns null for an unknown command", () => {
    expect(classifyCoreCommand("totally_unknown_command_xyz")).toBeNull();
  });
});

describe("assertEphemeralCommandAllowed", () => {
  it("allows prompt regardless of the desktop-owner flag", () => {
    expect(() => assertEphemeralCommandAllowed("prompt", false)).not.toThrow();
    expect(() => assertEphemeralCommandAllowed("prompt", true)).not.toThrow();
  });

  it("denies session-lifecycle commands with the generic message", () => {
    expect(() => assertEphemeralCommandAllowed("switch_session", true)).toThrow(
      "Command is not available in temporary chat",
    );
  });

  it("denies desktop-owner-only commands when not the desktop owner", () => {
    expect(() => assertEphemeralCommandAllowed("set_api_key", false)).toThrow(
      "Command is not available in temporary chat",
    );
  });

  it("allows desktop-owner-only commands for the desktop owner", () => {
    expect(() => assertEphemeralCommandAllowed("set_api_key", true)).not.toThrow();
  });

  it("denies unknown commands with the same generic message", () => {
    expect(() => assertEphemeralCommandAllowed("does_not_exist", true)).toThrow(
      "Command is not available in temporary chat",
    );
  });

  it("never echoes an attacker-supplied command in the error", () => {
    const evil = "evil_injected_command_42";
    try {
      assertEphemeralCommandAllowed(evil, false);
      throw new Error("expected assertEphemeralCommandAllowed to throw");
    } catch (e) {
      expect((e as Error).message).not.toContain(evil);
    }
  });
});
