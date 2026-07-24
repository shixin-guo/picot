import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const styleCss = ["public/style.css", "public/ui/message-renderer.css"]
  .map((path) => readFileSync(resolve(path), "utf8"))
  .join("\n");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styleCss.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[2] ?? "";
}

describe("chat scroll layout", () => {
  test("lets the messages pane shrink inside the fixed viewport and own vertical overflow", () => {
    expect(ruleBody(".main")).toContain("min-height: 0");
    expect(ruleBody(".messages")).toContain("min-height: 0");
    expect(ruleBody(".messages")).toContain("overflow-y: auto");
    expect(ruleBody(".message")).toContain("min-width: 0");
    expect(ruleBody(".message .message-content")).toContain("max-width: 100%");
    expect(ruleBody(".message-content")).toContain("overflow-wrap: anywhere");
  });
});
