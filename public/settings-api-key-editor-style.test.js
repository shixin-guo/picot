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

  test("animates collapsed provider model lists despite their flex layout", () => {
    const rule = css.match(/\.api-model-list\.collapsed\s*\{(?<body>[^}]+)\}/)?.groups?.body;

    expect(rule).toBeTruthy();
    expect(rule).toContain("max-height: 0");
    expect(rule).toContain("opacity: 0");
  });

  test("animates collapsed project session lists", () => {
    const rule = css.match(/\.project-sessions\.collapsed\s*\{(?<body>[^}]+)\}/)?.groups?.body;

    expect(rule).toBeTruthy();
    expect(rule).toContain("max-height: 0");
    expect(rule).toContain("opacity: 0");
  });
});
