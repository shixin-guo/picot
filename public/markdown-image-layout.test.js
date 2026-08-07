// ABOUTME: Verifies Markdown images remain within their rendering container.
// ABOUTME: Covers assistant chat messages and Markdown file previews.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Image styling lives in the feature-owned markdown stylesheet after the
// monolithic style.css split into per-module files.
const stylePath = join(process.cwd(), "public/ui/markdown.css");

describe("Markdown image layout", () => {
  test("constrains assistant inline images to their container width", async () => {
    const css = await readFile(stylePath, "utf8");

    expect(css).toMatch(
      /\.message\.assistant \.message-content \.inline-image\s*\{[^}]*max-width:\s*100%;/,
    );
  });
});
