import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, t } from "../../i18n.js";
import englishMessages from "../../locales/en.json";
import { buildMarkdownReport, setupTaskDebuggerPanel } from "./task-debugger-panel.js";
import { analyzeTurns } from "./turn-analysis.js";
import { createTurnTraceRecorder } from "./turn-trace.js";

function mountDom() {
  document.body.innerHTML = `
    <button id="btn" class="hidden"></button>
    <div id="overlay" class="hidden"></div>
    <div id="dialog" class="hidden"></div>
    <div id="body"></div>
    <button id="close"></button>
    <button id="copy">Copy report</button>
    <input type="radio" name="scope" value="last" checked />
    <input type="radio" name="scope" value="session" />
  `;
  return {
    button: document.getElementById("btn"),
    overlay: document.getElementById("overlay"),
    dialog: document.getElementById("dialog"),
    body: document.getElementById("body"),
    closeButton: document.getElementById("close"),
    copyButton: document.getElementById("copy"),
    scopeInputs: document.querySelectorAll('input[name="scope"]'),
  };
}

function step(kind, label, startedAt, durationMs, extra = {}) {
  return {
    kind,
    label,
    detail: extra.detail ?? "",
    signature: extra.signature ?? `${label}|{}`,
    toolCallId: null,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    status: extra.status ?? "ok",
    error: extra.error ?? null,
    stopReason: null,
  };
}

function turn(index, status, steps, { startedAt = 0, endedAt = 10_000, error = null } = {}) {
  return {
    id: `turn-${index}`,
    index,
    prompt: "build it",
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    status,
    error,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
    steps,
  };
}

describe("task debugger panel", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => englishMessages }),
    );
    await initI18n();
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("is visible and usable even before anything is recorded", () => {
    const dom = mountDom();
    // A control that only appears once its precondition holds is undiscoverable,
    // so the button shows from the start and explains itself when opened.
    const panel = setupTaskDebuggerPanel({ ...dom, getTurns: () => [], t });

    expect(dom.button.classList.contains("hidden")).toBe(false);
    expect(dom.button.disabled).toBe(false);

    panel.open();
    expect(dom.body.textContent).toContain("No task has been recorded yet");
  });

  it("disables itself again while the next turn streams", () => {
    const dom = mountDom();
    const panel = setupTaskDebuggerPanel({
      ...dom,
      getTurns: () => [turn(1, "completed", [])],
      t,
    });
    panel.open();
    expect(dom.dialog.classList.contains("hidden")).toBe(false);

    panel.setStreaming(true);
    expect(dom.button.disabled).toBe(true);
    expect(dom.dialog.classList.contains("hidden")).toBe(true);
  });

  it("renders the verdict, findings and slowest steps for the last turn", () => {
    const dom = mountDom();
    setupTaskDebuggerPanel({
      ...dom,
      getTurns: () => [
        turn(
          1,
          "failed",
          [
            step("tool", "bash", 0, 40_000, {
              detail: "bun test",
              status: "error",
              error: "exit 1",
            }),
          ],
          { error: "task failed" },
        ),
      ],
      t,
    }).open();

    const text = dom.body.textContent;
    expect(text).toContain("Failed");
    expect(text).toContain("bun test");
    expect(text).toContain("exit 1");
    expect(dom.body.querySelector(".task-debugger-finding--critical")).toBeTruthy();
    expect(dom.body.querySelectorAll(".task-debugger-step").length).toBeGreaterThan(0);
  });

  it("analyses only the last turn by default and the whole session on demand", () => {
    const dom = mountDom();
    const turns = [
      turn(1, "completed", [step("tool", "grep", 0, 100)], { startedAt: 0, endedAt: 1_000 }),
      turn(2, "completed", [step("tool", "bash", 5_000, 100)], {
        startedAt: 5_000,
        endedAt: 6_000,
      }),
    ];
    const analyze = vi.fn(analyzeTurns);
    const panel = setupTaskDebuggerPanel({ ...dom, getTurns: () => turns, analyze, t });

    panel.open();
    expect(analyze.mock.calls[0][0]).toEqual([turns[1]]);

    const sessionScope = [...dom.scopeInputs][1];
    sessionScope.checked = true;
    sessionScope.dispatchEvent(new Event("change"));
    expect(analyze.mock.calls[1][0]).toEqual(turns);
  });

  it("skips a still-running turn when picking the last finished one", () => {
    const dom = mountDom();
    const turns = [turn(1, "completed", []), turn(2, "running", [])];
    const analyze = vi.fn(analyzeTurns);
    setupTaskDebuggerPanel({ ...dom, getTurns: () => turns, analyze, t }).open();
    expect(analyze.mock.calls[0][0]).toEqual([turns[0]]);
  });

  it("offers nothing to copy when there is no report", () => {
    const dom = mountDom();
    setupTaskDebuggerPanel({ ...dom, getTurns: () => [], t }).open();
    expect(dom.copyButton.disabled).toBe(true);
  });

  it("stays clickable while only an unfinished turn exists", () => {
    const dom = mountDom();
    const panel = setupTaskDebuggerPanel({
      ...dom,
      getTurns: () => [turn(1, "running", [])],
      t,
    });
    expect(dom.button.disabled).toBe(false);

    // Streaming is reported by the app, not inferred from turn status.
    panel.setStreaming(true);
    expect(dom.button.disabled).toBe(true);
    panel.setStreaming(false);
    expect(dom.button.disabled).toBe(false);
  });

  it("closes on the overlay and the close button", () => {
    const dom = mountDom();
    const panel = setupTaskDebuggerPanel({
      ...dom,
      getTurns: () => [turn(1, "completed", [])],
      t,
    });
    panel.open();
    dom.overlay.dispatchEvent(new Event("click"));
    expect(dom.dialog.classList.contains("hidden")).toBe(true);

    panel.open();
    dom.closeButton.dispatchEvent(new Event("click"));
    expect(dom.dialog.classList.contains("hidden")).toBe(true);
  });

  it("copies a Markdown report to the clipboard", async () => {
    const dom = mountDom();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setupTaskDebuggerPanel({
      ...dom,
      getTurns: () => [turn(1, "completed", [step("tool", "bash", 0, 500, { detail: "ls" })])],
      t,
      writeText,
    }).open();

    dom.copyButton.dispatchEvent(new Event("click"));
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("# Task analysis");
  });

  it("returns inert handles when the markup is missing", () => {
    const panel = setupTaskDebuggerPanel({ getTurns: () => [] });
    expect(() => {
      panel.open();
      panel.close();
      panel.setStreaming(true);
      panel.refreshAvailability();
    }).not.toThrow();
  });
});

describe("buildMarkdownReport", () => {
  it("lists the status, the time split and every failure", () => {
    const report = analyzeTurns([
      turn(1, "failed", [step("tool", "bash", 0, 1_000, { status: "error", error: "exit 1" })], {
        error: "task failed",
      }),
    ]);
    const markdown = buildMarkdownReport(report, t);
    expect(markdown).toContain("# Task analysis");
    expect(markdown).toContain("Failed");
    expect(markdown).toContain("exit 1");
    expect(markdown).toContain("## Findings");
  });
});

describe("recorder to panel", () => {
  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => englishMessages }),
    );
    await initI18n();
  });

  it("renders a report from the runtime frames a real turn emits", () => {
    const dom = mountDom();
    const clock = { value: 0 };
    const recorder = createTurnTraceRecorder({ now: () => clock.value });
    const target = { workspaceId: "ws", sessionId: "s1", instanceId: "i1" };
    const emit = (event, at) => {
      clock.value = at;
      recorder.handleRuntimeFrame({ type: "runtime_event", target, event });
    };

    emit({ type: "agent_start" }, 0);
    emit({ type: "message_start", message: { role: "user", content: "run the tests" } }, 0);
    emit({ type: "message_start", message: { role: "assistant" } }, 500);
    const args = { command: "bun test" };
    emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args }, 1_000);
    emit({ type: "tool_execution_end", toolCallId: "t1", isError: true, result: "exit 1" }, 41_000);
    emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash", args }, 42_000);
    emit({ type: "tool_execution_end", toolCallId: "t2", isError: true, result: "exit 1" }, 43_000);
    emit(
      { type: "message_end", message: { role: "assistant", stopReason: "end_turn", content: [] } },
      44_000,
    );
    emit({ type: "agent_settled" }, 44_500);

    setupTaskDebuggerPanel({ ...dom, getTurns: () => recorder.getTurns(target), t }).open();

    const text = dom.body.textContent;
    // The failing command, the retry loop and the bottleneck all surface.
    expect(text).toContain("bun test");
    expect(text).toContain("exit 1");
    expect(text).toContain("failed 2 times in a row");
    expect(text).toContain("bottleneck");
  });
});
