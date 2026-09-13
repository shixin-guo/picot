// ABOUTME: Delegates read/write/edit/bash tool execution to a remote host over SSH.
// ABOUTME: A project binds to a host (inline, or by alias into the global registry).

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import { resolveHomeDir, resolvePiAgentRoot } from "./pi-agent-paths";

export type SshRemoteSettings = {
  enabled: boolean;
  host: string;
  port?: number;
  user?: string;
  remotePath?: string;
  identityFile?: string;
  /**
   * Alias into the global `sshHosts` registry. When set, the connection fields
   * (host/port/user/identityFile) live once in `~/.pi/agent/settings.json` and
   * the project only records which host it is bound to plus its remote path,
   * so a second project on the same machine needs no re-typed credentials.
   */
  hostRef?: string;
};

/** One entry of the global `sshHosts` registry: connection only, no project binding. */
export type SshHostEntry = {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
};

/** A `Host` block parsed out of the user's `~/.ssh/config`. */
export type SshConfigHost = SshHostEntry & { alias: string };

export const DEFAULT_SSH_REMOTE_SETTINGS: SshRemoteSettings = { enabled: false, host: "" };

const SSH_CONNECT_TIMEOUT_SECONDS = 8;
const PROJECT_CONFIG_DIR_NAME = ".pi";

function globalSettingsPath(): string {
  return path.join(resolvePiAgentRoot(), "settings.json");
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Read the `sshRemote` binding from `<cwd>/.pi/settings.json` exactly as
 * stored — a `hostRef` is NOT resolved here. Missing/invalid data reads as
 * disabled. Use `readResolvedProjectSshRemoteSettings` to get a connectable
 * settings object.
 */
export function readProjectSshRemoteSettings(cwd: string): SshRemoteSettings {
  const settingsPath = path.join(cwd, PROJECT_CONFIG_DIR_NAME, "settings.json");
  const settings = readJsonObject(settingsPath);
  if (!("sshRemote" in settings)) return DEFAULT_SSH_REMOTE_SETTINGS;
  return parseSshRemoteSettings(settings.sshRemote);
}

/** Normalize one entry of the global `sshHosts` registry. Never throws. */
export function parseSshHostEntry(value: unknown): SshHostEntry {
  const settings = parseSshRemoteSettings(value);
  return {
    host: settings.host,
    ...(settings.port !== undefined ? { port: settings.port } : {}),
    ...(settings.user ? { user: settings.user } : {}),
    ...(settings.identityFile ? { identityFile: settings.identityFile } : {}),
  };
}

/** Normalize a whole `sshHosts` map, dropping entries without a host. */
export function parseSshHosts(value: unknown): Record<string, SshHostEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const hosts: Record<string, SshHostEntry> = {};
  for (const [alias, raw] of Object.entries(value as Record<string, unknown>)) {
    const trimmedAlias = alias.trim();
    if (!trimmedAlias) continue;
    const entry = parseSshHostEntry(raw);
    if (entry.host) hosts[trimmedAlias] = entry;
  }
  return hosts;
}

/** Read the shared host registry from `~/.pi/agent/settings.json`. */
export function readGlobalSshHosts(): Record<string, SshHostEntry> {
  return parseSshHosts(readJsonObject(globalSettingsPath()).sshHosts);
}

/**
 * Merge a project binding with the global registry. A `hostRef` supplies the
 * connection fields; anything the project still sets inline wins, so a project
 * can override (say) the port of a shared host without cloning the entry.
 */
export function resolveSshRemoteSettings(
  binding: SshRemoteSettings,
  hosts: Record<string, SshHostEntry>,
): SshRemoteSettings {
  const entry = binding.hostRef ? hosts[binding.hostRef] : undefined;
  if (!entry) return binding;
  const host = binding.host || entry.host;
  const port = binding.port ?? entry.port;
  const user = binding.user || entry.user;
  const identityFile = binding.identityFile || entry.identityFile;
  return {
    enabled: binding.enabled,
    host,
    hostRef: binding.hostRef,
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(binding.remotePath ? { remotePath: binding.remotePath } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

/** The settings a session should actually connect with, registry applied. */
export function readResolvedProjectSshRemoteSettings(cwd: string): SshRemoteSettings {
  return resolveSshRemoteSettings(readProjectSshRemoteSettings(cwd), readGlobalSshHosts());
}

/** Normalize arbitrary stored/incoming JSON into settings. Never throws. */
export function parseSshRemoteSettings(value: unknown): SshRemoteSettings {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const host = typeof raw.host === "string" ? raw.host.trim() : "";
  const user = typeof raw.user === "string" ? raw.user.trim() : "";
  const remotePath = typeof raw.remotePath === "string" ? raw.remotePath.trim() : "";
  const identityFile = typeof raw.identityFile === "string" ? raw.identityFile.trim() : "";
  const hostRef = typeof raw.hostRef === "string" ? raw.hostRef.trim() : "";
  const port =
    typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
      ? raw.port
      : undefined;
  return {
    enabled: raw.enabled === true,
    host,
    ...(hostRef ? { hostRef } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(remotePath ? { remotePath } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

/**
 * Shape the binding for `.pi/settings.json`. A `hostRef` binding deliberately
 * drops the connection fields: the registry owns them, and duplicating a key
 * path or username into every project is exactly what the alias avoids.
 */
export function serializeSshRemoteSettings(settings: SshRemoteSettings): Record<string, unknown> {
  if (settings.hostRef) {
    return {
      enabled: settings.enabled,
      hostRef: settings.hostRef,
      ...(settings.remotePath ? { remotePath: settings.remotePath } : {}),
    };
  }
  const { hostRef: _hostRef, ...inline } = settings;
  return { ...inline };
}

/** Throws when settings cannot be enabled as-is (missing host). Call before persisting. */
export function assertSshRemoteSettingsValid(settings: SshRemoteSettings): void {
  if (settings.enabled && !settings.host && !settings.hostRef) {
    throw new Error("Host is required when SSH remote execution is enabled");
  }
}

/**
 * POSIX single-quote a shell argument for interpolation into a remote command
 * string. The pi-coding-agent SSH example JSON.stringify()s paths instead,
 * which is unsafe: bash still expands `$(...)`/backticks inside double
 * quotes, so a file path containing them would execute on the remote host.
 * Single-quoting disables all expansion.
 */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function sshTarget(settings: SshRemoteSettings): string {
  return settings.user ? `${settings.user}@${settings.host}` : settings.host;
}

function sshArgs(settings: SshRemoteSettings, remoteCommand: string): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    // BatchMode disables the interactive host-key prompt, so an unknown host
    // would otherwise fail outright; accept-new still rejects a *changed*
    // key on a host we've already connected to.
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (settings.port) args.push("-p", String(settings.port));
  if (settings.identityFile) args.push("-i", settings.identityFile);
  args.push(sshTarget(settings), remoteCommand);
  return args;
}

/** Run a command on the remote host, optionally piping `input` to its stdin. */
export function sshExec(
  settings: SshRemoteSettings,
  remoteCommand: string,
  options: { input?: Buffer } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", sshArgs(settings, remoteCommand), {
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => errChunks.push(data));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`SSH command failed (exit ${code}): ${stderr || "no output"}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
}

/**
 * Parse `Host` blocks out of an OpenSSH client config. Wildcard patterns
 * (`Host *`, `Host prod-?`) are skipped: they are defaults for other hosts,
 * not connectable targets. `Include` directives are not followed — the picker
 * offers these as suggestions, and anything missing can still be typed by hand.
 */
export function parseSshConfigHosts(text: string): SshConfigHost[] {
  const hosts: SshConfigHost[] = [];
  let current: SshConfigHost | null = null;
  const flush = () => {
    if (current) hosts.push({ ...current, host: current.host || current.alias });
    current = null;
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separated = line.replace(/^([A-Za-z]+)\s*=\s*/, "$1 ");
    const match = /^(\S+)\s+(.*)$/.exec(separated);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();
    if (keyword === "host") {
      flush();
      const alias = value.split(/\s+/).find((pattern) => !/[*?!]/.test(pattern));
      if (alias) current = { alias, host: "" };
      continue;
    }
    if (!current) continue;
    if (keyword === "hostname") current.host = value;
    else if (keyword === "user") current.user = value;
    else if (keyword === "identityfile") current.identityFile = value;
    else if (keyword === "port") {
      const port = Number.parseInt(value, 10);
      if (Number.isInteger(port) && port > 0 && port < 65536) current.port = port;
    }
  }
  flush();
  return hosts;
}

/** Read `~/.ssh/config`, or an empty list when there is none. */
export function readSshConfigHosts(): SshConfigHost[] {
  const configPath = path.join(resolveHomeDir(), ".ssh", "config");
  try {
    if (!fs.existsSync(configPath)) return [];
    return parseSshConfigHosts(fs.readFileSync(configPath, "utf8"));
  } catch {
    return [];
  }
}

/**
 * List the directories under `dirPath` on the remote host so the connect
 * dialog can browse for a project root before any local folder exists. An
 * empty `dirPath` lists the login home directory.
 */
export async function listSshRemoteDirectories(
  settings: SshRemoteSettings,
  dirPath?: string,
): Promise<{ path: string; directories: string[] }> {
  if (!settings.host) throw new Error("Host is required");
  const target = dirPath?.trim();
  // `cd "$HOME"` rather than a quoted `~`: shQuote deliberately blocks every
  // expansion, so a literal tilde would not resolve on the remote side.
  const cd = target ? `cd ${shQuote(target)}` : 'cd "$HOME"';
  const output = await sshExec(settings, `${cd} && pwd && ls -1pA`);
  const lines = output.toString("utf8").split("\n");
  const resolvedPath = (lines.shift() || "").trim();
  const directories = lines
    .map((line) => line.trimEnd())
    .filter((line) => line.endsWith("/"))
    .map((line) => line.slice(0, -1))
    .filter((name) => name && name !== "." && name !== "..")
    .sort((a, b) => a.localeCompare(b));
  return { path: resolvedPath, directories };
}

export async function testSshRemoteConnection(settings: SshRemoteSettings): Promise<{
  ok: boolean;
  message: string;
  remotePath?: string;
  latencyMs: number;
}> {
  const startedAt = Date.now();
  if (!settings.host) {
    return { ok: false, message: "Host is required", latencyMs: 0 };
  }
  try {
    const remotePath = settings.remotePath?.trim();
    const command = remotePath ? `cd ${shQuote(remotePath)} && pwd` : "pwd";
    const output = await sshExec(settings, command);
    return {
      ok: true,
      message: "Connected",
      remotePath: output.toString("utf8").trim(),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Map a local absolute path under `localCwd` onto the equivalent remote path. */
function remotePathFor(localCwd: string, remoteCwd: string, absolutePath: string): string {
  if (absolutePath === localCwd) return remoteCwd;
  if (absolutePath.startsWith(`${localCwd}/`)) {
    return `${remoteCwd}${absolutePath.slice(localCwd.length)}`;
  }
  return absolutePath;
}

export function createRemoteReadOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): ReadOperations {
  const toRemote = (p: string) => remotePathFor(localCwd, remoteCwd, p);
  return {
    readFile: (p) => sshExec(settings, `cat -- ${shQuote(toRemote(p))}`),
    access: (p) => sshExec(settings, `test -r ${shQuote(toRemote(p))}`).then(() => {}),
    detectImageMimeType: async (p) => {
      try {
        const result = await sshExec(settings, `file --mime-type -b ${shQuote(toRemote(p))}`);
        const mime = result.toString("utf8").trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mime) ? mime : null;
      } catch {
        return null;
      }
    },
  };
}

export function createRemoteWriteOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): WriteOperations {
  const toRemote = (p: string) => remotePathFor(localCwd, remoteCwd, p);
  return {
    writeFile: async (p, content) => {
      // Content travels over stdin (not embedded as a base64 command-line
      // argument, unlike the pi-coding-agent example) to avoid ARG_MAX limits
      // on larger files.
      await sshExec(settings, `base64 -d > ${shQuote(toRemote(p))}`, {
        input: Buffer.from(Buffer.from(content, "utf8").toString("base64"), "utf8"),
      });
    },
    mkdir: (dir) => sshExec(settings, `mkdir -p -- ${shQuote(toRemote(dir))}`).then(() => {}),
  };
}

export function createRemoteEditOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): EditOperations {
  const readOps = createRemoteReadOps(settings, remoteCwd, localCwd);
  const writeOps = createRemoteWriteOps(settings, remoteCwd, localCwd);
  return { readFile: readOps.readFile, access: readOps.access, writeFile: writeOps.writeFile };
}

export function createRemoteBashOps(
  settings: SshRemoteSettings,
  remoteCwd: string,
  localCwd: string,
): BashOperations {
  const toRemote = (p: string) => remotePathFor(localCwd, remoteCwd, p);
  return {
    exec: (command, cwd, { onData, signal, timeout }) =>
      new Promise((resolve, reject) => {
        const remoteCommand = `cd ${shQuote(toRemote(cwd))} && ${command}`;
        const child = spawn("ssh", sshArgs(settings, remoteCommand), {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        const timer = timeout
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, timeout * 1000)
          : undefined;
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      }),
  };
}

/** Resolve the settings that should apply for the current session, or null when disabled/untrusted. */
export type ResolveSshRemoteSettings = (cwd: string, trusted: boolean) => SshRemoteSettings | null;

export function registerSshRemoteExtension(
  pi: ExtensionAPI,
  resolveSettings: ResolveSshRemoteSettings,
): void {
  const localCwd = process.cwd();
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let resolved: { settings: SshRemoteSettings; remoteCwd: string } | null = null;
  const getResolved = () => resolved;

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const remote = getResolved();
      if (!remote) return localRead.execute(id, params, signal, onUpdate, ctx);
      const tool = createReadTool(localCwd, {
        operations: createRemoteReadOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const remote = getResolved();
      if (!remote) return localWrite.execute(id, params, signal, onUpdate, ctx);
      const tool = createWriteTool(localCwd, {
        operations: createRemoteWriteOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const remote = getResolved();
      if (!remote) return localEdit.execute(id, params, signal, onUpdate, ctx);
      const tool = createEditTool(localCwd, {
        operations: createRemoteEditOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const remote = getResolved();
      if (!remote) return localBash.execute(id, params, signal, onUpdate, ctx);
      const tool = createBashTool(localCwd, {
        operations: createRemoteBashOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    resolved = null;
    ctx.ui.setStatus("ssh-remote", undefined);
    const settings = resolveSettings(ctx.cwd, ctx.isProjectTrusted());
    if (!settings) return;
    try {
      const remoteCwd =
        settings.remotePath || (await sshExec(settings, "pwd")).toString("utf8").trim();
      resolved = { settings, remoteCwd };
      const label = `SSH: ${sshTarget(settings)}:${remoteCwd}`;
      ctx.ui.setStatus("ssh-remote", ctx.ui.theme.fg("accent", label));
      ctx.ui.notify(`SSH remote execution active — ${label}`, "info");
    } catch (error) {
      ctx.ui.notify(
        `SSH remote execution could not connect: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  });

  // Route user-triggered `!`/`!!` shell commands to the remote host too, so
  // ad-hoc checks match what the agent's own bash tool would run.
  pi.on("user_bash", () => {
    const remote = getResolved();
    if (!remote) return;
    return { operations: createRemoteBashOps(remote.settings, remote.remoteCwd, localCwd) };
  });

  pi.on("before_agent_start", (event) => {
    const remote = getResolved();
    if (!remote) return;
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${remote.remoteCwd} (via SSH: ${sshTarget(remote.settings)})`,
    );
    return { systemPrompt: modified };
  });
}
