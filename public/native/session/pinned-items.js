// ABOUTME: Persists ordered workspace and session Pins in host-owned localStorage.
// ABOUTME: Owns capacity checks, legacy Favourites migration, and change detection.
/**
 * Pinned Items - v1 localStorage store for workspace/session Pins.
 *
 * Owns parsing, normalization, deduplication, capacity-bounded writes,
 * Favourites migration, and change detection. The store is keyed by
 * `project.path` (workspace) and `session.id` (session) - both stable for
 * the current session lifetime; restart-fresh ids invalidate the pin, by
 * design, matching the lifetime of `favourites` / `archived` lists.
 *
 * Mutations read the newest storage value immediately before rewriting so
 * concurrent tabs converge. Pins never evict: a mutation that would exceed
 * MAX_PINNED_ITEMS is rejected with a typed error and the existing storage
 * value is preserved.
 */

export const PINNED_ITEMS_KEY = "picot-pinned-items";
export const PINNED_ITEMS_EVENT = "picot:pinned-items-change";
export const FAVOURITES_STORAGE_KEY = "pi-studio-favourites";
export const FAVOURITES_MIGRATED_FLAG = "picot-pinned-favourites-migrated";
// Total cap across both workspaces and sessions. Replaces the byte-based
// cookie cap from feature-v3 - localStorage has no per-key size limit that
// matters here, but a flat item cap keeps the sidebar section scannable.
export const MAX_PINNED_ITEMS = 20;
export const PINNED_SCHEMA_VERSION = 1;

function defaultStorage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function defaultWindow() {
  return typeof window !== "undefined" ? window : null;
}

/**
 * Error thrown when a mutation would exceed the item-count limit. The
 * existing storage value is left untouched; `previousState` holds the last
 * committed state so callers can render localized feedback without losing data.
 */
export class PinnedCapacityError extends Error {
  constructor(message, context = {}) {
    super(message);
    this.name = "PinnedCapacityError";
    this.attemptedCount = context.attemptedCount ?? 0;
    this.limitCount = context.limitCount ?? MAX_PINNED_ITEMS;
    this.previousState = context.previousState ?? { workspaces: [], sessions: [] };
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, PinnedCapacityError);
    }
  }
}

// Normalize a workspace pin record. In the native arch the workspace key
// is the on-disk `project.path` - it serves as both identity and display
// path, and there is no separate stable history id.
function normalizeWorkspaceRecord(record) {
  if (!record || typeof record !== "object") return null;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return null;
  return { id: path, path };
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

// Item-count cap replaces the byte-length cap from the cookie-based original.
// The flat MAX_PINNED_ITEMS budget covers both workspaces and sessions so
// neither dimension can crowd out the other.
function itemCount(state) {
  return (state.workspaces?.length ?? 0) + (state.sessions?.length ?? 0);
}

function readStorageValue(storageRef) {
  try {
    const raw = storageRef?.getItem?.(PINNED_ITEMS_KEY);
    return raw ?? null;
  } catch {
    // localStorage access can fail in sandboxed or disabled contexts.
  }
  return null;
}

/**
 * Read and normalize the current Pin cookie. Malformed cookies resolve to an
 * empty state so the UI stays usable and recoverable.
 */
export function readPinnedItems(storageRef = defaultStorage()) {
  const value = readStorageValue(storageRef);
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
 * Reads the newest storage value immediately before writing, skips a no-op
 * write, and rejects — without eviction — when the item count would exceed
 * MAX_PINNED_ITEMS. The previous committed state is attached to the
 * capacity error so callers can recover gracefully.
 */
export function writePinnedItems(nextState, storageRef = defaultStorage()) {
  const normalized = normalizePinnedState(nextState);
  const current = readPinnedItems(storageRef);
  if (samePinnedState(current, normalized)) return normalized;

  const attemptedCount = itemCount(normalized);
  if (attemptedCount > MAX_PINNED_ITEMS) {
    throw new PinnedCapacityError("Pin list would exceed the maximum item count", {
      attemptedCount,
      limitCount: MAX_PINNED_ITEMS,
      previousState: current,
    });
  }

  try {
    const value = JSON.stringify(serializeState(normalized));
    storageRef?.setItem?.(PINNED_ITEMS_KEY, value);
  } catch {
    // Keep `normalized` as the caller's in-memory state.
  }
  // Notify subscribers so a sidebar wired via `pinnedStore.subscribe`
  // re-renders without a manual `render()` call. The store wrapper
  // (createPinnedItemsStore) maintains its own emit; this is the
  // lightweight version used by the top-level pin*/unpin*/migrate
  // helpers, which do not allocate a full store.
  notifyChanged(normalized, defaultWindow());
  return normalized;
}

function withWorkspace(storageRef, updater) {
  const current = readPinnedItems(storageRef);
  const workspaces = updater(current.workspaces);
  return writePinnedItems({ workspaces, sessions: current.sessions }, storageRef);
}

function withSessions(storageRef, updater) {
  const current = readPinnedItems(storageRef);
  const sessions = updater(current.sessions);
  return writePinnedItems({ workspaces: current.workspaces, sessions }, storageRef);
}

/**
 * Pin a workspace. New pins appear first; an existing record with the same id is
 * replaced (display path refreshed) at the front. Reads the newest cookie first.
 */
export function pinWorkspace(id, path, storageRef = defaultStorage()) {
  const record = normalizeWorkspaceRecord({ id, path });
  if (!record) return readPinnedItems(storageRef);
  return withWorkspace(storageRef, (workspaces) => [
    record,
    ...workspaces.filter((workspace) => workspace.id !== record.id),
  ]);
}

/** Remove a workspace pin by id. Reads the newest cookie first. */
export function unpinWorkspace(id, storageRef = defaultStorage()) {
  if (typeof id !== "string" || !id) return readPinnedItems(storageRef);
  return withWorkspace(storageRef, (workspaces) =>
    workspaces.filter((workspace) => workspace.id !== id),
  );
}

/** Pin a session file path. New pins appear first. Reads the newest cookie first. */
export function pinSession(sessionId, storageRef = defaultStorage()) {
  if (typeof sessionId !== "string" || !sessionId) return readPinnedItems(storageRef);
  return withSessions(storageRef, (sessions) => [
    sessionId,
    ...sessions.filter((session) => session !== sessionId),
  ]);
}

/** Remove a session pin by file path. Reads the newest cookie first. */
export function unpinSession(sessionId, storageRef = defaultStorage()) {
  if (typeof sessionId !== "string" || !sessionId) return readPinnedItems(storageRef);
  return withSessions(storageRef, (sessions) =>
    sessions.filter((session) => session !== sessionId),
  );
}

/**
 * Replace a provisional workspace id (e.g. `path:<normalized>`) with its stable
 * history id (e.g. `history:<dirName>`) once a history project resolves to the
 * same workspace. Position and display path are preserved. If the target id
 * already exists, the provisional entry is simply dropped to avoid a duplicate.
 * Reads the newest cookie first.
 */
export function reconcileWorkspaceId(oldId, newId, storageRef = defaultStorage()) {
  if (typeof oldId !== "string" || !oldId || typeof newId !== "string" || !newId) {
    return readPinnedItems(storageRef);
  }
  return withWorkspace(storageRef, (workspaces) => {
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
  storageRef = defaultStorage(),
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

  const current = readPinnedItems(storageRef);
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
    writePinnedItems({ workspaces: current.workspaces, sessions: mergedSessions }, storageRef);
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
export function refreshPinnedItems(storageRef = defaultStorage(), windowRef = null) {
  const state = readPinnedItems(storageRef);
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
    lastCompared = serializedForCompare(readPinnedItems(defaultStorage()));
  }
  return () => {
    subscribers.delete(callback);
  };
}

/**
 * Start cross-window Pin synchronization.
 *
 * Re-reads storage on window focus and on `visibilitychange` (when becoming
 * visible), dispatching `PINNED_ITEMS_EVENT` and notifying subscribers only
 * when the value changes. Returns a cleanup function that removes listeners.
 *
 * Unlike the feature-v3 cookie-based version, no setInterval polling is
 * started – localStorage is per-origin in this Tauri webview, so concurrent
 * writers are not a concern. Callers can trigger an immediate refresh via
 * `refreshPinnedItems()` after any in-process mutation.
 */
export function startPinnedItemsSync({
  windowRef = defaultWindow(),
  documentRef = typeof document !== "undefined" ? document : null,
  storageRef = defaultStorage(),
} = {}) {
  if (activeSync?.cleanup) activeSync.cleanup();
  activeSync = null;

  const check = () => {
    if (documentRef && documentRef.visibilityState === "hidden") return;
    const state = readPinnedItems(storageRef);
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

  // Seed the baseline so the first change is relative to the initial value.
  lastCompared = serializedForCompare(readPinnedItems(storageRef));

  const cleanup = () => {
    if (windowRef) {
      windowRef.removeEventListener("focus", onFocus);
      windowRef.removeEventListener("visibilitychange", onVisibility);
    }
    if (activeSync?.cleanup === cleanup) {
      activeSync = null;
    }
  };

  activeSync = { windowRef, documentRef, storageRef, cleanup };

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

export function createPinnedItemsStore(options = {}) {
  const storageRef = options.storageRef ?? options.storage ?? defaultStorage();
  const windowRef = options.windowRef ?? options.window ?? defaultWindow();
  let destroyed = false;
  let legacyPending = [];
  const listeners = new Set();
  let state = readPinnedItems(storageRef);
  const snapshot = () => ({
    workspaces: state.workspaces.map((item) => ({ ...item })),
    sessions: [...state.sessions],
  });
  const emit = (next) => {
    const before = JSON.stringify(state);
    state = next;
    if (before === JSON.stringify(next)) return false;
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {}
    }
    return true;
  };
  const mutate = (operation) => {
    if (destroyed) return { ok: false, error: "write", state: snapshot(), changed: false };
    try {
      const current = readPinnedItems(storageRef);
      const next = operation(current);
      const written = writePinnedItems(next, storageRef);
      const changed = emit(written);
      return { ok: true, changed, state: snapshot() };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof PinnedCapacityError ? "capacity" : "write",
        state: snapshot(),
        changed: false,
      };
    }
  };
  const refreshFromStorage = () => {
    const next = readPinnedItems(storageRef);
    emit(next);
    return snapshot();
  };
  const onFocus = refreshFromStorage;
  const onVisibility = () => {
    if (refreshFromStorage) refreshFromStorage();
  };
  windowRef?.addEventListener?.("focus", onFocus);
  windowRef?.addEventListener?.("visibilitychange", onVisibility);
  return {
    getState: snapshot,
    getRenderableState: () => ({
      ...snapshot(),
      sessions: [...state.sessions, ...legacyPending.filter((id) => !state.sessions.includes(id))],
    }),
    hasMigrationError: () => legacyPending.length > 0,
    isWorkspacePinned: (id) => state.workspaces.some((item) => item.id === id),
    isSessionPinned: (sessionId) => state.sessions.includes(sessionId),
    refresh: () => {
      const before = JSON.stringify(state);
      const next = readPinnedItems(storageRef);
      const changed = before !== JSON.stringify(next);
      if (changed) emit(next);
      return changed;
    },
    pinWorkspace: (idOrRecord, path) => {
      const id = typeof idOrRecord === "object" ? idOrRecord?.id : idOrRecord;
      const workspacePath = typeof idOrRecord === "object" ? idOrRecord?.path : path;
      if (typeof id !== "string" || !id || typeof workspacePath !== "string" || !workspacePath)
        return { ok: false, error: "invalid", state: snapshot() };
      return mutate((current) => ({
        workspaces: [
          { id, path: workspacePath },
          ...current.workspaces.filter((item) => item.id !== id),
        ],
        sessions: current.sessions,
      }));
    },
    unpinWorkspace: (id) =>
      mutate((current) => ({
        workspaces: current.workspaces.filter((item) => item.id !== id),
        sessions: current.sessions,
      })),
    pinSession: (sessionId) => {
      if (typeof sessionId !== "string" || !sessionId)
        return { ok: false, error: "invalid", state: snapshot() };
      return mutate((current) => ({
        workspaces: current.workspaces,
        sessions: [sessionId, ...current.sessions.filter((item) => item !== sessionId)],
      }));
    },
    unpinSession: (sessionId) =>
      mutate((current) => ({
        workspaces: current.workspaces,
        sessions: current.sessions.filter((item) => item !== sessionId),
      })),
    reconcileWorkspace: ({ fromId, toId, path }) =>
      mutate((current) => {
        const index = current.workspaces.findIndex((item) => item.id === fromId);
        if (index < 0) return current;
        const workspaces = current.workspaces.slice();
        workspaces[index] = { id: toId, path: path || workspaces[index].path };
        return { workspaces, sessions: current.sessions };
      }),
    replaceWorkspaceId: (fromId, toId) =>
      mutate((current) => {
        const index = current.workspaces.findIndex((item) => item.id === fromId);
        if (index < 0) return current;
        const workspaces = current.workspaces.slice();
        workspaces[index] = { ...workspaces[index], id: toId };
        return { workspaces, sessions: current.sessions };
      }),
    migrateLegacyFavourites: ({ excludedSessions = [] } = {}) => {
      const result = migrateFavourites({ storageRef });
      legacyPending = (result.pendingLegacySessions || []).filter(
        (id) => !excludedSessions.includes(id),
      );
      if (result.capacityError) return { ok: false, error: "capacity", state: snapshot() };
      refreshFromStorage();
      return { ok: true, state: snapshot() };
    },
    retryMigration: () => {
      const result = migrateFavourites({ storageRef });
      legacyPending = result.pendingLegacySessions || [];
      refreshFromStorage();
      return result;
    },
    refreshFromStorage,
    subscribe: (listener) => {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: () => {
      destroyed = true;
      windowRef?.removeEventListener?.("focus", onFocus);
      windowRef?.removeEventListener?.("visibilitychange", onVisibility);
      listeners.clear();
    },
  };
}
