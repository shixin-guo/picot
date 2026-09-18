// ABOUTME: Guards the task debugger's static markup in index.html — the button
// ABOUTME: and dialog ids app.js looks up, and the classes the panel toggles.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { expect, test } from "vitest";

const publicDir = join(process.cwd(), "public");
const indexHtml = readFileSync(join(publicDir, "index.html"), "utf8");
const appJs = readFileSync(join(publicDir, "native", "app.js"), "utf8");
const styleCss = readFileSync(join(publicDir, "style.css"), "utf8");
const document = new JSDOM(indexHtml).window.document;

test("the task debugger button lives in the header next to the other toggles", () => {
  const button = document.querySelector("#task-debugger-btn");

  expect(button).toBeTruthy();
  expect(button.closest(".header-right")).toBeTruthy();
  expect(button.classList.contains("ui-icon-button")).toBe(true);
  expect(button.getAttribute("aria-haspopup")).toBe("dialog");
  // The icon must be inline SVG like its sibling header buttons, not text.
  expect(button.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
});

test("the dialog ships every node the panel wires up", () => {
  for (const id of [
    "task-debugger-overlay",
    "task-debugger-dialog",
    "task-debugger-body",
    "task-debugger-close",
    "task-debugger-copy",
  ]) {
    expect(document.querySelector(`#${id}`), id).toBeTruthy();
  }
  expect(document.querySelectorAll('input[name="task-debugger-scope"]')).toHaveLength(2);
  expect(document.querySelector("#task-debugger-dialog")?.getAttribute("role")).toBe("dialog");
});

test("app.js looks up exactly the ids the markup defines", () => {
  // A renamed id on either side silently yields an inert panel, so pin the pair.
  for (const id of [
    "task-debugger-btn",
    "task-debugger-overlay",
    "task-debugger-dialog",
    "task-debugger-body",
    "task-debugger-close",
    "task-debugger-copy",
  ]) {
    expect(appJs, id).toContain(`getElementById("${id}")`);
  }
  expect(appJs).toContain('input[name="task-debugger-scope"]');
});

test("the panel stylesheet is imported so the dialog is not unstyled", () => {
  expect(styleCss).toContain('@import url("native/session/task-debugger-panel.css");');
});
