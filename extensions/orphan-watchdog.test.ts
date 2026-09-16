// @vitest-environment node

import { describe, expect, it } from "vitest";
import { startOrphanWatchdog } from "./orphan-watchdog.ts";

function harness(parentPids: number[]) {
  const exits: number[] = [];
  let tick: (() => void) | undefined;
  let scheduledMs: number | undefined;
  let index = 0;
  startOrphanWatchdog(30_000, {
    getParentPid: () => parentPids[Math.min(index, parentPids.length - 1)] ?? 1,
    exit: (code) => exits.push(code),
    setInterval: (handler, ms) => {
      tick = handler;
      scheduledMs = ms;
      return 0;
    },
  });
  return {
    exits,
    scheduledMs,
    scheduled: tick !== undefined,
    advance: () => {
      index += 1;
      tick?.();
    },
  };
}

describe("orphan watchdog", () => {
  it("exits once the supervising Picot is gone", () => {
    const run = harness([4242, 1]);
    expect(run.scheduled).toBe(true);
    expect(run.scheduledMs).toBe(30_000);
    run.advance();
    expect(run.exits).toEqual([0]);
  });

  it("stays out of the way while the parent is alive", () => {
    const run = harness([4242, 4242]);
    run.advance();
    expect(run.exits).toEqual([]);
  });

  it("does not watch a runtime that was never supervised", () => {
    // Already reparented at startup: a bare `pi` launch, not an orphan.
    const run = harness([1]);
    expect(run.scheduled).toBe(false);
    expect(run.exits).toEqual([]);
  });
});
