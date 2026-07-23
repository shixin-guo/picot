import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styleCss = ["public/style.css", "public/native/session-sidebar.css"]
  .map((path) => readFileSync(resolve(path), "utf8"))
  .join("\n");

function ruleFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styleCss.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "s"));
  expect(match, `Missing CSS rule for ${selector}`).toBeTruthy();
  return match[1];
}

describe("sidebar session action controls", () => {
  it("overlays the archive button without reserving title-row space", () => {
    const actionSlotRule = ruleFor(".session-action-slot");
    const archiveButtonRule = ruleFor(".session-archive-btn");

    expect(actionSlotRule).toMatch(/position:\s*absolute;/);
    expect(actionSlotRule).toMatch(/right:\s*0;/);
    expect(actionSlotRule).toMatch(/background:\s*linear-gradient\(/);
    expect(archiveButtonRule).toMatch(/justify-content:\s*center;/);
  });

  it("gives the archived delete-all button a fixed centered hit target", () => {
    const deleteAllButtonRule = ruleFor(".archived-delete-all-btn");
    const revealRule = ruleFor(".archived-header:hover .archived-delete-all-btn");

    expect(deleteAllButtonRule).toMatch(/width:\s*20px;/);
    expect(deleteAllButtonRule).toMatch(/height:\s*20px;/);
    expect(deleteAllButtonRule).toMatch(/padding:\s*0;/);
    expect(deleteAllButtonRule).toMatch(/align-items:\s*center;/);
    expect(deleteAllButtonRule).toMatch(/justify-content:\s*center;/);
    expect(revealRule).not.toMatch(/align-items:/);
  });
});
