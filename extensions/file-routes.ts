/**
 * File route helpers for the file preview/editor panel.
 *
 * These functions provide path safety, file classification, text reading with
 * size limits, and conditional write with mtime-based conflict detection.
 * They are consumed by the HTTP route handlers in embedded-server.ts.
 */
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";

// ─── Types ──────────────────────────────────────────────────────────────

type CtxLike = { cwd?: string } | null;

export type Scope = "workspace" | "picker";

export type ResolveResult =
  | { ok: true; path: string }
  | { ok: false; code: "outsideWorkspace" | "invalidPath" };

export type FileClassification = {
  mimeType: string;
  kind: "text" | "image" | "pdf" | "binary";
  editable: boolean;
};

export type ReadResult = {
  content: string;
  size: number;
  mtimeMs: number;
  truncated: boolean;
  isBinary: boolean;
  mimeType: string;
};

export type WriteResult =
  | { success: true; size: number; mtimeMs: number }
  | { success: false; code: "conflict" | "invalid" };

// ─── Constants ──────────────────────────────────────────────────────────

const TEXT_READ_LIMIT = 2 * 1024 * 1024; // 2 MiB
const EDIT_SIZE_LIMIT = 1 * 1024 * 1024; // 1 MiB
const BINARY_PREFIX_BYTES = 512;

const IMAGE_EXTENSIONS: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

const TEXT_MIME_BY_EXT: Record<string, string> = {
  js: "text/javascript",
  jsx: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  mts: "text/typescript",
  cts: "text/typescript",
  json: "application/json",
  jsonc: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "application/toml",
  xml: "text/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  scss: "text/css",
  sass: "text/css",
  less: "text/css",
  md: "text/markdown",
  markdown: "text/markdown",
  mdown: "text/markdown",
  mkd: "text/markdown",
  txt: "text/plain",
  rst: "text/plain",
  py: "text/x-python",
  pyw: "text/x-python",
  pyi: "text/x-python",
  r: "text/x-r-source",
  R: "text/x-r-source",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  hpp: "text/x-c++",
  cc: "text/x-c++",
  sh: "application/x-sh",
  bash: "application/x-sh",
  zsh: "application/x-sh",
  sql: "application/sql",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  log: "text/plain",
  env: "text/plain",
  conf: "text/plain",
  ini: "text/plain",
  cfg: "text/plain",
  diff: "text/x-diff",
  patch: "text/x-diff",
};

// ─── Workspace root resolution ──────────────────────────────────────────

export function resolveWorkspaceRoot(ctx: CtxLike, fallbackCwd: string): string {
  const cwd = ctx?.cwd || fallbackCwd;
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * Canonicalize a workspace root path via realpath for consistent comparison.
 */
function canonicalizeRoot(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

// ─── Scoped path resolution ─────────────────────────────────────────────

export function resolveScopedFilePath(
  requestedPath: unknown,
  scope: Scope,
  workspaceRoot: string,
): ResolveResult {
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    return { ok: false, code: "invalidPath" };
  }

  const resolved = path.resolve(requestedPath);

  if (scope === "picker") {
    return { ok: true, path: resolved };
  }

  // Workspace scope: must be inside workspaceRoot after realpath resolution.
  let realPath: string;
  try {
    if (fs.existsSync(resolved)) {
      realPath = fs.realpathSync(resolved);
    } else {
      // For non-existent files (e.g. new writes), resolve the parent and append.
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        realPath = path.join(fs.realpathSync(parent), path.basename(resolved));
      } else {
        return { ok: false, code: "outsideWorkspace" };
      }
    }
  } catch {
    return { ok: false, code: "invalidPath" };
  }

  const normalizedRoot = canonicalizeRoot(workspaceRoot);
  const sep = path.sep;

  if (realPath === normalizedRoot || realPath.startsWith(`${normalizedRoot}${sep}`)) {
    return { ok: true, path: resolved };
  }

  return { ok: false, code: "outsideWorkspace" };
}

// ─── File classification ────────────────────────────────────────────────

function getExtension(filePath: string): string {
  const basename = filePath.split("/").pop() || filePath;
  const idx = basename.lastIndexOf(".");
  if (idx <= 0) return ""; // No extension or dotfile without extension
  return basename.slice(idx + 1);
}

function isBinaryByPrefix(prefix: Buffer): boolean {
  // NUL byte in the first chunk is a strong signal of binary content.
  const checkLen = Math.min(prefix.length, BINARY_PREFIX_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (prefix[i] === 0) return true;
  }
  return false;
}

export function classifyFile(filePath: string, prefix: Buffer): FileClassification {
  const ext = getExtension(filePath).toLowerCase();

  // PDF: check by extension AND content header.
  if (ext === "pdf" || prefix.toString("ascii", 0, Math.min(5, prefix.length)).startsWith("%PDF")) {
    return { mimeType: "application/pdf", kind: "pdf", editable: false };
  }

  // Image: check by extension.
  if (ext && IMAGE_EXTENSIONS[ext]) {
    return { mimeType: IMAGE_EXTENSIONS[ext], kind: "image", editable: false };
  }

  // Binary detection by NUL byte.
  if (isBinaryByPrefix(prefix)) {
    return { mimeType: "application/octet-stream", kind: "binary", editable: false };
  }

  // Text file.
  const mimeType = TEXT_MIME_BY_EXT[ext] || "text/plain";
  return { mimeType, kind: "text", editable: true };
}

/**
 * Determine if a text file is editable based on its size.
 * Files between 1 MiB and 2 MiB are read-only preview only.
 */
export function isEditableBySize(size: number): boolean {
  return size <= EDIT_SIZE_LIMIT;
}

// ─── Text file reading ──────────────────────────────────────────────────

export function readTextFileForPreview(filePath: string): ReadResult {
  const stat = fs.statSync(filePath);
  const size = stat.size;

  const readLen = Math.min(size, TEXT_READ_LIMIT);
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(readLen);
    const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
    const actualBuf = buf.subarray(0, bytesRead);
    const truncated = size > TEXT_READ_LIMIT;
    const content = actualBuf.toString("utf-8");
    const isBinary = isBinaryByPrefix(actualBuf);
    const ext = getExtension(filePath).toLowerCase();
    const mimeType = TEXT_MIME_BY_EXT[ext] || "text/plain";

    return {
      content,
      size,
      mtimeMs: stat.mtimeMs,
      truncated,
      isBinary,
      mimeType,
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Conditional write ──────────────────────────────────────────────────

export function writeTextFileIfUnchanged(
  filePath: string,
  content: string,
  expectedMtimeMs: number,
): WriteResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { success: false, code: "invalid" };
  }

  if (!stat.isFile()) {
    return { success: false, code: "invalid" };
  }

  // mtime conflict check (allow 1ms tolerance for filesystem precision)
  if (Number.isFinite(expectedMtimeMs) && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
    return { success: false, code: "conflict" };
  }

  fs.writeFileSync(filePath, content, "utf-8");

  const newStat = fs.statSync(filePath);
  return {
    success: true,
    size: newStat.size,
    mtimeMs: newStat.mtimeMs,
  };
}

// ─── HTTP response helpers ──────────────────────────────────────────────

export function sendJsonError(
  res: http.ServerResponse,
  statusCode: number,
  error: string,
  code?: string,
): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  const body: Record<string, string> = { error };
  if (code) body.code = code;
  res.end(JSON.stringify(body));
}

export function sendJsonOk(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
