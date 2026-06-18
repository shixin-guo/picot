import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("settings API key editor style", () => {
  const css = readFileSync(join(process.cwd(), "public/style.css"), "utf8");

  test("uses a theme-aware dark input surface for API keys", () => {
    const rule = css.match(/\.api-key-editor input\s*\{(?<body>[^}]+)\}/)?.groups?.body;

    expect(rule).toBeTruthy();
    expect(rule).toContain("background: var(--bg-glass-strong");
    expect(rule).not.toContain("#fff");
  });
});
