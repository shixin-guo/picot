// ABOUTME: Guards the Quick Chat composer against an unintended lower inset.
// ABOUTME: Treats the dialog edge-to-composer gap as an explicit layout contract.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "public/style.css"), "utf8");

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
