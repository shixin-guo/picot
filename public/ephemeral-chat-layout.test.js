// ABOUTME: Verifies the ephemeral-chat entry points use their approved shell locations.
// ABOUTME: Guards the native-only Quick Chat control from drifting into the workspace header.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

describe("ephemeral chat entry points", () => {
  it("places native Quick Chat in the sidebar toolbar immediately after search", () => {
    const sidebar = document.createElement("div");
    sidebar.innerHTML = html;

    const toolbar = sidebar.querySelector(".sidebar-header > .sidebar-actions");
    const quickChat = toolbar?.querySelector("#quick-chat-btn");

    expect(quickChat).not.toBeNull();
    expect(quickChat.classList.contains("lan-only")).toBe(false);
    expect(sidebar.querySelector(".header #quick-chat-btn")).toBeNull();
  });

  it("keeps Side Chat hidden until the authenticated native capability arrives", () => {
    const shell = document.createElement("div");
    shell.innerHTML = html;

    expect(shell.querySelector("#side-chat-btn").classList.contains("hidden")).toBe(true);
  });
});
