// ABOUTME: Normalizes local filesystem paths for browser-side workspace features.
// ABOUTME: Preserves POSIX, Windows drive, and UNC roots without using the host OS APIs.

function parseRoot(value) {
  if (value.startsWith("//")) {
    const parts = value.slice(2).split("/").filter(Boolean);
    if (parts.length >= 2) return { root: `//${parts[0]}/${parts[1]}`, rest: parts.slice(2) };
    if (parts.length === 1) return { root: `//${parts[0]}`, rest: [] };
    return { root: "//", rest: [] };
  }
  if (/^[A-Za-z]:\//.test(value))
    return { root: value.slice(0, 3), rest: value.slice(3).split("/") };
  if (value.startsWith("/")) return { root: "/", rest: value.slice(1).split("/") };
  return { root: "", rest: value.split("/") };
}

function normalizedParts(value) {
  const slashPath = value.replaceAll("\\", "/");
  const { root, rest } = parseRoot(slashPath);
  const parts = [];
  for (const part of rest) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.at(-1) && parts.at(-1) !== "..") {
      parts.pop();
    } else if (part !== ".." || !root) {
      parts.push(part);
    }
  }
  return { root, parts };
}

function joinRoot(root, parts) {
  const body = parts.join("/");
  if (root === "/") return body ? `/${body}` : "/";
  if (root.endsWith("/")) return body ? `${root}${body}` : root;
  if (root) return body ? `${root}/${body}` : root;
  return body;
}

export function normalizeLocalPath(value) {
  if (typeof value !== "string") return "";
  const { root, parts } = normalizedParts(value.trim());
  return joinRoot(root, parts);
}

export function basenameLocalPath(value) {
  const normalized = normalizeLocalPath(value);
  if (!normalized || normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  const uncRoot = normalized.match(/^\/\/[^/]+\/[^/]+$/)?.[0];
  if (uncRoot) return uncRoot;
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function parentLocalPath(value) {
  const normalized = normalizeLocalPath(value);
  if (!normalized || normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  const { root, parts } = normalizedParts(normalized);
  if (parts.length === 0) return root;
  return joinRoot(root, parts.slice(0, -1));
}
