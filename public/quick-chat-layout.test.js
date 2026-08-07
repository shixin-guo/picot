// ABOUTME: Guards the Quick Chat composer against an unintended lower inset.
// ABOUTME: Treats the dialog edge-to-composer gap as an explicit layout contract.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Quick Chat ephemeral styles live in the feature-owned stylesheet (the
// monolithic public/style.css split into per-module files); read it directly
// so this layout contract guards the actual rules.
const css = readFileSync(join(process.cwd(), "public/native/session/ephemeral-chat.css"), "utf8");

describe("Quick Chat composer layout", () => {
  it("matches the composer bottom margin to its horizontal margin", () => {
    expect(css).toMatch(
      /\.quick-chat-dialog \.ephemeral-composer\s*\{\s*margin-bottom:\s*12px;\s*\}/,
    );
  });

  it("keeps resize handles out of the dialog flex layout", () => {
    expect(css).toMatch(/\.quick-chat-resize-handle\s*\{\s*position:\s*absolute;\s*\}/);
  });
});
