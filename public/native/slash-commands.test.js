import { describe, expect, it } from "vitest";
import { buildCommandCatalog, resolveComposerInput } from "./slash-commands.js";

const catalog = buildCommandCatalog({
  builtIns: [{ name: "settings", description: "Open settings", action: "open_settings" }],
  nativeCommands: [
    { name: "review", description: "Review", source: "extension", path: "/global/review.ts" },
    { name: "fix", description: "Fix", source: "prompt", location: "project" },
    { name: "skill:test", description: "Test", source: "skill", location: "global" },
  ],
});

describe("slash commands", () => {
  it("merges command source, scope, type, and capability state", () => {
    expect(catalog.get("settings")).toMatchObject({ type: "builtin", scope: "picot" });
    expect(catalog.get("review")).toMatchObject({ type: "extension", scope: "global" });
    expect(catalog.get("fix")).toMatchObject({ type: "prompt", scope: "project" });
  });

  it("treats // as a literal slash and rejects unknown commands", () => {
    expect(resolveComposerInput("//literal", catalog, { working: false })).toEqual({
      kind: "runtime",
      command: { type: "prompt", message: "/literal" },
    });
    expect(resolveComposerInput("/missing", catalog, { working: false })).toEqual({
      kind: "rejected",
      reason: "Unknown command: /missing",
    });
  });

  it("routes built-ins locally and native commands through prompt exactly once", () => {
    expect(resolveComposerInput("/settings", catalog, { working: false })).toEqual({
      kind: "builtin",
      action: "open_settings",
      arguments: "",
    });
    expect(resolveComposerInput("/review files", catalog, { working: true })).toEqual({
      kind: "runtime",
      command: { type: "prompt", message: "/review files" },
    });
    expect(resolveComposerInput("hello", catalog, { working: true, altKey: false })).toEqual({
      kind: "runtime",
      command: { type: "steer", message: "hello" },
    });
    expect(resolveComposerInput("later", catalog, { working: true, altKey: true })).toEqual({
      kind: "runtime",
      command: { type: "follow_up", message: "later" },
    });
  });
});
