export const RECENT_SESSIONS_COOKIE = "picot-recent-sessions";
export const MAX_RECENT_SESSIONS = 5;

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10;
const MAX_ENCODED_VALUE_LENGTH = 3800;

function normalizeRecentSessions(paths) {
  if (!Array.isArray(paths)) return [];

  const seen = new Set();
  const normalized = [];
  for (const path of paths) {
    if (typeof path !== "string" || !path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
    if (normalized.length === MAX_RECENT_SESSIONS) break;
  }
  return normalized;
}

function getCookieValue(documentRef) {
  try {
    const entries = documentRef?.cookie ? documentRef.cookie.split("; ") : [];
    for (const entry of entries) {
      const separator = entry.indexOf("=");
      if (separator === -1 || entry.slice(0, separator) !== RECENT_SESSIONS_COOKIE) {
        continue;
      }

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

export function readRecentSessions(documentRef = document) {
  const value = getCookieValue(documentRef);
  if (!value) return [];

  try {
    return normalizeRecentSessions(JSON.parse(value));
  } catch {
    return [];
  }
}

function encodedValueLength(paths) {
  return encodeURIComponent(JSON.stringify(paths)).length;
}

function boundForCookie(paths) {
  const individuallyFitting = Array.isArray(paths)
    ? paths.filter(
        (path) =>
          typeof path === "string" &&
          path.length > 0 &&
          encodedValueLength([path]) <= MAX_ENCODED_VALUE_LENGTH,
      )
    : [];
  const bounded = normalizeRecentSessions(individuallyFitting);
  while (bounded.length > 0 && encodedValueLength(bounded) > MAX_ENCODED_VALUE_LENGTH) {
    bounded.pop();
  }
  return bounded;
}

export function writeRecentSessions(paths, documentRef = document) {
  const next = boundForCookie(paths);
  const current = readRecentSessions(documentRef);
  if (JSON.stringify(current) === JSON.stringify(next)) return next;

  try {
    const value = encodeURIComponent(JSON.stringify(next));
    documentRef.cookie = `${RECENT_SESSIONS_COOKIE}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // Keep `next` as the caller's in-memory order.
  }
  return next;
}

export function recordRecentSession(filePath, documentRef = document) {
  const current = readRecentSessions(documentRef);
  if (typeof filePath !== "string" || !filePath) return current;

  return writeRecentSessions(
    [filePath, ...current.filter((path) => path !== filePath)],
    documentRef,
  );
}
