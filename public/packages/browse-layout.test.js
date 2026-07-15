import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const styleCss = readFileSync(resolve("public/style.css"), "utf8");

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styleCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

describe("extensions browse layout", () => {
  test("keeps marketplace cards at one stable height", () => {
    expect(ruleBody(".pkg-browse-row")).toContain("height: 140px");
  });

  test("clamps package descriptions to two hidden lines", () => {
    const descriptionRule = ruleBody(".pkg-browse-row .settings-extension-description");

    expect(descriptionRule).toContain("display: -webkit-box");
    expect(descriptionRule).toContain("-webkit-line-clamp: 2");
    expect(descriptionRule).toContain("overflow: hidden");
  });

  test("lets visible install errors expand beyond the card clamp", () => {
    const errorRule = ruleBody(
      ".pkg-browse-row:has(.settings-extension-status.is-error:not([hidden]))",
    );

    expect(errorRule).toContain("height: auto");
    expect(errorRule).toContain("overflow: visible");
  });
});
