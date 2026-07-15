import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(join(process.cwd(), "public", "style.css"), "utf8");

describe("Super Agent runtime task layout", () => {
  it("keeps hidden quick actions out of the pending title's flex layout", () => {
    expect(stylesheet).toMatch(/\.runtime-task-header\s*\{[^}]*position:\s*relative;/s);
    expect(stylesheet).toMatch(
      /\.runtime-quick-actions\s*\{[^}]*position:\s*absolute;[^}]*right:\s*\d+px;/s,
    );
  });

  it("shows quick actions without an opacity transition", () => {
    expect(stylesheet).toMatch(/\.runtime-quick-actions\s*\{[^}]*display:\s*none;/s);
    expect(stylesheet).not.toMatch(/\.runtime-quick-actions\s*\{[^}]*opacity:/s);
    expect(stylesheet).toMatch(
      /\.runtime-task-card:hover \.runtime-quick-actions,[\s\S]*?\.runtime-task-card:focus-within \.runtime-quick-actions\s*\{[^}]*display:\s*inline-flex;/s,
    );
  });

  it("uses an opaque background to cover the title beneath visible quick actions", () => {
    expect(stylesheet).toMatch(
      /\.runtime-quick-actions\s*\{[^}]*background:\s*var\(--bg-solid\);/s,
    );
  });
});
