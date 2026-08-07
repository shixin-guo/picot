// @vitest-environment jsdom
// ABOUTME: Verifies the theme transition wrapper degrades safely without View Transitions
// ABOUTME: and forwards the click origin into the CSS custom properties when available.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, withViewTransition } from "./themes.js";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("--theme-transition-x");
  document.documentElement.style.removeProperty("--theme-transition-y");
});

describe("applyTheme", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("mutates data-theme for a known theme id", () => {
    applyTheme("terracotta");
    expect(document.documentElement.getAttribute("data-theme")).toBe("terracotta");
  });

  it("falls back to the default when the id is unknown, with no origin", () => {
    applyTheme("does-not-exist");
    expect(document.documentElement.getAttribute("data-theme")).toBe("night");
  });

  it("accepts an optional click origin without throwing when no transition API exists", () => {
    expect(() => applyTheme("terracotta", { origin: { x: 10, y: 20 } })).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("terracotta");
  });
});

describe("withViewTransition", () => {
  it("calls apply synchronously when document.startViewTransition is unavailable", () => {
    const apply = vi.fn();
    withViewTransition(apply, { x: 1, y: 2 });
    expect(apply).toHaveBeenCalledTimes(1);
    // No CSS origin properties are written in the fallback path.
    expect(document.documentElement.style.getPropertyValue("--theme-transition-x")).toBe("");
  });

  it("calls apply synchronously when reduced motion is requested", () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal("document", {
      ...document,
      documentElement: document.documentElement,
      startViewTransition,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const apply = vi.fn();
    withViewTransition(apply, { x: 5, y: 7 });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("sets CSS origin custom properties and routes through startViewTransition when available", () => {
    let captured;
    const startViewTransition = vi.fn((cb) => {
      captured = cb;
      return { finished: Promise.resolve() };
    });
    vi.stubGlobal("document", {
      ...document,
      documentElement: document.documentElement,
      startViewTransition,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, media: "", addEventListener: vi.fn() })),
    );
    const apply = vi.fn();
    withViewTransition(apply, { x: 42, y: 24 });
    expect(document.documentElement.style.getPropertyValue("--theme-transition-x")).toBe("42px");
    expect(document.documentElement.style.getPropertyValue("--theme-transition-y")).toBe("24px");
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    // The wrapped callback is invoked by the browser; call it to prove the
    // caller's apply runs inside the transition.
    expect(apply).not.toHaveBeenCalled();
    captured();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("uses a documented center fallback when no origin is supplied", () => {
    let captured;
    const startViewTransition = vi.fn((cb) => {
      captured = cb;
      return { finished: Promise.resolve() };
    });
    vi.stubGlobal("document", {
      ...document,
      documentElement: document.documentElement,
      startViewTransition,
    });
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, media: "", addEventListener: vi.fn() })),
    );
    withViewTransition(() => {});
    expect(document.documentElement.style.getPropertyValue("--theme-transition-x")).toBe("50%");
    expect(document.documentElement.style.getPropertyValue("--theme-transition-y")).toBe("50%");
    captured?.();
  });
});
