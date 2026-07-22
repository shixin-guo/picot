// ABOUTME: Verifies that leaving a Super Agent session clears its active navigation state.
// ABOUTME: Keeps the legacy panel behavior covered after moving it into a focused module.
import { afterEach, expect, test } from "vitest";
import { installSuperAgentSessionNavigationReset } from "./navigation.js";

afterEach(() => {
  document.body.replaceChildren();
});

test("clears Super Agent state when a normal session is selected", () => {
  document.body.innerHTML = `
    <div id="session-list"><button class="session-item">Session</button></div>
    <div id="super-agent-sidebar-entry" class="active"></div>
    <div id="super-agent-chat-header"></div>
  `;
  document.body.classList.add("super-agent-active");
  const cleanup = installSuperAgentSessionNavigationReset(document);

  document.querySelector(".session-item").click();

  expect(document.body.classList.contains("super-agent-active")).toBe(false);
  expect(document.querySelector("#super-agent-sidebar-entry").classList.contains("active")).toBe(
    false,
  );
  expect(document.querySelector("#super-agent-chat-header").classList.contains("hidden")).toBe(
    true,
  );
  cleanup();
});
