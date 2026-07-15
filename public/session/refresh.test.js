import { describe, expect, test } from "vitest";
import { resolveNewSessionLiveFile } from "./refresh.js";

describe("resolveNewSessionLiveFile", () => {
  test("does not treat the previous foreground instance session as the new session", () => {
    const previousFile = "/tmp/session-old.jsonl";

    const liveFile = resolveNewSessionLiveFile({
      event: { __broker: {} },
      liveInstances: [{ port: 47821, sessionFile: previousFile }],
      foregroundPort: 47821,
      mirrorActiveSessionFile: null,
      excludedSessionFile: previousFile,
    });

    expect(liveFile).toBeNull();
  });

  test("prefers the broker-routed session file for the first message", () => {
    const liveFile = resolveNewSessionLiveFile({
      event: { __broker: { sessionId: "/tmp/session-new.jsonl" } },
      liveInstances: [{ port: 47821, sessionFile: "/tmp/session-old.jsonl" }],
      foregroundPort: 47821,
      mirrorActiveSessionFile: null,
      excludedSessionFile: "/tmp/session-old.jsonl",
    });

    expect(liveFile).toBe("/tmp/session-new.jsonl");
  });

  test("uses the instance registry once it points at a different session", () => {
    const liveFile = resolveNewSessionLiveFile({
      event: { __broker: {} },
      liveInstances: [{ port: 47821, sessionFile: "/tmp/session-new.jsonl" }],
      foregroundPort: 47821,
      mirrorActiveSessionFile: null,
      excludedSessionFile: "/tmp/session-old.jsonl",
    });

    expect(liveFile).toBe("/tmp/session-new.jsonl");
  });
});
