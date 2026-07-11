import { CookieJar, JSDOM } from "jsdom";
import { describe, expect, test, vi } from "vitest";
import {
  MAX_RECENT_SESSIONS,
  readRecentSessions,
  recordRecentSession,
  writeRecentSessions,
} from "./recent-sessions.js";

function documentAt(port, cookieJar = new CookieJar()) {
  return new JSDOM("<!doctype html>", {
    cookieJar,
    url: `http://localhost:${port}`,
  }).window.document;
}

describe("recent-session cookie persistence", () => {
  test("shares the ordered recent list across localhost ports", () => {
    const jar = new CookieJar();
    const first = documentAt(3001, jar);
    const second = documentAt(3002, jar);

    expect(recordRecentSession("/work/a/session-a.jsonl", first)).toEqual([
      "/work/a/session-a.jsonl",
    ]);
    expect(readRecentSessions(second)).toEqual(["/work/a/session-a.jsonl"]);
  });

  test("promotes duplicates and retains only five paths", () => {
    const doc = documentAt(3001);
    const paths = Array.from({ length: 6 }, (_, index) => `/work/${index}.jsonl`);
    paths.forEach((path) => {
      recordRecentSession(path, doc);
    });

    expect(readRecentSessions(doc)).toEqual(paths.slice(1).reverse());
    expect(recordRecentSession(paths[3], doc)[0]).toBe(paths[3]);
    expect(readRecentSessions(doc)).toHaveLength(MAX_RECENT_SESSIONS);
  });

  test("normalizes malformed cookie data and preserves memory order on write failure", () => {
    const doc = documentAt(3001);
    doc.cookie = "picot-recent-sessions=%7Bbad-json; Path=/";
    expect(readRecentSessions(doc)).toEqual([]);

    const failingDocument = {
      get cookie() {
        return "";
      },
      set cookie(_value) {
        throw new Error("cookies unavailable");
      },
    };
    expect(writeRecentSessions(["/work/a.jsonl"], failingDocument)).toEqual(["/work/a.jsonl"]);
  });

  test("drops oldest entries until the encoded value fits and omits one oversized path", () => {
    const doc = documentAt(3001);
    const oversized = `/work/${"x".repeat(4000)}.jsonl`;
    const kept = writeRecentSessions([oversized, "/work/new.jsonl", "/work/old.jsonl"], doc);

    expect(kept).toEqual(["/work/new.jsonl", "/work/old.jsonl"]);
    expect(readRecentSessions(doc)).toEqual(kept);
  });

  test("normalizes non-array, non-string, empty, and duplicate values", () => {
    const doc = documentAt(3001);
    doc.cookie = `picot-recent-sessions=${encodeURIComponent(JSON.stringify({ value: "bad" }))}; Path=/`;
    expect(readRecentSessions(doc)).toEqual([]);

    doc.cookie = `picot-recent-sessions=${encodeURIComponent(
      JSON.stringify(["", "/work/a.jsonl", 42, "/work/a.jsonl", "/work/b.jsonl"]),
    )}; Path=/`;
    expect(readRecentSessions(doc)).toEqual(["/work/a.jsonl", "/work/b.jsonl"]);
  });

  test("skips writing when the normalized order does not change", () => {
    const doc = documentAt(3001);
    const setter = vi.spyOn(Object.getPrototypeOf(doc), "cookie", "set");
    recordRecentSession("/work/a.jsonl", doc);
    setter.mockClear();

    recordRecentSession("/work/a.jsonl", doc);

    expect(setter).not.toHaveBeenCalled();
    setter.mockRestore();
  });
});
