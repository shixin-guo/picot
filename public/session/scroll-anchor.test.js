import { describe, expect, test, vi } from "vitest";
import { anchorHistoryToBottom } from "./scroll-anchor.js";

describe("anchorHistoryToBottom", () => {
  test("re-anchors to latest scrollHeight across delayed layout shifts", () => {
    const messagesEl = {
      scrollTop: 0,
      scrollHeight: 120,
      style: { scrollBehavior: "smooth" },
    };

    const timeouts = [];
    const requestAnimationFrame = vi.fn((cb) => {
      cb();
      return 1;
    });
    const setTimeoutFn = vi.fn((cb, ms) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    });

    anchorHistoryToBottom(messagesEl, {
      requestAnimationFrame,
      setTimeout: setTimeoutFn,
      settleDelayMs: 80,
      settlePasses: 2,
    });

    // immediate anchor
    expect(messagesEl.scrollTop).toBe(120);
    expect(messagesEl.style.scrollBehavior).toBe("");

    // first layout shift before first timeout flushes
    messagesEl.scrollHeight = 380;
    timeouts[0].cb();
    expect(messagesEl.scrollTop).toBe(380);

    // second layout shift before second timeout flushes
    messagesEl.scrollHeight = 620;
    timeouts[1].cb();
    expect(messagesEl.scrollTop).toBe(620);
  });

  test("skips bottom anchoring when preserving a search-target scroll position", () => {
    const messagesEl = {
      scrollTop: 240,
      scrollHeight: 620,
      style: { scrollBehavior: "smooth" },
    };

    const requestAnimationFrame = vi.fn((cb) => {
      cb();
      return 1;
    });
    const setTimeoutFn = vi.fn();

    anchorHistoryToBottom(messagesEl, {
      requestAnimationFrame,
      setTimeout: setTimeoutFn,
      preserveScrollTarget: true,
    });

    expect(messagesEl.scrollTop).toBe(240);
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(messagesEl.style.scrollBehavior).toBe("smooth");
  });
});
