// ABOUTME: Guards the main toolbar's app-picker backdrop against transparent theme fallbacks.
// ABOUTME: The workspace app menu must use the theme's opaque surface token.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const stylesheet = readFileSync(resolve("public/native/workspace/header-open-app.css"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("header app menu styling", () => {
  test("uses an opaque theme surface for the workspace app picker", () => {
    const body = ruleBody(".header-open-app-menu");

    expect(body).toContain("background: var(--bg-solid)");
    expect(body).not.toContain("--bg-elevated");
    expect(body).not.toMatch(/var\(--bg\s*[,)]/);
  });
});
