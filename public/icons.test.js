// ABOUTME: Verifies local action icons use one accessible Lucide-style SVG contract.
// ABOUTME: Icons are decorative; their buttons own localized accessible names.
import { expect, test } from "vitest";
import { createIcon, setButtonIcon } from "./icons.js";

test("creates local action icons with the shared SVG contract", () => {
  const icon = createIcon("save", { size: 14 });
  expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(icon?.getAttribute("stroke")).toBe("currentColor");
  expect(icon?.getAttribute("stroke-linecap")).toBe("round");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
});

test("replaces decorative button content without changing its accessible name", () => {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Save file");
  button.textContent = "Save";
  setButtonIcon(button, "save");
  expect(button.getAttribute("aria-label")).toBe("Save file");
  expect(button.querySelector("svg")).not.toBeNull();
});
