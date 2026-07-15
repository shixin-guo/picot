import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const styleCss = readFileSync(resolve("public/style.css"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styleCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("composer opacity", () => {
  test("keeps the bottom input area opaque over scrolling output", () => {
    expect(ruleBody(".input-area")).toContain("background: var(--bg-solid)");
  });

  test("does not fade readonly or disabled composer states", () => {
    expect(ruleBody(".input-area.mirror-readonly")).toContain("opacity: 1");
    expect(ruleBody("#message-input:disabled")).toContain("opacity: 1");
  });
});
