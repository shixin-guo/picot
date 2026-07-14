/**
 * Pinned Items - v1 cookie store for workspace/session Pins.
 *
 * Owns parsing, normalization, deduplication, capacity-bounded writes,
 * provisional-to-history workspace reconciliation, current-origin
 * Favourites migration, and cross-window change detection.
 *
 * The cookie is shared by all localhost workspace ports (Path=/; SameSite=Lax)
 * and uses last-write-wins semantics. Mutations read the newest cookie value
 * immediately before rewriting so concurrent windows converge. Pins never
 * evict: a mutation that would exceed the 3800-byte encoded limit is rejected
 * with a typed error and the existing cookie is preserved.
 */

export const PINNED_ITEMS_COOKIE = "picot-pinned-items";
export const PINNED_ITEMS_EVENT = "picot:pinned-items-change";
export const FAVOURITES_STORAGE_KEY = "pi-studio-favourites";
export const FAVOURITES_MIGRATED_FLAG = "picot-pinned-favourites-migrated";
export const MAX_PINNED_BYTES = 3800;
export const PINNED_SCHEMA_VERSION = 1;

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years, same as RECENT
const DEFAULT_POLL_INTERVAL_MS = 1000;
const WORKSPACE_ID_PATTERN = /^(?:history:|path:).+/;

function defaultDocument() {
  return typeof document !== "undefined" ? document : null;
}

function defaultWindow() {
  return typeof window !== "undefined" ? window : null;
}

/**
 * Error thrown when a mutation would push the encoded cookie past the capacity
 * limit. The existing cookie is left untouched; `previousState` holds the last
 * committed state so callers can render localized feedback without losing data.
 */
export class PinnedCapacityError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "PinnedCapacityError";
    this.attemptedBytes = context.attemptedBytes ?? 0;
    this.limitBytes = context.limitBytes ?? MAX_PINNED_BYTES;
    this.previousState = context.previousState ?? { workspaces: [], sessions: [] };
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, PinnedCapacityError);
    }
  }
}

function normalizeWorkspaceRecord(record) {
  if (!record || typeof record !== "object") return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const path = typeof record.path === "string" ? record.path : "";
  if (!id || !path || !WORKSPACE_ID_PATTERN.test(id)) return null;
  return { id, path };
}

/**
 * Build a normalized, deduplicated Pin state from arbitrary input.
 *
 * - Workspace records require a `history:` / `path:` id and a non-empty path;
 *   duplicates (by id) are dropped while preserving first-seen order.
 * - Sessions require non-empty strings; duplicates are dropped preserving order.
 * - Malformed payloads collapse to an empty (recoverable) state.
 */
export function normalizePinnedState(payload) {
  const workspaces = [];
  const sessions = [];

  if (!payload || typeof payload !== "object") return { workspaces, sessions };

  const rawWorkspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
  const seenWorkspaceIds = new Set();
  for (const record of rawWorkspaces) {
    const normalized = normalizeWorkspaceRecord(record);
    if (!normalized || seenWorkspaceIds.has(normalized.id)) continue;
    seenWorkspaceIds.add(normalized.id);
    workspaces.push(normalized);
  }

  const rawSessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const seenSessions = new Set();
  for (const session of rawSessions) {
    if (typeof session !== "string" || !session || seenSessions.has(session)) continue;
    seenSessions.add(session);
    sessions.push(session);
  }

  return { workspaces, sessions };
}

function serializeState(state) {
  return {
    v: PINNED_SCHEMA_VERSION,
    workspaces: state.workspaces.map((workspace) => ({ id: workspace.id, path: workspace.path })),
    sessions: state.sessions.slice(),
  };
}

function serializedForCompare(state) {
  return JSON.stringify(serializeState(state));
}

export function samePinnedState(a, b) {
  return serializedForCompare(a) === serializedForCompare(b);
}

function encodedValueLength(state) {
  return encodeURIComponent(JSON.stringify(serializeState(state))).length;
}

function readCookieValue(documentRef) {
  try {
    const entries = documentRef?.cookie ? documentRef.cookie.split("; ") : [];
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator === -1 || entry.slice(0, separator) !== PINNED_ITEMS_COOKIE) continue;
      const raw = entry.slice(separator + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {
    // Cookie access can fail in sandboxed browser contexts.
  }
  return null;
}

/**
 * Read and normalize the current Pin cookie. Malformed cookies resolve to an
 * empty state so the UI stays usable and recoverable.
 */
export function readPinnedItems(documentRef = defaultDocument()) {
  const value = readCookieValue(documentRef);
  if (!value) return { workspaces: [], sessions: [] };
  try {
    return normalizePinnedState(JSON.parse(value));
  } catch {
    return { workspaces: [], sessions: [] };
  }
}

/**
 * Validate and write a full Pin state.
 *
 * Reads the newest cookie immediately before writing, skips a no-op write, and
 * rejects — without eviction — when the encoded value would exceed the capacity
 * limit. The previous committed state is attached to the capacity error.
 */
export function writePinnedItems(nextState, documentRef = defaultDocument()) {
  const normalized = normalizePinnedState(nextState);
  const current = readPinnedItems(documentRef);
  if (samePinnedState(current, normalized)) return normalized;

  const attemptedBytes = encodedValueLength(normalized);
  if (attemptedBytes > MAX_PINNED_BYTES) {
    throw new PinnedCapacityError("Pin cookie would exceed the capacity limit", {
      attemptedBytes,
      limitBytes: MAX_PINNED_BYTES,
      previousState: current,
    });
  }

  try {
    const value = encodeURIComponent(JSON.stringify(serializeState(normalized)));
    documentRef.cookie = `${PINNED_ITEMS_COOKIE}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // Keep `normalized` as the caller's in-memory state.
  }
  return normalized;
}

function withWorkspace(documentRef, updater) {
  const current = readPinnedItems(documentRef);
  const workspaces = updater(current.workspaces);
  return writePinnedItems({ workspaces, sessions: current.sessions }, documentRef);
}

function withSessions(documentRef, updater) {
  const current = readPinnedItems(documentRef);
  const sessions = updater(current.sessions);
  return writePinnedItems({ workspaces: current.workspaces, sessions }, documentRef);
}

/**
 * Pin a workspace. New pins appear first; an existing record with the same id is
 * replaced (display path refreshed) at the front. Reads the newest cookie first.
 */
export function pinWorkspace(id, path, documentRef = defaultDocument()) {
  const record = normalizeWorkspaceRecord({ id, path });
  if (!record) return readPinnedItems(documentRef);
  return withWorkspace(documentRef, (workspaces) => [
    record,
    ...workspaces.filter((workspace) => workspace.id !== record.id),
  ]);
}

/** Remove a workspace pin by id. Reads the newest cookie first. */
export function unpinWorkspace(id, documentRef = defaultDocument()) {
  if (typeof id !== "string" || !id) return readPinnedItems(documentRef);
  return withWorkspace(documentRef, (workspaces) =>
    workspaces.filter((workspace) => workspace.id !== id),
  );
}

/** Pin a session file path. New pins appear first. Reads the newest cookie first. */
export function pinSession(filePath, documentRef = defaultDocument()) {
  if (typeof filePath !== "string" || !filePath) return readPinnedItems(documentRef);
  return withSessions(documentRef, (sessions) => [
    filePath,
    ...sessions.filter((session) => session !== filePath),
  ]);
}

/** Remove a session pin by file path. Reads the newest cookie first. */
export function unpinSession(filePath, documentRef = defaultDocument()) {
  if (typeof filePath !== "string" || !filePath) return readPinnedItems(documentRef);
  return withSessions(documentRef, (sessions) =>
    sessions.filter((session) => session !== filePath),
  );
}

/**
 * Replace a provisional workspace id (e.g. `path:<normalized>`) with its stable
 * history id (e.g. `history:<dirName>`) once a history project resolves to the
 * same workspace. Position and display path are preserved. If the target id
 * already exists, the provisional entry is simply dropped to avoid a duplicate.
 * Reads the newest cookie first.
 */
export function reconcileWorkspaceId(oldId, newId, documentRef = defaultDocument()) {
  if (typeof oldId !== "string" || !oldId || typeof newId !== "string" || !newId) {
    return readPinnedItems(documentRef);
  }
  return withWorkspace(documentRef, (workspaces) => {
    const provisionalIndex = workspaces.findIndex((workspace) => workspace.id === oldId);
    if (provisionalIndex === -1) return workspaces;

    const existingIndex = workspaces.findIndex(
      (workspace) => workspace.id === newId && workspace.id !== oldId,
    );
    if (existingIndex !== -1) {
      return workspaces.filter((_, index) => index !== provisionalIndex);
    }

    const next = workspaces.slice();
    const record = next[provisionalIndex];
    next[provisionalIndex] = { id: newId, path: record.path };
    return next;
  });
}

/**
 * Best-effort migration of the current origin's `pi-studio-favourites`
 * localStorage value into the shared Pin cookie.
 *
 * Each browser origin (localhost port) owns its own localStorage, so migration
 * runs once per origin and records completion in that origin's storage. On a
 * capacity failure the legacy value is preserved, the unresolved session paths
 * are returned via `pendingLegacySessions` for in-memory rendering, and a
 * `capacityError` is reported so the UI can warn and retry after a later Unpin
 * frees space. Migration is never silently skipped or marked done on failure.
 *
 * @returns {{ migrated: string[], pendingLegacySessions: string[], capacityError: PinnedCapacityError | null, skipped: boolean }}
 */
export function migrateFavourites({
  documentRef = defaultDocument(),
  storageRef = typeof localStorage !== "undefined" ? localStorage : null,
  migratedFlagKey = FAVOURITES_MIGRATED_FLAG,
} = {}) {
  const result = { migrated: [], pendingLegacySessions: [], capacityError: null, skipped: false };

  let alreadyMigrated = false;
  try {
    alreadyMigrated = storageRef?.getItem?.(migratedFlagKey) === "1";
  } catch {
    alreadyMigrated = false;
  }
  if (alreadyMigrated) {
    result.skipped = true;
    return result;
  }

  let raw = null;
  try {
    raw = storageRef?.getItem ? storageRef.getItem(FAVOURITES_STORAGE_KEY) : null;
  } catch {
    raw = null;
  }
  if (raw === null) {
    markMigrated(storageRef, migratedFlagKey);
    return result;
  }

  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  const legacySessions = Array.isArray(parsed)
    ? parsed.filter((session) => typeof session === "string" && session)
    : [];

  if (legacySessions.length === 0) {
    markMigrated(storageRef, migratedFlagKey);
    return result;
  }

  const current = readPinnedItems(documentRef);
  const existing = new Set(current.sessions);
  const toAdd = [];
  for (const session of legacySessions) {
    if (!existing.has(session) && !toAdd.includes(session)) toAdd.push(session);
  }

  if (toAdd.length === 0) {
    markMigrated(storageRef, migratedFlagKey);
    return result;
  }

  const mergedSessions = [...toAdd, ...current.sessions];
  try {
    writePinnedItems({ workspaces: current.workspaces, sessions: mergedSessions }, documentRef);
    markMigrated(storageRef, migratedFlagKey);
    result.migrated = toAdd;
    return result;
  } catch (error) {
    if (error instanceof PinnedCapacityError) {
      result.capacityError = error;
      result.pendingLegacySessions = toAdd;
      return result;
    }
    throw error;
  }
}

function markMigrated(storageRef, migratedFlagKey) {
  try {
    storageRef?.setItem?.(migratedFlagKey, "1");
  } catch {
    // Storage may be unavailable; migration will retry on the next load.
  }
}

// --- Cross-window change detection --------------------------------------

const subscribers = new Set();
let lastCompared = null;
let activeSync = null;

function notifyChanged(state, windowRef) {
  const serialized = serializedForCompare(state);
  if (serialized === lastCompared) return false;
  lastCompared = serialized;
  for (const callback of subscribers) {
    try {
      callback(state);
    } catch {
      // A listener error must not break convergence.
    }
  }
  if (windowRef && typeof windowRef.dispatchEvent === "function") {
    try {
      windowRef.dispatchEvent(new windowRef.CustomEvent(PINNED_ITEMS_EVENT, { detail: state }));
    } catch {
      // Event dispatch is best-effort.
    }
  }
  return true;
}

/**
 * Re-read the cookie and notify subscribers / dispatch the change event if the
 * serialized value changed. Intended to be called before each sidebar render so
 * cross-window updates apply immediately. Returns the current state.
 *
 * `windowRef` defaults to the active sync window (if any) or the global window.
 */
export function refreshPinnedItems(documentRef = defaultDocument(), windowRef = null) {
  const state = readPinnedItems(documentRef);
  notifyChanged(state, windowRef ?? activeSync?.windowRef ?? defaultWindow());
  return state;
}

/**
 * Register a Pin state listener. The callback receives the new normalized state
 * only when the serialized cookie actually changes. Returns an unsubscribe
 * function.
 */
export function subscribePinnedItems(callback) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  if (lastCompared === null) {
    lastCompared = serializedForCompare(readPinnedItems(defaultDocument()));
  }
  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Start cross-window Pin synchronization.
 *
 * Compares the serialized cookie on window focus, on `visibilitychange`, and
 * once per second while the document is visible, dispatching `PINNED_ITEMS_EVENT`
 * and notifying subscribers only when the value changes. Returns a cleanup
 * function that removes listeners and stops polling.
 */
export function startPinnedItemsSync({
  windowRef = defaultWindow(),
  documentRef = defaultDocument(),
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  if (activeSync?.cleanup) activeSync.cleanup();
  activeSync = null;

  let timerId = null;

  const check = () => {
    if (windowRef && documentRef && documentRef.visibilityState === "hidden") return;
    const state = readPinnedItems(documentRef);
    notifyChanged(state, windowRef);
  };

  const onFocus = () => {
    check();
  };
  const onVisibility = () => {
    if (documentRef && documentRef.visibilityState === "visible") check();
  };

  if (windowRef) {
    windowRef.addEventListener("focus", onFocus);
    windowRef.addEventListener("visibilitychange", onVisibility);
  }

  const tick = () => {
    if (documentRef?.visibilityState !== "hidden") check();
    timerId = scheduleNext();
  };
  const scheduleNext = () => {
    if (typeof windowRef?.setTimeout !== "function") return null;
    return windowRef.setTimeout(tick, pollIntervalMs);
  };

  // Seed the baseline so the first change is relative to the initial value.
  lastCompared = serializedForCompare(readPinnedItems(documentRef));

  const cleanup = () => {
    if (timerId !== null && typeof windowRef?.clearTimeout === "function") {
      windowRef.clearTimeout(timerId);
    }
    timerId = null;
    if (windowRef) {
      windowRef.removeEventListener("focus", onFocus);
      windowRef.removeEventListener("visibilitychange", onVisibility);
    }
    if (activeSync?.cleanup === cleanup) {
      activeSync = null;
    }
  };

  activeSync = { windowRef, documentRef, cleanup };
  timerId = scheduleNext();

  return cleanup;
}

/**
 * Reset internal sync bookkeeping. Intended for tests that drive the store
 * against fresh document/window fixtures across cases.
 */
export function resetPinnedItemsSync() {
  subscribers.clear();
  lastCompared = null;
  if (activeSync?.cleanup) activeSync.cleanup();
  activeSync = null;
}
