import { describe, expect, it } from "vitest";
import { ConvNav } from "./conv-nav.js";

function setupDom() {
  document.body.innerHTML = `
    <div class="header"></div>
    <div id="messages"></div>
    <div id="conv-nav" class="conv-nav">
      <div id="conv-nav-track"></div>
    </div>
    <div id="conv-nav-tooltip" class="hidden">
      <div id="conv-nav-tooltip-q"></div>
      <div id="conv-nav-tooltip-sep"></div>
      <div id="conv-nav-tooltip-a"></div>
    </div>
    <div id="scroll-bottom-badge"></div>
  `;

  const messages = document.getElementById("messages");
  Object.defineProperty(messages, "clientHeight", { configurable: true, value: 400 });
  Object.defineProperty(messages, "scrollHeight", { configurable: true, value: 2000 });
  messages.scrollTop = 0;
  messages.scrollTo = ({ top }) => {
    messages.scrollTop = top;
  };

  const header = document.querySelector(".header");
  header.getBoundingClientRect = () => ({ bottom: 100 });

  return { messages, header, badge: document.getElementById("scroll-bottom-badge") };
}

function appendTurn(messages, userTop, assistantTop) {
  const user = document.createElement("div");
  user.className = "message user";
  user.innerHTML = '<div class="message-content">User</div>';
  user.getBoundingClientRect = () => ({ top: userTop });

  const assistant = document.createElement("div");
  assistant.className = "message assistant";
  assistant.innerHTML = '<div class="message-content">Assistant</div>';
  assistant.getBoundingClientRect = () => ({ top: assistantTop });

  messages.append(user, assistant);
}

describe("ConvNav", () => {
  it("rewires dot clicks after messages are re-rendered with the same turn count", () => {
    const { messages, header, badge } = setupDom();
    const nav = new ConvNav({ messagesEl: messages, headerEl: header, badgeEl: badge });

    appendTurn(messages, 120, 180);
    appendTurn(messages, 220, 280);
    nav.mount();

    messages.replaceChildren();
    appendTurn(messages, 420, 480);
    appendTurn(messages, 620, 680);
    nav.rebuild();

    document.querySelectorAll(".conv-nav-dot")[1].click();

    expect(messages.scrollTop).toBe(520);
    nav.destroy();
  });
});
