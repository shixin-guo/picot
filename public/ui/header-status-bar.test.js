// @vitest-environment jsdom
// ABOUTME: Pins the header session-aggregate lifecycle: aggregate totals only hydrate
// ABOUTME: from authoritative stats and live completions; current context is independent.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n } from "../i18n.js";
import { createHeaderStatusBar } from "./header-status-bar.js";

const enMessages = JSON.parse(readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"));

beforeEach(async () => {
  document.body.replaceChildren(
    Object.assign(document.createElement("span"), { id: "session-cost" }),
    Object.assign(document.createElement("span"), { id: "session-usage" }),
    Object.assign(document.createElement("span"), { id: "token-usage" }),
  );
  globalThis.fetch = vi.fn(async (input) => {
    if (String(input).includes("/locales/en.json")) {
      return new Response(JSON.stringify(enMessages));
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
  await initI18n();
});

afterEach(() => {
  document.body.replaceChildren();
});

function makeBar({ getContextWindowSize = () => 1000 } = {}) {
  return createHeaderStatusBar({
    sessionCostEl: document.getElementById("session-cost"),
    sessionUsageEl: document.getElementById("session-usage"),
    tokenUsageEl: document.getElementById("token-usage"),
    getContextWindowSize,
    t: (key, params) => {
      if (key === "usage.costSub") return `usage.costSub(${JSON.stringify(params)})`;
      if (key === "usage.summary") {
        return `In ${params?.in ?? 0} · Out ${params?.out ?? 0} · Cache ${params?.cache ?? 0}`;
      }
      return key;
    },
  });
}

describe("createHeaderStatusBar aggregate lifecycle", () => {
  it("starts empty and exposes the documented surface", () => {
    const bar = makeBar();
    expect(typeof bar.applyLiveUsage).toBe("function");
    expect(typeof bar.hydrateSessionStats).toBe("function");
    expect(typeof bar.reset).toBe("function");
    expect(typeof bar.sync).toBe("function");
    expect(document.getElementById("session-cost").textContent).toBe("");
    expect(document.getElementById("session-usage").textContent).toBe("");
  });

  it("hydrates aggregate totals once and never from history replay", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
      cost: { total: 0.02 },
    });
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
      cost: { total: 0.02 },
    });
    const usage = document.getElementById("session-usage").textContent;
    expect(usage).toContain("In 100");
    expect(usage).toContain("Out 50");
    expect(usage).toContain("Cache 30");
    expect(document.getElementById("session-cost").textContent).toContain("0.02");
  });

  it("accumulates only newly received live usage after hydration", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
      cost: { total: 0.02 },
    });
    expect(
      bar.applyLiveUsage(
        {
          input: 40,
          output: 20,
          cacheRead: 10,
          cacheWrite: 0,
          cost: { total: 0.01 },
        },
        { sessionFile: "/s/a.jsonl" },
      ),
    ).toBe(true);
    const usage = document.getElementById("session-usage").textContent;
    expect(usage).toContain("In 140");
    expect(usage).toContain("Out 70");
    expect(usage).toContain("Cache 40");
    expect(document.getElementById("session-cost").textContent).toContain("0.03");
  });

  it("formats large aggregates with K/M suffixes", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/big.jsonl",
      tokens: { input: 1_500_000, output: 250_000, cacheRead: 3_200_000 },
      cost: { total: 0.5 },
    });
    const usage = document.getElementById("session-usage").textContent;
    expect(usage).toContain("In 1.5M");
    expect(usage).toContain("Out 250K");
    expect(usage).toContain("Cache 3.2M");
  });

  it("clears both aggregate and current context on reset for a new session", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
      cost: { total: 0.02 },
    });
    bar.reset();
    expect(document.getElementById("session-usage").textContent).toBe("");
    expect(document.getElementById("session-cost").textContent).toBe("");
  });

  it("ignores live usage without a confirmed identity", () => {
    const bar = makeBar();
    expect(bar.applyLiveUsage({ input: 40, output: 20, cost: { total: 0.01 } })).toBe(false);
    expect(document.getElementById("session-usage").textContent).toBe("");

    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30 },
      cost: { total: 0.02 },
    });
    expect(
      bar.applyLiveUsage(
        { input: 40, output: 20, cost: { total: 0.01 } },
        { sessionFile: undefined },
      ),
    ).toBe(false);
    expect(document.getElementById("session-usage").textContent).toContain("In 100");
  });

  it("resets the aggregate to authoritative zero when tokens are null", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30 },
      cost: { total: 0.02 },
    });
    bar.hydrateSessionStats({ sessionFile: "/s/a.jsonl", tokens: null, cost: { total: 0 } });
    expect(document.getElementById("session-usage").textContent).toBe("");
    expect(document.getElementById("session-cost").textContent).toBe("");
  });

  it("ignores a live usage that belongs to a different session than the hydrated one", () => {
    const bar = makeBar();
    bar.hydrateSessionStats({
      sessionFile: "/s/a.jsonl",
      tokens: { input: 100, output: 50, cacheRead: 30, cacheWrite: 5, total: 185 },
      cost: { total: 0.02 },
    });
    bar.applyLiveUsage(
      { input: 40, output: 20, cacheRead: 10, cacheWrite: 0, cost: { total: 0.01 } },
      { sessionFile: "/s/other.jsonl" },
    );
    const usage = document.getElementById("session-usage").textContent;
    expect(usage).toContain("In 100");
    expect(usage).not.toContain("In 140");
  });

  it("renders current-context percentage with warning/critical thresholds and can clear it independently", () => {
    const bar = makeBar({ getContextWindowSize: () => 1000 });
    bar.sync({ currentUsage: { input: 650, cacheRead: 0 } });
    const usageEl = document.getElementById("token-usage");
    expect(usageEl.classList.contains("warning")).toBe(true);
    bar.sync({ currentUsage: { input: 850, cacheRead: 0 } });
    expect(usageEl.classList.contains("critical")).toBe(true);
    // Compact success clears current context without touching aggregate totals.
    bar.sync({ currentUsage: null });
    expect(usageEl.classList.contains("warning")).toBe(false);
    expect(usageEl.classList.contains("critical")).toBe(false);
  });

  it("does not add threshold classes when the context window is unknown", () => {
    const bar = makeBar({ getContextWindowSize: () => 0 });
    bar.sync({ currentUsage: { input: 99999, cacheRead: 0 } });
    const usageEl = document.getElementById("token-usage");
    expect(usageEl.classList.contains("warning")).toBe(false);
    expect(usageEl.classList.contains("critical")).toBe(false);
  });
});
