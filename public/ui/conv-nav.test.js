import { afterEach, describe, expect, it, vi } from "vitest";
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

function appendTurn(
  messages,
  userTop,
  assistantTop,
  { userText = "User", assistantText = "Assistant" } = {},
) {
  const user = document.createElement("div");
  user.className = "message user";
  user.innerHTML = `<div class="message-content">${userText}</div>`;
  user.getBoundingClientRect = () => ({ top: userTop });

  const assistant = document.createElement("div");
  assistant.className = "message assistant";
  assistant.innerHTML = `<div class="message-content">${assistantText}</div>`;
  assistant.getBoundingClientRect = () => ({ top: assistantTop });

  messages.append(user, assistant);
}

function layoutDots(track) {
  [...track.children].forEach((dot, i) => {
    const top = 100 + i * 24;
    dot.getBoundingClientRect = () => ({
      top,
      bottom: top + 8,
      height: 8,
      left: 200,
      right: 228,
      width: 28,
    });
  });
}

function hoverTrack(track, clientY) {
  track.dispatchEvent(new MouseEvent("mouseenter", { clientY, bubbles: false }));
  track.dispatchEvent(new MouseEvent("mousemove", { clientY, bubbles: true }));
}

describe("ConvNav", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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

  it("jumps to the nearest turn when a click lands in the inter-tick gap", () => {
    const { messages, header, badge } = setupDom();
    const nav = new ConvNav({ messagesEl: messages, headerEl: header, badgeEl: badge });

    appendTurn(messages, 120, 180);
    appendTurn(messages, 220, 280);
    appendTurn(messages, 320, 380);
    nav.mount();
    nav.rebuild();

    const track = document.getElementById("conv-nav-track");
    layoutDots(track);

    // clientY 141 sits in the gap between dot 1 (ends 132) and dot 2 (starts
    // 148), nearer to dot 2 (mid 152). The whole-rail delegation must still
    // jump to turn index 2 instead of doing nothing.
    track.dispatchEvent(new MouseEvent("click", { clientY: 141, bubbles: true }));

    expect(messages.scrollTop).toBe(220);
    nav.destroy();
  });

  it("notifies onJumpToEntry with the jumped turn's entry id", () => {
    const { messages, header, badge } = setupDom();
    appendTurn(messages, 120, 180);
    messages.querySelector(".message.user").dataset.entryId = "u-entry-1";
    appendTurn(messages, 220, 280);

    const seen = [];
    const nav = new ConvNav({
      messagesEl: messages,
      headerEl: header,
      badgeEl: badge,
      onJumpToEntry: (entryId) => seen.push(entryId),
    });
    nav.mount();
    nav.rebuild();

    document.querySelectorAll(".conv-nav-dot")[0].click();

    // v3 parity: a jump syncs the Info panel's session-history selection.
    expect(seen).toEqual(["u-entry-1"]);
    nav.destroy();
  });

  it("keeps the tooltip visible while the pointer moves across the track", () => {
    const { messages, header, badge } = setupDom();
    const nav = new ConvNav({ messagesEl: messages, headerEl: header, badgeEl: badge });

    appendTurn(messages, 120, 180, { userText: "First prompt" });
    appendTurn(messages, 220, 280, { userText: "Second prompt" });
    nav.mount();

    const track = document.getElementById("conv-nav-track");
    const tooltip = document.getElementById("conv-nav-tooltip");
    layoutDots(track);

    hoverTrack(track, 104);
    expect(tooltip.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("conv-nav-tooltip-q").textContent).toContain("First prompt");

    tooltip.classList.remove("animating");
    track.dispatchEvent(new MouseEvent("mousemove", { clientY: 112, bubbles: true }));
    track.dispatchEvent(new MouseEvent("mousemove", { clientY: 128, bubbles: true }));

    expect(tooltip.classList.contains("hidden")).toBe(false);
    expect(tooltip.classList.contains("animating")).toBe(false);
    expect(document.getElementById("conv-nav-tooltip-q").textContent).toContain("Second prompt");

    nav.destroy();
  });

  it("hides the tooltip only after the pointer leaves the track", () => {
    vi.useFakeTimers();
    const { messages, header, badge } = setupDom();
    const nav = new ConvNav({ messagesEl: messages, headerEl: header, badgeEl: badge });

    appendTurn(messages, 120, 180, { userText: "First prompt" });
    appendTurn(messages, 220, 280, { userText: "Second prompt" });
    nav.mount();

    const track = document.getElementById("conv-nav-track");
    const tooltip = document.getElementById("conv-nav-tooltip");
    layoutDots(track);

    hoverTrack(track, 104);
    expect(tooltip.classList.contains("hidden")).toBe(false);

    track.dispatchEvent(
      new MouseEvent("mouseleave", { clientY: 104, bubbles: false, relatedTarget: document.body }),
    );
    expect(tooltip.classList.contains("hidden")).toBe(false);

    vi.advanceTimersByTime(120);
    expect(tooltip.classList.contains("hidden")).toBe(true);

    nav.destroy();
  });
});
