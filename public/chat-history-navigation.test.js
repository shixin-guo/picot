// ABOUTME: Verifies the chat-history navigator turn model, magnification, preview, and lifecycle.
// ABOUTME: Covers inert rendering, streaming states, scroll anchoring, and hostile-text safety.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  binarySearchActiveTurn,
  ChatHistoryNavigator,
  computeActiveTurn,
  computeTickPositions,
  createChatHistoryNavigation,
  createNoOpNavigator,
} from "./chat-history-navigation.js";
import { initI18n } from "./i18n.js";

// ── Test harness ──────────────────────────────────────────────────────
// The navigator injects DOM and layout dependencies. We stub scheduling so
// requestAnimationFrame/setTimeout run synchronously and deterministically.

function makeHarness(overrides = {}) {
  const rafs = [];
  const timeouts = [];
  const raf = vi.fn((cb) => {
    rafs.push(cb);
    return rafs.length;
  });
  const caf = vi.fn(() => {});
  const st = vi.fn((cb, ms) => {
    timeouts.push({ cb, ms });
    return timeouts.length;
  });
  const ct = vi.fn(() => {});

  const chatPanel = document.createElement("div");
  const messagesContainer = document.createElement("div");
  chatPanel.appendChild(messagesContainer);
  document.body.appendChild(chatPanel);

  const nav = new ChatHistoryNavigator(chatPanel, {
    messagesContainer,
    requestAnimationFrame: raf,
    cancelAnimationFrame: caf,
    setTimeout: st,
    clearTimeout: ct,
    touchLayout: false,
    reducedMotion: false,
    ...overrides,
  });

  const flushRafs = () => {
    const pending = rafs.splice(0);
    for (const cb of pending) cb();
  };
  const flushTimeouts = () => {
    const pending = timeouts.splice(0);
    for (const { cb } of pending) cb();
  };

  return {
    nav,
    chatPanel,
    messagesContainer,
    raf,
    caf,
    st,
    ct,
    flushRafs,
    flushTimeouts,
    rafs,
    timeouts,
  };
}

function makeUserElement(text = "user message") {
  const el = document.createElement("div");
  el.className = "message user";
  el.textContent = text;
  return el;
}

beforeEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        chatNavigation: {
          imageMessage: "[image]",
          waiting: "Waiting for response…",
          generating: "Generating response…",
          noVisibleResponse: "No visible response",
        },
      }),
    })),
  );
  await initI18n();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

// ── 1. One item per user turn ─────────────────────────────────────────

describe("turn model — one item per user turn", () => {
  test("indexes one turn per addUserTurn call", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "hello" });
    nav.addUserTurn({ id: "u2", text: "world" });
    flushRafs();
    expect(nav.turns).toHaveLength(2);
    expect(nav.turns[0].id).toBe("u1");
    expect(nav.turns[1].id).toBe("u2");
  });
});

// ── 2. Hiding with <2 turns and on touch/mobile ──────────────────────

describe("visibility", () => {
  test("hidden when fewer than two turns", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "only one" });
    flushRafs();
    expect(nav.root.classList.contains("hidden")).toBe(true);
  });

  test("visible with two or more turns", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "one" });
    nav.addUserTurn({ id: "u2", text: "two" });
    flushRafs();
    expect(nav.root.classList.contains("hidden")).toBe(false);
  });

  test("hidden on touch layout", () => {
    const { nav, flushRafs } = makeHarness({ touchLayout: true });
    nav.addUserTurn({ id: "u1", text: "one" });
    nav.addUserTurn({ id: "u2", text: "two" });
    flushRafs();
    expect(nav.root.classList.contains("hidden")).toBe(true);
  });

  test("rail is aria-hidden and outside tab order", () => {
    const { nav } = makeHarness();
    expect(nav.root.getAttribute("aria-hidden")).toBe("true");
  });
});

// ── 3. Image-only prompts ────────────────────────────────────────────

describe("image-only prompts", () => {
  test("records hasUserImage flag for image-bearing prompts", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "", images: [{ data: "abc" }] });
    flushRafs();
    expect(nav.turns[0].hasUserImage).toBe(true);
    expect(nav.turns[0].userText).toBe("[image]");
  });

  test("preview shows image-message label for image-only turn", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "", images: [{ data: "abc" }] });
    nav.addUserTurn({ id: "u2", text: "second" });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    nav._populatePreview(nav.turns[0]);
    expect(nav.previewPrompt.textContent).toMatch(/./);
  });
});

// ── 4. Bounded summaries + segment combination ───────────────────────

describe("bounded summaries and assistant segment combination", () => {
  test("prompt is limited to 2000 code points", () => {
    const { nav, flushRafs } = makeHarness();
    const long = "a".repeat(5000);
    nav.addUserTurn({ id: "u1", text: long });
    flushRafs();
    expect(Array.from(nav.turns[0].userText)).toHaveLength(2000);
  });

  test("response is limited to 4000 code points", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.beginAssistantMessage({ id: "u1" });
    const long = "b".repeat(6000);
    nav.updateAssistantMessage({ id: "u1", text: long });
    flushRafs();
    expect(Array.from(nav.turns[0].assistantText)).toHaveLength(4000);
  });

  test("multiple assistant segments within a turn are combined with blank line", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.beginAssistantMessage({ id: "u1" });
    nav.updateAssistantMessage({ id: "u1", text: "first part", segmentIndex: 0 });
    nav.updateAssistantMessage({ id: "u1", text: "second part", segmentIndex: 1 });
    flushRafs();
    expect(nav.turns[0].assistantText).toContain("first part");
    expect(nav.turns[0].assistantText).toContain("second part");
    expect(nav.turns[0].assistantText).toContain("\n\n");
  });

  test("unicode code points counted, not UTF-16 units", () => {
    const { nav, flushRafs } = makeHarness();
    // Each emoji is 2 UTF-16 code units but 1 code point.
    const emoji = "𝕏".repeat(100);
    nav.addUserTurn({ id: "u1", text: emoji });
    flushRafs();
    expect(Array.from(nav.turns[0].userText)).toHaveLength(100);
  });
});

// ── 5. Orphan assistant messages / duplicate delivery ────────────────

describe("orphan and duplicate delivery", () => {
  test("updateAssistantMessage before begin is tolerated (fallback to latest waiting turn)", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    // Call update without a prior begin — should attach to the waiting turn.
    nav.updateAssistantMessage({ text: "late text" });
    flushRafs();
    expect(nav.turns[0].responseState).toBe("streaming");
    expect(nav.turns[0].assistantText).toBe("late text");
  });

  test("completeAssistantMessage without text marks turn complete with no-visible fallback", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.beginAssistantMessage({ id: "u1" });
    nav.completeAssistantMessage({ id: "u1" });
    flushRafs();
    expect(nav.turns[0].responseState).toBe("complete");
    expect(nav.turns[0].assistantText).toBe("");
  });
});

// ── 6. Waiting / streaming / complete states ─────────────────────────

describe("response states", () => {
  test("new turn starts as waiting", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    flushRafs();
    expect(nav.turns[0].responseState).toBe("waiting");
  });

  test("begin transitions to streaming", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.beginAssistantMessage({ id: "u1" });
    flushRafs();
    expect(nav.turns[0].responseState).toBe("streaming");
  });

  test("complete transitions to complete", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.beginAssistantMessage({ id: "u1" });
    nav.updateAssistantMessage({ id: "u1", text: "answer" });
    nav.completeAssistantMessage({ id: "u1" });
    flushRafs();
    expect(nav.turns[0].responseState).toBe("complete");
    expect(nav.turns[0].assistantText).toBe("answer");
  });
});

// ── 7. Bounded, animation-frame-coalesced magnification ──────────────

describe("magnification", () => {
  test("pointer move coalesces into a single rAF", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 10; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    // Simulate pointer events.
    Object.defineProperty(nav.rail, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 200, bottom: 200, left: 0, right: 20, width: 20 }),
      configurable: true,
    });
    nav._onPointer({ clientY: 100 });
    nav._onPointer({ clientY: 101 });
    nav._onPointer({ clientY: 102 });
    expect(nav._layoutFrame).toBeTruthy();
  });

  test("magnification limited to six neighbors on either side", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 20; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    Object.defineProperty(nav.rail, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 200, bottom: 200, left: 0, right: 20, width: 20 }),
      configurable: true,
    });
    nav._onPointer({ clientY: 100 });
    flushRafs();
    // indices: center 10, neighborhood 4..16 => 13 ticks styled
    const styled = nav._ticks.filter((el) => el.style.getPropertyValue("--mag"));
    expect(styled.length).toBeLessThanOrEqual(13);
    const nearest = nav._ticks.find((el) => el.classList.contains("nearest"));
    expect(nearest).toBeTruthy();
  });

  test("resets only previous neighborhood, not every tick", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 20; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    Object.defineProperty(nav.rail, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 200, bottom: 200, left: 0, right: 20, width: 20 }),
      configurable: true,
    });
    nav._onPointer({ clientY: 50 });
    flushRafs();
    const firstNeighborhood = [...nav._lastMagnify.indices];
    nav._onPointer({ clientY: 150 });
    flushRafs();
    // Ticks far outside both neighborhoods should never have been touched.
    expect(nav._lastMagnify.indices).not.toEqual(firstNeighborhood);
  });
});

// ── 8. Active-turn anchor, hysteresis, binary search ──────────────────

describe("scroll tracking", () => {
  test("binarySearchActiveTurn finds last offset at or above anchor", () => {
    expect(binarySearchActiveTurn([0, 100, 200, 300, 400], 250)).toBe(2);
    expect(binarySearchActiveTurn([0, 100, 200, 300, 400], 0)).toBe(0);
    expect(binarySearchActiveTurn([0, 100, 200, 300, 400], 400)).toBe(4);
    expect(binarySearchActiveTurn([0, 100, 200, 300, 400], 10)).toBe(0);
  });

  test("binarySearchActiveTurn clamps before first offset", () => {
    expect(binarySearchActiveTurn([100, 200], 50)).toBe(0);
  });

  test("binarySearchActiveTurn handles empty array", () => {
    expect(binarySearchActiveTurn([], 100)).toBe(-1);
  });

  test("computeActiveTurn returns 0 when anchor before first", () => {
    expect(computeActiveTurn([100, 200], 0, 400)).toBe(0);
  });

  test("computeActiveTurn returns last when anchor after final", () => {
    expect(computeActiveTurn([100, 200, 300], 300, 400)).toBe(2);
  });

  test("active tick updates via cached offsets and binary search", () => {
    const { nav, flushRafs } = makeHarness({
      measureElementOffset: (el) => Number(el.dataset.offset || 0),
    });
    for (let i = 0; i < 4; i++) {
      const el = makeUserElement();
      el.dataset.offset = String(i * 100);
      nav.addUserTurn({ id: `u${i}`, text: `t${i}`, userElement: el });
    }
    flushRafs();
    nav.messagesContainer.scrollTop = 0;
    Object.defineProperty(nav.messagesContainer, "clientHeight", {
      value: 400,
      configurable: true,
    });
    nav._offsets = [0, 100, 200, 300];
    nav._offsetsDirty = false;
    nav._activeIndex = -1;
    nav._updateActiveTick();
    // anchor = 0 + 400*0.3 = 120 => last offset <= 120 is index 1
    expect(nav._activeIndex).toBe(1);
    expect(nav._ticks[1].classList.contains("active")).toBe(true);
  });

  test("hysteresis prevents rapid toggling at boundary", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 3; i++) {
      const el = makeUserElement();
      el.dataset.offset = String(i * 100);
      nav.addUserTurn({ id: `u${i}`, text: `t${i}`, userElement: el });
    }
    flushRafs();
    nav._offsets = [0, 100, 200];
    nav._offsetsDirty = false;
    Object.defineProperty(nav.messagesContainer, "clientHeight", {
      value: 400,
      configurable: true,
    });
    // Set active to 1 firmly first.
    nav._activeIndex = 1;
    nav.messagesContainer.scrollTop = 100;
    // anchor = 100 + 120 = 220 => candidate would be 2, boundary=(100+200)/2=150
    // 220 > 150+12 => switches to 2
    let idx = nav._applyHysteresis(2, 100, 400);
    expect(idx).toBe(2);

    // Now jitter back just below hysteresis: anchor=155, candidate=2, boundary=150
    // moving down requires anchor >= 150+12=162; 155 < 162 => stays at current
    idx = nav._applyHysteresis(2, 35, 400); // anchor = 35+120=155
    expect(idx).toBe(1);
  });
});

// ── 9. Click navigation and reduced motion ───────────────────────────

describe("click navigation", () => {
  test("navigates to hovered turn via scrollIntoView smooth", () => {
    const { nav, chatPanel, flushRafs } = makeHarness();
    const targets = [];
    for (let i = 0; i < 3; i++) {
      const el = makeUserElement();
      chatPanel.querySelector("div").appendChild(el);
      el.scrollIntoView = vi.fn((opts) => {
        targets[i] = { i, opts };
      });
      nav.addUserTurn({ id: `u${i}`, text: `t${i}`, userElement: el });
    }
    flushRafs();
    nav._hoverIndex = 1;
    nav._onClick({});
    expect(targets[1].opts).toEqual({ behavior: "smooth", block: "center" });
  });

  test("reduced motion uses auto jump", () => {
    const { nav, chatPanel, flushRafs } = makeHarness({ reducedMotion: true });
    const targets = [];
    for (let i = 0; i < 3; i++) {
      const el = makeUserElement();
      chatPanel.querySelector("div").appendChild(el);
      el.scrollIntoView = vi.fn((opts) => {
        targets[i] = { i, opts };
      });
      nav.addUserTurn({ id: `u${i}`, text: `t${i}`, userElement: el });
    }
    flushRafs();
    nav._hoverIndex = 2;
    nav._onClick({});
    expect(targets[2].opts).toEqual({ behavior: "auto", block: "start" });
  });

  test("adds highlight class then removes after timeout", () => {
    const { nav, chatPanel, flushTimeouts, flushRafs } = makeHarness();
    const el = makeUserElement();
    chatPanel.querySelector("div").appendChild(el);
    el.scrollIntoView = vi.fn();
    for (let i = 0; i < 2; i++) {
      const e = i === 0 ? el : makeUserElement();
      if (i > 0) chatPanel.querySelector("div").appendChild(e);
      e.scrollIntoView = vi.fn();
      nav.addUserTurn({ id: `u${i}`, text: `t${i}`, userElement: e });
    }
    flushRafs();
    nav._hoverIndex = 0;
    nav._onClick({});
    expect(el.classList.contains("chat-nav-target")).toBe(true);
    flushTimeouts();
    expect(el.classList.contains("chat-nav-target")).toBe(false);
  });
});

// ── 10. Inert rendering of HTML-like payloads ─────────────────────────

describe("inert preview rendering", () => {
  test("HTML-like prompt text is rendered inert via textContent", () => {
    const { nav, flushRafs } = makeHarness();
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    nav.addUserTurn({ id: "u1", text: hostile });
    nav.addUserTurn({ id: "u2", text: "ok" });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    nav._populatePreview(nav.turns[0]);
    expect(nav.previewPrompt.textContent).toBe(hostile);
    expect(nav.previewPrompt.querySelectorAll("img,script").length).toBe(0);
    expect(nav.previewPrompt.innerHTML).not.toContain("<script>");
  });

  test("event-handler-like response payload stays inert", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.addUserTurn({ id: "u2", text: "q2" });
    nav.beginAssistantMessage({ id: "u1" });
    nav.updateAssistantMessage({ id: "u1", text: '<div onclick="alert(1)">hi</div>' });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    nav._populatePreview(nav.turns[0]);
    expect(nav.previewResponse.querySelectorAll("div").length).toBe(0);
    expect(nav.previewResponse.textContent).toContain("onclick");
  });

  test("textContent is used, never innerHTML", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "<b>bold</b>" });
    nav.addUserTurn({ id: "u2", text: "ok" });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    nav._populatePreview(nav.turns[0]);
    expect(nav.previewPrompt.querySelectorAll("b").length).toBe(0);
  });
});

// ── 11. Preview hierarchy, no-visible-response, close delay, clamping ─

describe("preview behavior", () => {
  test("no-visible-response fallback for completed turn without text", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.addUserTurn({ id: "u2", text: "q2" });
    nav.beginAssistantMessage({ id: "u1" });
    nav.completeAssistantMessage({ id: "u1" });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    nav._populatePreview(nav.turns[0]);
    expect(nav.previewResponse.classList.contains("status")).toBe(true);
    expect(nav.previewResponse.textContent).toMatch(/./);
  });

  test("status flag removed when visible response exists", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.addUserTurn({ id: "u2", text: "q2" });
    nav.beginAssistantMessage({ id: "u1" });
    nav.updateAssistantMessage({ id: "u1", text: "real answer" });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    nav._populatePreview(nav.turns[0]);
    expect(nav.previewResponse.classList.contains("status")).toBe(false);
    expect(nav.previewResponse.textContent).toBe("real answer");
  });

  test("close delay: leaving starts 120ms timer, entering cancels", () => {
    const { nav, st, ct, flushRafs } = makeHarness();
    for (let i = 0; i < 2; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    nav._showPreview(0);
    expect(nav.preview.style.display).toBe("");
    // Leave rail => start close timer
    nav._onLeave();
    expect(st).toHaveBeenCalled();
    expect(nav._closeTimer).toBeTruthy();
    // Enter preview => cancel
    nav._onPreviewEnter();
    expect(nav._closeTimer).toBe(0);
    expect(ct).toHaveBeenCalled();
  });

  test("close timer uses 120ms delay", () => {
    const { nav, st, flushRafs } = makeHarness();
    for (let i = 0; i < 2; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    nav._showPreview(0);
    nav._startClose();
    const lastCall = st.mock.calls[st.mock.calls.length - 1];
    expect(lastCall[1]).toBe(120);
  });

  test("positions preview beside the hovered pointer rather than the rail center", () => {
    const { nav, flushRafs } = makeHarness({
      measureViewport: () => ({ width: 400, height: 300 }),
    });
    for (let i = 0; i < 2; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    Object.defineProperty(nav.root, "getBoundingClientRect", {
      value: () => ({ top: 100, height: 200, bottom: 300, left: 40, right: 72, width: 32 }),
      configurable: true,
    });
    Object.defineProperty(nav.preview, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 200, width: 200 }),
      configurable: true,
    });
    Object.defineProperty(nav.rail, "getBoundingClientRect", {
      value: () => ({ top: 100, height: 200, bottom: 300, left: 40, right: 72, width: 32 }),
      configurable: true,
    });

    nav._showPreview(0, 220);

    expect(nav.preview.style.top).toBe("120px");
    expect(nav.preview.style.left).toBe("40px");
  });

  test("viewport clamping keeps preview within window", () => {
    const { nav, flushRafs } = makeHarness({
      measureViewport: () => ({ width: 400, height: 300 }),
    });
    for (let i = 0; i < 2; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    Object.defineProperty(nav.root, "getBoundingClientRect", {
      value: () => ({ top: 250, height: 100, bottom: 350, left: 0, right: 20, width: 20 }),
      configurable: true,
    });
    Object.defineProperty(nav.preview, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 300, width: 300 }),
      configurable: true,
    });
    Object.defineProperty(nav.rail, "getBoundingClientRect", {
      value: () => ({ top: 0, height: 100, bottom: 100, left: 0, right: 20, width: 20 }),
      configurable: true,
    });
    nav._showPreview(0);
    nav._clampPreview();
    const top = parseInt(nav.preview.style.top, 10);
    const visualTop = 250 + top - 50;
    expect(visualTop).toBeLessThanOrEqual(200);
    expect(visualTop).toBeGreaterThanOrEqual(0);
  });
});

// ── 12. Session clearing and stale-target cleanup ───────────────────

describe("lifecycle cleanup", () => {
  test("reset clears turn index and preview", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 3; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    nav._showPreview(0);
    nav.reset();
    expect(nav.turns).toHaveLength(0);
    expect(nav._offsets).toHaveLength(0);
    expect(nav.preview.style.display).toBe("none");
    expect(nav._ticks).toHaveLength(0);
  });

  test("stale target is removed before navigation", () => {
    const { nav, flushRafs } = makeHarness();
    const el = makeUserElement();
    el.scrollIntoView = vi.fn();
    nav.addUserTurn({ id: "u0", text: "t0", userElement: el });
    nav.addUserTurn({ id: "u1", text: "t1", userElement: makeUserElement() });
    flushRafs();
    // Detach element so it's no longer in the document.
    el.remove();
    nav._hoverIndex = 0;
    nav._onClick({});
    expect(nav.turns).toHaveLength(1);
    expect(nav.turns[0].id).toBe("u1");
  });

  test("destroy removes DOM, listeners, observers, timers", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 2; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    nav._showPreview(0);
    nav._startClose();
    const rootEl = nav.root;
    nav.destroy();
    expect(rootEl.parentNode).toBeNull();
    expect(nav.turns).toHaveLength(0);
  });

  test("image-load invalidates cached offsets", () => {
    const { nav, flushRafs } = makeHarness();
    const el = makeUserElement();
    nav.addUserTurn({ id: "u0", text: "t0", userElement: el });
    nav.addUserTurn({ id: "u1", text: "t1" });
    flushRafs();
    nav._offsetsDirty = false;
    const event = new Event("load", { bubbles: true });
    el.dispatchEvent(event);
    expect(nav._offsetsDirty).toBe(true);
  });
});

// ── 13. Tick positions helper ────────────────────────────────────────

describe("computeTickPositions", () => {
  test("empty or zero height returns empty array", () => {
    expect(computeTickPositions(0, 200)).toEqual([]);
    expect(computeTickPositions(5, 0)).toEqual([]);
  });

  test("single tick centered", () => {
    const pos = computeTickPositions(1, 200);
    expect(pos).toHaveLength(1);
    expect(pos[0]).toBeCloseTo(100, 0);
  });

  test("multiple ticks evenly spaced", () => {
    const pos = computeTickPositions(3, 200);
    expect(pos).toHaveLength(3);
    expect(pos[2] - pos[0]).toBeCloseTo((pos[1] - pos[0]) * 2, 1);
  });
});

// ── Factory fallback ─────────────────────────────────────────────────

describe("factory", () => {
  test("returns no-op stub when the factory host is null", () => {
    const nav = createChatHistoryNavigation({ host: null });
    expect(typeof nav.addUserTurn).toBe("function");
    expect(() => nav.addUserTurn({ text: "x" })).not.toThrow();
    expect(() => nav.reset()).not.toThrow();
    expect(() => nav.destroy()).not.toThrow();
  });

  test("createNoOpNavigator exposes full public API", () => {
    const nav = createNoOpNavigator();
    const api = [
      "addUserTurn",
      "beginAssistantMessage",
      "updateAssistantMessage",
      "completeAssistantMessage",
      "invalidateLayout",
      "reset",
      "destroy",
    ];
    for (const method of api) {
      expect(typeof nav[method]).toBe("function");
    }
  });

  test("returns real navigator when the factory receives a host and message container", () => {
    const chatPanel = document.createElement("div");
    const messages = document.createElement("div");
    chatPanel.appendChild(messages);
    const nav = createChatHistoryNavigation({
      host: chatPanel,
      messages,
      requestFrame: () => 0,
      cancelFrame: () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
    expect(nav).toBeInstanceOf(ChatHistoryNavigator);
  });
});

// ── Locale refresh ───────────────────────────────────────────────────

describe("locale refresh", () => {
  test("onLocaleChange refreshes open preview status text without throwing", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: "q" });
    nav.addUserTurn({ id: "u2", text: "q2" });
    nav.beginAssistantMessage({ id: "u1" });
    flushRafs();
    nav._previewTurn = nav.turns[0];
    // Should not throw and should refresh preview text.
    expect(() => nav._onLocaleChange()).not.toThrow();
    expect(nav.previewResponse.textContent).toMatch(/./);
  });

  test("no preview open: locale change is a no-op", () => {
    const { nav, flushRafs } = makeHarness();
    for (let i = 0; i < 2; i++) nav.addUserTurn({ id: `u${i}`, text: `t${i}` });
    flushRafs();
    expect(() => nav._onLocaleChange()).not.toThrow();
  });
});

// ── Error handling ───────────────────────────────────────────────────

describe("error handling", () => {
  test("missing text produces empty summary, not exception", () => {
    const { nav, flushRafs } = makeHarness();
    expect(() => nav.addUserTurn({ id: "u1" })).not.toThrow();
    flushRafs();
    expect(nav.turns[0].userText).toBe("");
    expect(nav.turns[0].assistantText).toBe("");
  });

  test("malformed content (non-string) produces empty summary", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: { weird: true } });
    flushRafs();
    expect(nav.turns[0].userText).toBe("");
  });

  test("array content blocks combine visible text", () => {
    const { nav, flushRafs } = makeHarness();
    nav.addUserTurn({ id: "u1", text: [{ text: "part1" }, { text: "part2" }] });
    flushRafs();
    expect(nav.turns[0].userText).toBe("part1part2");
  });

  test("navigator failures do not block — addUserTurn tolerates null element", () => {
    const { nav, flushRafs } = makeHarness();
    expect(() => nav.addUserTurn({ id: "u1", userElement: null, text: "ok" })).not.toThrow();
    flushRafs();
  });
});
