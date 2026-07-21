import { CookieJar, JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  FAVOURITES_MIGRATED_FLAG,
  FAVOURITES_STORAGE_KEY,
  MAX_PINNED_BYTES,
  migrateFavourites,
  normalizePinnedState,
  PINNED_ITEMS_COOKIE,
  PINNED_ITEMS_EVENT,
  PINNED_SCHEMA_VERSION,
  PinnedCapacityError,
  pinSession,
  pinWorkspace,
  readPinnedItems,
  reconcileWorkspaceId,
  refreshPinnedItems,
  resetPinnedItemsSync,
  samePinnedState,
  startPinnedItemsSync,
  subscribePinnedItems,
  unpinSession,
  unpinWorkspace,
  writePinnedItems,
} from "./pinned-items.js";

function documentAt(port, cookieJar = new CookieJar()) {
  const dom = new JSDOM("<!doctype html>", {
    cookieJar,
    url: `http://localhost:${port}`,
  });
  return dom.window.document;
}

function domAt(port, cookieJar = new CookieJar()) {
  return new JSDOM("<!doctype html>", {
    cookieJar,
    url: `http://localhost:${port}`,
  });
}

const HISTORY = "history:2026-07-14-abcd";
const PATH_A = "/work/project-alpha";
const SESSION_A = "/work/project-alpha/sessions/a.jsonl";

beforeEach(() => {
  resetPinnedItemsSync();
});

afterEach(() => {
  resetPinnedItemsSync();
});

describe("normalizePinnedState", () => {
  test("accepts valid mixed workspace and session pins", () => {
    const state = normalizePinnedState({
      v: 1,
      workspaces: [{ id: HISTORY, path: PATH_A }],
      sessions: [SESSION_A],
    });
    expect(state).toEqual({
      workspaces: [{ id: HISTORY, path: PATH_A }],
      sessions: [SESSION_A],
    });
  });

  test("rejects malformed and non-object payloads to an empty recoverable state", () => {
    for (const bad of [null, undefined, "string", 42, [], "[]"]) {
      expect(normalizePinnedState(bad)).toEqual({ workspaces: [], sessions: [] });
    }
  });

  test("drops workspace records with bad ids, empty ids, or empty paths", () => {
    const state = normalizePinnedState({
      workspaces: [
        { id: HISTORY, path: PATH_A },
        { id: "not-a-valid-prefix", path: "/x" },
        { id: "", path: "/y" },
        { id: "history:good", path: "" },
        { id: "   ", path: "/z" },
        "string-instead-of-object",
        null,
        { id: 42, path: "/n" },
      ],
    });
    expect(state.workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);
  });

  test("trims workspace ids and preserves display path verbatim", () => {
    const state = normalizePinnedState({
      workspaces: [{ id: `  ${HISTORY}  `, path: PATH_A }],
    });
    expect(state.workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);
  });

  test("drops duplicate workspace ids preserving first-seen order", () => {
    const state = normalizePinnedState({
      workspaces: [
        { id: HISTORY, path: PATH_A },
        { id: HISTORY, path: "/different/path" },
      ],
    });
    expect(state.workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);
  });

  test("accepts path: provisional ids alongside history: ids", () => {
    const state = normalizePinnedState({
      workspaces: [
        { id: "path:/work/beta", path: "/work/beta" },
        { id: HISTORY, path: PATH_A },
      ],
    });
    expect(state.workspaces).toHaveLength(2);
  });

  test("drops non-string, empty, and duplicate session identifiers", () => {
    const state = normalizePinnedState({
      sessions: [SESSION_A, "", 42, null, SESSION_A, "/b.jsonl", SESSION_A],
    });
    expect(state.sessions).toEqual([SESSION_A, "/b.jsonl"]);
  });
});

describe("readPinnedItems", () => {
  test("returns empty state when no cookie is present", () => {
    expect(readPinnedItems(documentAt(3001))).toEqual({ workspaces: [], sessions: [] });
  });

  test("reads and normalizes a valid cookie", () => {
    const doc = documentAt(3001);
    writePinnedItems({ workspaces: [{ id: HISTORY, path: PATH_A }], sessions: [SESSION_A] }, doc);
    expect(readPinnedItems(doc)).toEqual({
      workspaces: [{ id: HISTORY, path: PATH_A }],
      sessions: [SESSION_A],
    });
  });

  test("recovers from malformed JSON as empty state", () => {
    const doc = documentAt(3001);
    doc.cookie = `${PINNED_ITEMS_COOKIE}=%7Bnot-json; Path=/`;
    expect(readPinnedItems(doc)).toEqual({ workspaces: [], sessions: [] });
  });

  test("normalizes a malformed-shape cookie to valid state", () => {
    const doc = documentAt(3001);
    doc.cookie = `${PINNED_ITEMS_COOKIE}=${encodeURIComponent(
      JSON.stringify({ workspaces: [{ id: "bad", path: "" }], sessions: ["", 5] }),
    )}; Path=/`;
    expect(readPinnedItems(doc)).toEqual({ workspaces: [], sessions: [] });
  });

  test("shares the cookie across localhost ports", () => {
    const jar = new CookieJar();
    const first = documentAt(3001, jar);
    const second = documentAt(3002, jar);

    pinWorkspace(HISTORY, PATH_A, first);
    expect(readPinnedItems(second).workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);
  });
});

describe("writePinnedItems", () => {
  test("writes a normalized v1 cookie with Path=/ and SameSite=Lax", () => {
    const doc = documentAt(3001);
    const setter = vi.spyOn(Object.getPrototypeOf(doc), "cookie", "set");
    writePinnedItems({ workspaces: [{ id: HISTORY, path: PATH_A }], sessions: [] }, doc);

    expect(setter).toHaveBeenCalledTimes(1);
    const assigned = setter.mock.calls[0][0];
    expect(assigned.startsWith(`${PINNED_ITEMS_COOKIE}=`)).toBe(true);
    expect(assigned).toContain("Path=/");
    expect(assigned).toContain("SameSite=Lax");
    expect(assigned).toContain("Max-Age=");
    setter.mockRestore();
  });

  test("uses the v1 schema in the stored payload", () => {
    const doc = documentAt(3001);
    writePinnedItems({ workspaces: [{ id: HISTORY, path: PATH_A }], sessions: [SESSION_A] }, doc);
    const value = readCookieJson(doc);
    expect(value.v).toBe(PINNED_SCHEMA_VERSION);
  });

  test("skips writing when the normalized state is unchanged", () => {
    const doc = documentAt(3001);
    writePinnedItems({ workspaces: [{ id: HISTORY, path: PATH_A }], sessions: [] }, doc);
    const setter = vi.spyOn(Object.getPrototypeOf(doc), "cookie", "set");
    setter.mockClear();

    writePinnedItems({ workspaces: [{ id: HISTORY, path: PATH_A }] }, doc);

    expect(setter).not.toHaveBeenCalled();
    setter.mockRestore();
  });

  test("normalizes the input before writing", () => {
    const doc = documentAt(3001);
    const result = writePinnedItems(
      {
        workspaces: [{ id: HISTORY, path: PATH_A }, { id: "bad", path: "" }, HISTORY],
        sessions: [SESSION_A, SESSION_A, ""],
      },
      doc,
    );
    expect(result).toEqual({
      workspaces: [{ id: HISTORY, path: PATH_A }],
      sessions: [SESSION_A],
    });
    expect(readPinnedItems(doc)).toEqual(result);
  });
});

describe("capacity boundary", () => {
  test("rejects a write exceeding 3800 encoded bytes without evicting", () => {
    const doc = documentAt(3001);
    const baseline = { workspaces: [{ id: HISTORY, path: PATH_A }], sessions: [SESSION_A] };
    writePinnedItems(baseline, doc);
    const before = doc.cookie;

    const hugeSession = `/${"x".repeat(MAX_PINNED_BYTES)}.jsonl`;
    let caught = null;
    try {
      writePinnedItems({ workspaces: [], sessions: [hugeSession] }, doc);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PinnedCapacityError);
    expect(caught.attemptedBytes).toBeGreaterThan(MAX_PINNED_BYTES);
    expect(caught.limitBytes).toBe(MAX_PINNED_BYTES);
    expect(caught.previousState.workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);
    expect(caught.previousState.sessions).toEqual([SESSION_A]);
    expect(doc.cookie).toBe(before);
  });

  test("rejects a mutation that would exceed capacity without dropping existing pins", () => {
    const doc = documentAt(3001);
    const longPath = (label) => `/${label}/${"y".repeat(300)}.jsonl`;
    const base = {
      workspaces: [],
      sessions: [longPath("one"), longPath("two"), longPath("three"), longPath("four")],
    };
    const written = writePinnedItems(base, doc);
    expect(readPinnedItems(doc)).toEqual(written);

    const oversized = `/${"z".repeat(MAX_PINNED_BYTES)}.jsonl`;
    expect(() => pinSession(oversized, doc)).toThrow(PinnedCapacityError);
    expect(readPinnedItems(doc).sessions).toEqual(written.sessions);
  });

  test("accepts a write up to the 3800-byte boundary", () => {
    const doc = documentAt(3001);
    const sessions = [];
    let lastOk = null;
    for (let i = 0; i < 200; i++) {
      const candidate = [...sessions, `/s${i}/${"p".repeat(60)}.jsonl`];
      const state = { workspaces: [], sessions: candidate };
      try {
        writePinnedItems(state, doc);
      } catch (error) {
        if (error instanceof PinnedCapacityError) break;
        throw error;
      }
      sessions.push(`/s${i}/${"p".repeat(60)}.jsonl`);
      lastOk = state;
    }
    expect(lastOk).not.toBeNull();
    expect(readPinnedItems(doc)).toEqual(lastOk);
  });
});

describe("pin / unpin mutations", () => {
  test("pinWorkspace adds a new pin at the front", () => {
    const doc = documentAt(3001);
    pinWorkspace(HISTORY, PATH_A, doc);
    const result = pinWorkspace("history:beta-dir", "/work/beta", doc);
    expect(result.workspaces.map((w) => w.id)).toEqual(["history:beta-dir", HISTORY]);
  });

  test("pinWorkspace promotes an existing workspace to the front and refreshes path", () => {
    const doc = documentAt(3001);
    pinWorkspace(HISTORY, PATH_A, doc);
    const result = pinWorkspace(HISTORY, "/work/alpha-renamed", doc);
    expect(result.workspaces).toEqual([{ id: HISTORY, path: "/work/alpha-renamed" }]);
  });

  test("pinWorkspace ignores an invalid id", () => {
    const doc = documentAt(3001);
    pinWorkspace(HISTORY, PATH_A, doc);
    const result = pinWorkspace("no-prefix", "/x", doc);
    expect(result.workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);
  });

  test("unpinWorkspace removes a pinned workspace by id", () => {
    const doc = documentAt(3001);
    pinWorkspace(HISTORY, PATH_A, doc);
    pinWorkspace("history:beta", "/work/beta", doc);
    const result = unpinWorkspace(HISTORY, doc);
    expect(result.workspaces.map((w) => w.id)).toEqual(["history:beta"]);
  });

  test("pinSession adds a new session at the front", () => {
    const doc = documentAt(3001);
    pinSession(SESSION_A, doc);
    const result = pinSession("/work/b.jsonl", doc);
    expect(result.sessions).toEqual(["/work/b.jsonl", SESSION_A]);
  });

  test("pinSession promotes an existing session to the front", () => {
    const doc = documentAt(3001);
    pinSession(SESSION_A, doc);
    pinSession("/work/b.jsonl", doc);
    const result = pinSession(SESSION_A, doc);
    expect(result.sessions).toEqual([SESSION_A, "/work/b.jsonl"]);
  });

  test("unpinSession removes a pinned session", () => {
    const doc = documentAt(3001);
    pinSession(SESSION_A, doc);
    pinSession("/work/b.jsonl", doc);
    const result = unpinSession(SESSION_A, doc);
    expect(result.sessions).toEqual(["/work/b.jsonl"]);
  });

  test("mutations read the newest cookie before writing (read-before-write)", () => {
    const jar = new CookieJar();
    const writerA = documentAt(3001, jar);
    const writerB = documentAt(3002, jar);

    pinWorkspace(HISTORY, PATH_A, writerA);
    pinSession(SESSION_A, writerB);

    const merged = readPinnedItems(writerA);
    expect(merged.workspaces.map((w) => w.id)).toContain(HISTORY);
    expect(merged.sessions).toContain(SESSION_A);
  });

  test("pinSession preserves workspaces; pinWorkspace preserves sessions", () => {
    const doc = documentAt(3001);
    pinWorkspace(HISTORY, PATH_A, doc);
    pinSession(SESSION_A, doc);

    pinSession("/work/other.jsonl", doc);
    expect(readPinnedItems(doc).workspaces).toEqual([{ id: HISTORY, path: PATH_A }]);

    pinWorkspace("history:other", "/work/other", doc);
    expect(readPinnedItems(doc).sessions).toContain(SESSION_A);
  });
});

describe("reconcileWorkspaceId", () => {
  test("replaces a provisional path: id with a stable history: id in place", () => {
    const doc = documentAt(3001);
    pinWorkspace("path:/work/alpha", PATH_A, doc);
    pinWorkspace("history:other", "/work/other", doc);

    const result = reconcileWorkspaceId("path:/work/alpha", HISTORY, doc);
    const ids = result.workspaces.map((w) => w.id);
    expect(ids).toEqual(["history:other", HISTORY]);
    expect(result.workspaces.find((w) => w.id === HISTORY).path).toBe(PATH_A);
  });

  test("drops the provisional entry if the history id already exists", () => {
    const doc = documentAt(3001);
    pinWorkspace("path:/work/alpha", PATH_A, doc);
    pinWorkspace(HISTORY, "/work/alpha-other", doc);

    const result = reconcileWorkspaceId("path:/work/alpha", HISTORY, doc);
    expect(result.workspaces).toEqual([{ id: HISTORY, path: "/work/alpha-other" }]);
  });

  test("leaves state unchanged when the provisional id is absent", () => {
    const doc = documentAt(3001);
    pinWorkspace(HISTORY, PATH_A, doc);
    const before = readPinnedItems(doc);
    const result = reconcileWorkspaceId("path:/not-present", "history:new", doc);
    expect(result).toEqual(before);
  });

  test("preserves sessions across reconciliation", () => {
    const doc = documentAt(3001);
    pinWorkspace("path:/work/alpha", PATH_A, doc);
    pinSession(SESSION_A, doc);
    const result = reconcileWorkspaceId("path:/work/alpha", HISTORY, doc);
    expect(result.sessions).toEqual([SESSION_A]);
  });
});

describe("migrateFavourites", () => {
  function storageFrom(map = new Map()) {
    return {
      getItem: (key) => (map.has(key) ? map.get(key) : null),
      setItem: (key, value) => {
        map.set(key, String(value));
      },
      removeItem: (key) => {
        map.delete(key);
      },
    };
  }

  test("merges legacy favourite sessions into the pin cookie and marks migrated", () => {
    const doc = documentAt(3001);
    const storage = storageFrom();
    storage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(["/legacy/a.jsonl", "/legacy/b.jsonl"]));

    const result = migrateFavourites({ documentRef: doc, storageRef: storage });

    expect(result.migrated).toEqual(["/legacy/a.jsonl", "/legacy/b.jsonl"]);
    expect(result.capacityError).toBeNull();
    expect(result.pendingLegacySessions).toEqual([]);
    const state = readPinnedItems(doc);
    expect(state.sessions).toEqual(["/legacy/a.jsonl", "/legacy/b.jsonl"]);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBe("1");
  });

  test("skips migration when already marked migrated", () => {
    const doc = documentAt(3001);
    const storage = storageFrom();
    storage.setItem(FAVOURITES_MIGRATED_FLAG, "1");
    storage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(["/legacy/a.jsonl"]));

    const result = migrateFavourites({ documentRef: doc, storageRef: storage });

    expect(result.skipped).toBe(true);
    expect(result.migrated).toEqual([]);
    expect(readPinnedItems(doc).sessions).toEqual([]);
  });

  test("marks migrated when no legacy value exists", () => {
    const doc = documentAt(3001);
    const storage = storageFrom();
    const result = migrateFavourites({ documentRef: doc, storageRef: storage });
    expect(result.migrated).toEqual([]);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBe("1");
  });

  test("does not duplicate sessions already pinned", () => {
    const doc = documentAt(3001);
    pinSession(SESSION_A, doc);
    const storage = storageFrom();
    storage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify([SESSION_A, "/legacy/b.jsonl"]));

    const result = migrateFavourites({ documentRef: doc, storageRef: storage });

    expect(result.migrated).toEqual(["/legacy/b.jsonl"]);
    expect(readPinnedItems(doc).sessions).toEqual(["/legacy/b.jsonl", SESSION_A]);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBe("1");
  });

  test("tolerates malformed legacy JSON by treating it as empty", () => {
    const doc = documentAt(3001);
    const storage = storageFrom();
    storage.setItem(FAVOURITES_STORAGE_KEY, "{not json");
    const result = migrateFavourites({ documentRef: doc, storageRef: storage });
    expect(result.migrated).toEqual([]);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBe("1");
  });

  test("on capacity failure preserves the cookie and reports pending legacy sessions for retry", () => {
    const doc = documentAt(3001);
    const nearFull = [];
    for (let i = 0; i < 200; i++) {
      const candidate = [...nearFull, `/n${i}/${"p".repeat(60)}.jsonl`];
      try {
        writePinnedItems({ workspaces: [], sessions: candidate }, doc);
      } catch (error) {
        if (error instanceof PinnedCapacityError) break;
        throw error;
      }
      nearFull.push(`/n${i}/${"p".repeat(60)}.jsonl`);
    }
    const beforeCookie = doc.cookie;
    const beforeState = readPinnedItems(doc);

    const oversizedLegacy = [`/${"L".repeat(MAX_PINNED_BYTES)}.jsonl`];
    const storage = storageFrom();
    storage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(oversizedLegacy));

    const result = migrateFavourites({ documentRef: doc, storageRef: storage });

    expect(result.capacityError).toBeInstanceOf(PinnedCapacityError);
    expect(result.pendingLegacySessions).toEqual(oversizedLegacy);
    expect(doc.cookie).toBe(beforeCookie);
    expect(readPinnedItems(doc)).toEqual(beforeState);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBeNull();
  });

  test("migration marks migrated after a later unpin frees space", () => {
    const doc = documentAt(3001);
    const storage = storageFrom();
    const legacy = [`/legacy/${"L".repeat(200)}.jsonl`];
    storage.setItem(FAVOURITES_STORAGE_KEY, JSON.stringify(legacy));

    const nearFull = [];
    for (let i = 0; i < 200; i++) {
      const candidate = [...nearFull, `/n${i}/${"p".repeat(60)}.jsonl`];
      try {
        writePinnedItems({ workspaces: [], sessions: candidate }, doc);
      } catch (error) {
        if (error instanceof PinnedCapacityError) break;
        throw error;
      }
      nearFull.push(`/n${i}/${"p".repeat(60)}.jsonl`);
    }

    const result = migrateFavourites({ documentRef: doc, storageRef: storage });
    expect(result.capacityError).toBeInstanceOf(PinnedCapacityError);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBeNull();

    for (const s of readPinnedItems(doc).sessions) unpinSession(s, doc);

    const retried = migrateFavourites({ documentRef: doc, storageRef: storage });
    expect(retried.capacityError).toBeNull();
    expect(retried.migrated).toEqual(legacy);
    expect(storage.getItem(FAVOURITES_MIGRATED_FLAG)).toBe("1");
  });
});

describe("cross-window change detection", () => {
  test("refreshPinnedItems notifies subscribers only when the value changes", () => {
    const doc = documentAt(3001);
    const calls = [];
    const unsubscribe = subscribePinnedItems((state) => calls.push(state.sessions.slice()));

    refreshPinnedItems(doc);
    expect(calls).toEqual([]);

    pinSession(SESSION_A, doc);
    refreshPinnedItems(doc);
    expect(calls).toEqual([[SESSION_A]]);

    refreshPinnedItems(doc);
    expect(calls).toEqual([[SESSION_A]]);

    unsubscribe();
    pinSession("/work/b.jsonl", doc);
    refreshPinnedItems(doc);
    expect(calls).toEqual([[SESSION_A]]);
  });

  test("dispatches the PINNED_ITEMS_EVENT on change", () => {
    const dom = domAt(3001);
    const doc = dom.window.document;
    const win = dom.window;
    const events = [];
    win.addEventListener(PINNED_ITEMS_EVENT, (event) => events.push(event.detail));

    refreshPinnedItems(doc, win);
    events.length = 0;

    refreshPinnedItems(doc, win);
    expect(events).toEqual([]);

    pinWorkspace(HISTORY, PATH_A, doc);
    refreshPinnedItems(doc, win);
    expect(events).toHaveLength(1);
    expect(events[0].workspaces.map((w) => w.id)).toEqual([HISTORY]);
  });

  test("a foreign cookie write is detected on refresh by another window", () => {
    const jar = new CookieJar();
    const docA = documentAt(3001, jar);
    const domB = domAt(3002, jar);
    const docB = domB.window.document;

    const seen = [];
    subscribePinnedItems((state) => seen.push(state.sessions.slice()));

    pinSession(SESSION_A, docA);
    refreshPinnedItems(docB);

    expect(seen).toEqual([[SESSION_A]]);
  });

  test("listener errors do not break convergence", () => {
    const doc = documentAt(3001);
    subscribePinnedItems(() => {
      throw new Error("listener broke");
    });
    const ok = [];
    subscribePinnedItems((state) => ok.push(state.sessions.slice()));

    pinSession(SESSION_A, doc);
    expect(() => refreshPinnedItems(doc)).not.toThrow();
    expect(ok).toEqual([[SESSION_A]]);
  });

  test("startPinnedItemsSync checks on focus and visibilitychange", () => {
    const dom = domAt(3001);
    const doc = dom.window.document;
    const win = dom.window;
    Object.defineProperty(doc, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const seen = [];
    startPinnedItemsSync({ windowRef: win, documentRef: doc, pollIntervalMs: 1000 });
    subscribePinnedItems((state) => seen.push(state.sessions.slice()));

    pinSession(SESSION_A, doc);
    win.dispatchEvent(new win.Event("focus"));
    expect(seen).toEqual([[SESSION_A]]);
  });

  test("cleanup removes listeners and stops polling", () => {
    const dom = domAt(3001);
    const doc = dom.window.document;
    const win = dom.window;
    Object.defineProperty(doc, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const removeSpy = vi.spyOn(win, "removeEventListener");

    const cleanup = startPinnedItemsSync({
      windowRef: win,
      documentRef: doc,
      pollIntervalMs: 1000,
    });
    cleanup();

    expect(removeSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    removeSpy.mockRestore();
  });
});

describe("samePinnedState", () => {
  test("compares by serialized shape, ignoring extra fields", () => {
    const a = { workspaces: [{ id: HISTORY, path: PATH_A }], sessions: [SESSION_A] };
    const b = {
      workspaces: [{ id: HISTORY, path: PATH_A, extra: "ignored" }],
      sessions: [SESSION_A],
    };
    expect(samePinnedState(a, b)).toBe(true);
  });

  test("detects order differences", () => {
    const a = { workspaces: [], sessions: ["/a", "/b"] };
    const b = { workspaces: [], sessions: ["/b", "/a"] };
    expect(samePinnedState(a, b)).toBe(false);
  });
});

function readCookieJson(doc) {
  const entries = doc.cookie.split("; ");
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (entry.slice(0, separator) === PINNED_ITEMS_COOKIE) {
      return JSON.parse(decodeURIComponent(entry.slice(separator + 1)));
    }
  }
  throw new Error("cookie not found");
}
