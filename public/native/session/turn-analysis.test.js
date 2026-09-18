import { describe, expect, it } from "vitest";
import { analyzeTurns, formatMs, formatShare, mergedDuration } from "./turn-analysis.js";

function step(kind, label, startedAt, durationMs, extra = {}) {
  return {
    kind,
    label,
    detail: extra.detail ?? "",
    signature: extra.signature ?? (kind === "tool" ? `${label}|{}` : null),
    toolCallId: extra.toolCallId ?? null,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    status: extra.status ?? "ok",
    error: extra.error ?? null,
    stopReason: extra.stopReason ?? null,
  };
}

function turn(
  steps,
  { index = 1, startedAt = 0, endedAt, status = "completed", error = null } = {},
) {
  const last = steps.length ? steps[steps.length - 1].endedAt : startedAt;
  return {
    id: `turn-${index}`,
    index,
    prompt: "do the thing",
    startedAt,
    endedAt: endedAt ?? last,
    durationMs: (endedAt ?? last) - startedAt,
    status,
    error,
    usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 },
    steps,
  };
}

function codes(report) {
  return report.findings.map((finding) => finding.code);
}

describe("mergedDuration", () => {
  it("does not double count overlapping spans", () => {
    expect(
      mergedDuration([
        { startedAt: 0, endedAt: 100 },
        { startedAt: 50, endedAt: 150 },
        { startedAt: 200, endedAt: 250 },
      ]),
    ).toBe(200);
  });

  it("ignores spans without a finite end", () => {
    expect(mergedDuration([{ startedAt: 0, endedAt: null }])).toBe(0);
  });
});

describe("formatting", () => {
  it("scales milliseconds to seconds and minutes", () => {
    expect(formatMs(450)).toBe("450ms");
    expect(formatMs(1500)).toBe("1.5s");
    expect(formatMs(95_000)).toBe("1m 35s");
    expect(formatShare(0.336)).toBe("34%");
  });
});

describe("analyzeTurns time breakdown", () => {
  it("splits wall time into model, tool and idle phases", () => {
    const report = analyzeTurns([
      turn([step("model", "assistant", 0, 10_000), step("tool", "bash", 2_000, 4_000)], {
        startedAt: 0,
        endedAt: 20_000,
      }),
    ]);

    expect(report.totals.wallMs).toBe(20_000);
    expect(report.totals.toolMs).toBe(4_000);
    expect(report.totals.modelMs).toBe(6_000);
    expect(report.totals.idleMs).toBe(10_000);
    expect(report.phases.map((phase) => phase.kind)).toEqual([
      "model",
      "tool",
      "compaction",
      "idle",
    ]);
  });

  it("ranks the slowest steps and names the bottleneck", () => {
    const report = analyzeTurns([
      turn([
        step("tool", "bash", 0, 1_000, { detail: "bun test" }),
        step("tool", "read", 1_000, 40_000, { detail: "/a.js" }),
      ]),
    ]);

    expect(report.bottleneck).toMatchObject({ label: "read", durationMs: 40_000 });
    expect(report.slowest[0].label).toBe("read");
    expect(codes(report)).toContain("slowStep");
  });

  it("flags idle time the agent spent waiting", () => {
    const report = analyzeTurns([
      turn([step("tool", "bash", 0, 1_000)], { startedAt: 0, endedAt: 30_000 }),
    ]);
    expect(codes(report)).toContain("idleTime");
  });

  it("counts a still-running turn against the current clock", () => {
    const report = analyzeTurns(
      [{ ...turn([]), endedAt: null, durationMs: null, status: "running" }],
      { now: () => 5_000 },
    );
    expect(report.status).toBe("running");
    expect(report.totals.wallMs).toBe(5_000);
  });
});

describe("analyzeTurns failures", () => {
  it("reports the first failure with its step and error", () => {
    const report = analyzeTurns([
      turn(
        [
          step("tool", "bash", 0, 100, { status: "error", error: "exit 1", detail: "bun test" }),
          step("model", "assistant", 100, 200),
        ],
        { status: "failed", error: "task failed" },
      ),
    ]);

    expect(report.status).toBe("failed");
    expect(report.firstFailure).toMatchObject({ label: "bash", error: "exit 1" });
    expect(codes(report)).toContain("failedAt");
    expect(codes(report)).toContain("toolFailures");
    expect(report.findings[0].severity).toBe("critical");
  });

  it("flags a step that never finished as the stuck point", () => {
    const report = analyzeTurns([
      turn([step("tool", "bash", 0, 60_000, { status: "unfinished", detail: "bun run dev" })]),
    ]);

    expect(report.unfinished).toHaveLength(1);
    expect(codes(report)).toContain("stuckStep");
  });

  it("distinguishes an aborted turn from a failed one", () => {
    const report = analyzeTurns([turn([step("model", "assistant", 0, 10)], { status: "aborted" })]);
    expect(report.status).toBe("aborted");
    expect(codes(report)).toContain("aborted");
  });

  it("flags a turn whose ending was never observed", () => {
    const report = analyzeTurns([turn([], { status: "unknown" })]);
    expect(codes(report)).toContain("unknownEnd");
  });
});

describe("analyzeTurns redundancy", () => {
  it("reports identical tool calls as duplicate work", () => {
    const signature = "read|{path:/a.js}";
    const report = analyzeTurns([
      turn([
        step("tool", "read", 0, 500, { signature, detail: "/a.js" }),
        step("tool", "read", 500, 500, { signature, detail: "/a.js" }),
        step("tool", "read", 1_000, 500, { signature, detail: "/a.js" }),
      ]),
    ]);

    const duplicate = report.redundancies.find((entry) => entry.code === "duplicateCalls");
    expect(duplicate).toMatchObject({ label: "read", count: 3, wastedMs: 1_000 });
    expect(codes(report)).toContain("duplicateCalls");
  });

  it("reports the same call failing repeatedly as a retry loop", () => {
    const signature = "bash|{command:bun test}";
    const report = analyzeTurns([
      turn([
        step("tool", "bash", 0, 100, { signature, status: "error", error: "exit 1" }),
        step("tool", "bash", 200, 100, { signature, status: "error", error: "exit 1" }),
      ]),
    ]);

    const loop = report.redundancies.find((entry) => entry.code === "retryLoop");
    expect(loop).toMatchObject({ label: "bash", count: 2 });
    expect(report.findings.some((f) => f.code === "retryLoop" && f.severity === "critical")).toBe(
      true,
    );
  });

  it("reports the same file re-read with different arguments", () => {
    const report = analyzeTurns([
      turn([
        step("tool", "read", 0, 100, { signature: "read|{path:/a.js,offset:0}", detail: "/a.js" }),
        step("tool", "read", 100, 100, {
          signature: "read|{path:/a.js,offset:20}",
          detail: "/a.js",
        }),
        step("tool", "read", 200, 100, {
          signature: "read|{path:/a.js,offset:40}",
          detail: "/a.js",
        }),
      ]),
    ]);

    expect(report.redundancies.find((entry) => entry.code === "repeatedTarget")).toMatchObject({
      detail: "/a.js",
      count: 3,
    });
  });

  it("does not report a write tool touching one file repeatedly as a re-read", () => {
    const report = analyzeTurns([
      turn([
        step("tool", "edit", 0, 100, { signature: "edit|{path:/a.js,n:1}", detail: "/a.js" }),
        step("tool", "edit", 100, 100, { signature: "edit|{path:/a.js,n:2}", detail: "/a.js" }),
        step("tool", "edit", 200, 100, { signature: "edit|{path:/a.js,n:3}", detail: "/a.js" }),
      ]),
    ]);

    expect(report.redundancies).toHaveLength(0);
  });
});

describe("analyzeTurns summary", () => {
  it("aggregates usage and turn counts across turns", () => {
    const report = analyzeTurns([
      turn([step("model", "assistant", 0, 100)], { index: 1, startedAt: 0 }),
      turn([step("model", "assistant", 1_000, 100)], { index: 2, startedAt: 1_000 }),
    ]);

    expect(report.totals.turns).toBe(2);
    expect(report.totals.usage).toMatchObject({ input: 200, output: 40, cost: 1 });
    expect(report.turns.map((entry) => entry.index)).toEqual([1, 2]);
  });

  it("reports a clean fast turn as healthy", () => {
    const report = analyzeTurns([
      turn([step("model", "assistant", 0, 900)], { startedAt: 0, endedAt: 1_000 }),
    ]);
    expect(codes(report)).toEqual(["healthy"]);
  });

  it("returns an empty report for no turns", () => {
    const report = analyzeTurns([]);
    expect(report.totals.wallMs).toBe(0);
    expect(report.status).toBe("completed");
    expect(codes(report)).toEqual(["healthy"]);
  });
});
