// ABOUTME: Verifies the file-sidebar toggle uses the shared icon-button
// ABOUTME: design system (the new-arch replacement for the v3 panel-toggle-btn).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { expect, test } from "vitest";

const publicDir = join(process.cwd(), "public");
const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8");
const designSystemCss = readFileSync(join(publicDir, "design-system.css"), "utf8");
const document = new JSDOM(indexHtml).window.document;

test("file sidebar uses the shared icon-button control", () => {
  const button = document.querySelector("#file-sidebar-toggle");

  expect(button?.classList.contains("ui-icon-button")).toBe(true);
  expect(button?.getAttribute("aria-label")).toBe("Toggle file browser");
});

test("Side Chat keeps its existing icon button styling", () => {
  const button = document.querySelector("#side-chat-btn");

  expect(button?.classList.contains("icon-btn")).toBe(true);
  expect(button?.classList.contains("panel-toggle-btn")).toBe(false);
});

test("icon-button design system defines the shared control contract", () => {
  expect(designSystemCss).toContain(".ui-icon-button");
  expect(designSystemCss).toContain("border-radius: var(--radius-md);");
  expect(designSystemCss).toContain("width: var(--control-height-md);");
});
