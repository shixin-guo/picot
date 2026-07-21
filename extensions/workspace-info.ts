// ABOUTME: Resolves trusted workspace identities and inspects bounded local Git metadata.
// ABOUTME: Prevents request-provided filesystem paths and unbounded Git subprocess work.

import { execFile } from "node:child_process";
import { basename, isAbsolute, normalize, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;
export type WorkspaceProjectRef = { dirName: string; path: string };
export type RunningInstanceRef = { cwd: string; startedAt?: string };
export type WorkspaceGitInfo = {
  isGit: boolean;
  repository?: string;
  kind?: "repository" | "worktree";
  branch?: string | null;
  detachedAt?: string | null;
};
export type GitCommandRunner = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; signal: AbortSignal },
) => Promise<{ stdout: string }>;
type AbortSource = {
  signal?: AbortSignal;
  once?: (event: string, listener: () => void) => unknown;
  removeListener?: (event: string, listener: () => void) => unknown;
};

/**
 * Propagates request cancellation to a workspace Git operation across both
 * Node's EventEmitter HTTP server and Bun's Fetch-based request adapter.
 */
export function observeWorkspaceInfoAbort(
  controller: AbortController,
  request: AbortSource,
  response: AbortSource,
) {
  const abort = () => controller.abort();
  const cleanups: Array<() => void> = [];

  if (request.signal?.aborted) {
    abort();
  } else if (request.signal) {
    request.signal.addEventListener("abort", abort, { once: true });
    cleanups.push(() => request.signal?.removeEventListener("abort", abort));
  }
  for (const [source, event] of [
    [request, "aborted"],
    [response, "close"],
  ] as const) {
    if (typeof source.once !== "function") continue;
    source.once(event, abort);
    if (typeof source.removeListener === "function") {
      cleanups.push(() => source.removeListener?.(event, abort));
    }
  }

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function normalizePath(value: string) {
  if (!isAbsolute(value)) return "";
  return normalize(resolve(value));
}
export function resolveWorkspaceInfoPath(
  workspaceId: string,
  projects: WorkspaceProjectRef[] = [],
  instances: RunningInstanceRef[] = [],
) {
  if (typeof workspaceId !== "string") return null;
  if (workspaceId.startsWith("history:"))
    return projects.find((p) => `history:${p.dirName}` === workspaceId)?.path ?? null;
  if (workspaceId.startsWith("path:")) {
    const requested = workspaceId.slice(5);
    return instances.find((i) => normalizePath(i.cwd) === normalizePath(requested))?.cwd ?? null;
  }
  return null;
}
export function parseRepositoryName(remoteUrl: string, repositoryRoot: string) {
  if (typeof remoteUrl !== "string" || !remoteUrl.trim()) return basename(repositoryRoot);
  let value = remoteUrl.trim().replace(/\.git\/?$/, "");
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      value = url.pathname.replace(/^\/+/, "");
    } catch {
      return basename(repositoryRoot);
    }
  } else if (value.includes(":") && !value.startsWith("/")) {
    // URL forms are handled first, so this branch only parses SCP-like remotes.
    value = value.slice(value.indexOf(":") + 1);
  }
  value = value.replace(/^.*@[^:]+:/, "").replace(/^\/+/, "");
  const parts = value.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts.at(-2)}/${parts.at(-1)}` : basename(repositoryRoot);
}
async function runDefault(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; maxBuffer: number; signal: AbortSignal },
) {
  return execFileAsync("git", args, options) as Promise<{ stdout: string }>;
}
export async function inspectWorkspaceGit(
  cwd: string,
  options: { signal?: AbortSignal; runGit?: GitCommandRunner; timeoutMs?: number } = {},
): Promise<WorkspaceGitInfo> {
  const runGit = options.runGit || runDefault;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const forward = () => controller.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  try {
    const command = async (args: string[]) =>
      (
        await runGit(args, { cwd, env, maxBuffer: MAX_BUFFER, signal: controller.signal })
      ).stdout.trim();
    let root: string;
    try {
      root = await command(["rev-parse", "--show-toplevel"]);
    } catch {
      return { isGit: false };
    }
    const gitDir = normalizePath(await command(["rev-parse", "--git-dir"]));
    const commonDir = normalizePath(await command(["rev-parse", "--git-common-dir"]));
    let branch: string | null = null;
    try {
      branch = await command(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    } catch {}
    let detachedAt: string | null = null;
    if (!branch) {
      try {
        detachedAt = await command(["rev-parse", "--short", "HEAD"]);
      } catch {}
    }
    let repository: string | undefined;
    try {
      const names = (await command(["remote"])).split(/\s+/).filter(Boolean).sort();
      const selected = names.includes("origin") ? "origin" : names[0];
      if (selected)
        repository = parseRepositoryName(await command(["remote", "get-url", selected]), root);
    } catch {
      repository = basename(root);
    }
    return {
      isGit: true,
      repository: repository || basename(root),
      kind: gitDir && commonDir && gitDir !== commonDir ? "worktree" : "repository",
      branch,
      detachedAt,
    };
  } catch (_error) {
    if (controller.signal.aborted) throw new Error("workspace_metadata_aborted");
    throw new Error("workspace_metadata_failed");
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forward);
  }
}
