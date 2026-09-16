// ABOUTME: Resolves the user's home directory and the pi agent config root.
// ABOUTME: Shared by picot-config and ssh-remote so both agree on one path.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Home-directory candidates in preference order. `HOME` wins over
 * `os.homedir()` so a test (or a sandboxed launch) that overrides the env var
 * is honoured; the Windows pair is checked before falling back to Node's own
 * answer.
 */
export function homeDirCandidates(): string[] {
  const candidates: string[] = [];
  const add = (value?: string) => {
    if (typeof value === "string" && value.trim()) candidates.push(path.resolve(value.trim()));
  };
  add(process.env.HOME);
  add(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    add(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  }
  add(os.homedir());
  return candidates;
}

export function resolveHomeDir(): string {
  return homeDirCandidates()[0] || os.homedir();
}

/** `~/.pi/agent` (or the Windows roaming equivalent) — pi's global config root. */
export function resolvePiAgentRoot(): string {
  const candidates = homeDirCandidates();
  for (const home of candidates) {
    const candidate = path.join(home, ".pi", "agent");
    if (fs.existsSync(candidate)) return candidate;
  }
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.trim()) {
    const roaming = path.join(path.resolve(appData), "pi", "agent");
    if (fs.existsSync(roaming)) return roaming;
  }
  return path.join(candidates[0] || os.homedir(), ".pi", "agent");
}
