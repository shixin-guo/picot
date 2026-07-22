// ABOUTME: Provides normalized filesystem containment checks for embedded-server paths.
// ABOUTME: Uses native path semantics and a separator boundary to prevent sibling-prefix escapes.

import * as path from "node:path";

function looksLikeWindowsPath(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(value) ||
    /^\/\/[^/]+\/[^/]+/.test(value)
  );
}

export function isPathWithinRoot(root: string, candidate: string): boolean {
  const useWindowsSemantics = looksLikeWindowsPath(root) || looksLikeWindowsPath(candidate);
  const resolve = useWindowsSemantics ? path.win32.resolve : path.resolve;
  const separator = useWindowsSemantics ? path.win32.sep : path.sep;
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const comparableRoot = useWindowsSemantics ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparableCandidate = useWindowsSemantics
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  return (
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(`${comparableRoot}${separator}`)
  );
}
