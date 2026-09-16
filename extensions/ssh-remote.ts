// ABOUTME: Delegates read/write/edit/bash tool execution to a remote host over SSH.
// ABOUTME: A project binds to a host (inline, or by alias into the global registry).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
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
  /**
   * A `Host` alias in the user's own `~/.ssh/config` that this connection came
   * from *unmodified*. When set we connect as `ssh <alias>` and pass no
   * -p/-i/user of our own, so OpenSSH applies the whole block itself —
   * ProxyJump, IdentityAgent, Match rules and everything else we do not model.
   * Dropped the moment the user edits any connection field, because then the
   * alias no longer describes what they asked for.
   */
  configAlias?: string;
};

/** One entry of the global `sshHosts` registry: connection only, no project binding. */
export type SshHostEntry = {
  host: string;
  port?: number;
  user?: string;
  identityFile?: string;
  configAlias?: string;
};

/** A `Host` block parsed out of the user's `~/.ssh/config`. */
export type SshConfigHost = SshHostEntry & { alias: string };

export const DEFAULT_SSH_REMOTE_SETTINGS: SshRemoteSettings = { enabled: false, host: "" };

const SSH_CONNECT_TIMEOUT_SECONDS = 8;
// Whole-command ceiling for the short metadata calls that go through sshExec
// (pwd, cat, ls, mkdir). Long-running user commands do not use it — the bash
// tool spawns its own ssh with the caller's own timeout.
const SSH_EXEC_TIMEOUT_SECONDS = 25;
// How long a shared connection stays up after the last command using it. Long
// enough to span a user's thinking time between turns, short enough that a
// closed workspace is not holding an authenticated session all afternoon.
const SSH_CONTROL_PERSIST_SECONDS = 600;
// sockaddr_un.sun_path is 104 bytes on macOS (108 on Linux); leave headroom
// and fall back to unmultiplexed connections rather than failing at bind time.
const SSH_CONTROL_PATH_MAX_BYTES = 96;
// `ssh -G` resolves a Host block without touching the network, so it is fast,
// but a pathological config should not wedge the connect dialog.
const SSH_CONFIG_QUERY_TIMEOUT_MS = 3000;
const PROJECT_CONFIG_DIR_NAME = ".pi";
// Deliberately process-local: passwords are never written to either settings
// file. Picot injects PICOT_SSH_PASSWORD when it spawns this process for a
// remote workspace that was opened with one (src-tauri/src/native_pi_manager.rs),
// so the credentials are in place before the first tool call rather than being
// pushed in later by the WebView — that route raced session startup and left
// `bash` unauthenticated.
let sessionPassword: string | undefined = process.env.PICOT_SSH_PASSWORD || undefined;

export function setSshRemoteSessionPassword(password: unknown): void {
  sessionPassword = typeof password === "string" && password ? password : undefined;
}

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
    ...(settings.configAlias ? { configAlias: settings.configAlias } : {}),
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
  const configAlias = binding.configAlias || entry.configAlias;
  return {
    enabled: binding.enabled,
    host,
    hostRef: binding.hostRef,
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
    ...(binding.remotePath ? { remotePath: binding.remotePath } : {}),
    ...(identityFile ? { identityFile } : {}),
    ...(configAlias ? { configAlias } : {}),
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
  const configAlias = typeof raw.configAlias === "string" ? raw.configAlias.trim() : "";
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
    ...(configAlias ? { configAlias } : {}),
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
  // A config alias IS the target: `ssh gpu-box` lets OpenSSH apply the whole
  // Host block (ProxyJump included), which no amount of -o flags reproduces.
  if (settings.configAlias) return settings.configAlias;
  return settings.user ? `${settings.user}@${settings.host}` : settings.host;
}

/**
 * The directory holding ControlMaster sockets. Kept under the pi agent root
 * rather than the system temp dir for one blunt reason: a Unix socket path is
 * capped at ~104 bytes, and macOS `$TMPDIR` (`/var/folders/<hash>/T/`) eats
 * most of that before we add a filename.
 *
 * Returns null when multiplexing cannot be used, in which case every call
 * falls back to the old one-connection-per-command behaviour.
 */
function sshControlDir(): string | null {
  // Windows' OpenSSH port has no ControlMaster — it fails the whole connection
  // rather than ignoring the option, so it must never be passed there.
  if (process.platform === "win32") return null;
  try {
    // Escape hatch for a home directory long enough to overrun the socket-path
    // limit on its own (and the handle tests use to get a short path).
    const override = process.env.PICOT_SSH_CONTROL_DIR?.trim();
    const dir = override || path.join(resolvePiAgentRoot(), "ssh-control");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // recursive:true leaves an existing directory's mode alone; the socket
    // grants whoever can reach it an authenticated shell on the remote host.
    fs.chmodSync(dir, 0o700);
    return dir;
  } catch {
    return null;
  }
}

/**
 * Socket path for this connection, or null when multiplexing is unavailable.
 *
 * We hash the connection ourselves instead of using OpenSSH's `%C` token
 * because `%C` expands to a 64-char digest, which blows the socket-path limit
 * on macOS. Everything that can change which machine or account we land on
 * goes into the hash, so two different connections can never share a master.
 */
export function sshControlPath(settings: SshRemoteSettings): string | null {
  const dir = sshControlDir();
  if (!dir) return null;
  const target = sshTarget(settings);
  if (!target) return null;
  const key = [target, settings.port ?? "", settings.identityFile ?? ""].join("\u0000");
  const socket = path.join(
    dir,
    `cm-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`,
  );
  return socket.length > SSH_CONTROL_PATH_MAX_BYTES ? null : socket;
}

/**
 * Hang up the shared connection for `settings`. Best-effort and never throws:
 * ControlPersist would expire the master on its own, this just does not make
 * the user wait for that.
 */
export function closeSshControlMaster(settings: SshRemoteSettings): void {
  const controlPath = sshControlPath(settings);
  if (!controlPath || !fs.existsSync(controlPath)) return;
  try {
    const child = spawn(
      "ssh",
      ["-O", "exit", "-o", `ControlPath=${controlPath}`, sshTarget(settings)],
      {
        stdio: "ignore",
      },
    );
    child.on("error", () => {});
    child.unref?.();
  } catch {
    // Nothing to do — the master expires with ControlPersist regardless.
  }
}

function sshArgs(settings: SshRemoteSettings, remoteCommand: string, password?: string): string[] {
  const args = [
    "-o",
    `BatchMode=${password ? "no" : "yes"}`,
    "-o",
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    // BatchMode disables the interactive host-key prompt, so an unknown host
    // would otherwise fail outright; accept-new still rejects a *changed*
    // key on a host we've already connected to.
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  // Connection multiplexing. The first ssh of a session authenticates and then
  // backgrounds itself as a master (ControlPersist); every later read/write/
  // edit/bash rides that socket, so it costs no TCP handshake, no key or
  // password exchange, and no fresh sshd session. This is what makes a remote
  // workspace feel local, and it is also why one wrong-password retry no
  // longer multiplies into an auth attempt per tool call.
  const controlPath = sshControlPath(settings);
  if (controlPath) {
    args.push(
      "-o",
      "ControlMaster=auto",
      "-o",
      `ControlPath=${controlPath}`,
      "-o",
      `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}`,
    );
  }
  if (password) {
    // Go straight to the password. Offering keys first burns MaxAuthTries on a
    // host we have no key for (and pops the agent), and without
    // NumberOfPasswordPrompts=1 ssh resubmits the *same* wrong password three
    // times — slow, and enough to trip fail2ban. keyboard-interactive stays in
    // the list because plenty of servers accept only that variant; askpass
    // answers both the same way.
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PasswordAuthentication=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  // With a config alias, port and identity come from the user's own Host block.
  // Passing our copies back in would only let a stale value override the file.
  if (!settings.configAlias) {
    if (settings.port) args.push("-p", String(settings.port));
    if (settings.identityFile) args.push("-i", settings.identityFile);
  }
  args.push(sshTarget(settings), remoteCommand);
  return args;
}

/**
 * The askpass helper and environment that let ssh authenticate with a password
 * without a terminal. Returns `null` when there is no password to supply, in
 * which case the caller spawns with the inherited environment.
 *
 * The helper is a throwaway script in a private temp dir; the password itself
 * travels in the child's environment, never on the command line (where every
 * other process on this machine could read it out of `ps`).
 */
function createAskpass(password: string): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "picot-ssh-askpass-"));
  const askpass = path.join(dir, "askpass");
  fs.writeFileSync(askpass, "#!/bin/sh\nprintf '%s\\n' \"$PICOT_SSH_PASSWORD\"\n", {
    mode: 0o700,
  });
  return {
    env: {
      ...process.env,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: "picot",
      PICOT_SSH_PASSWORD: password,
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Appended to auth-failure messages so the frontend (public/native/app.js)
 * can tell "this needs a password" apart from an ordinary remote-command
 * failure without parsing the English prose above it — which stays free to
 * change for humans since the marker is what code actually matches on. Kept
 * in sync by hand with the copy of this constant in app.js; there is no
 * shared module between the extension host and the webview to import it
 * from.
 */
export const SSH_AUTH_REQUIRED_MARKER = "[picot:ssh-auth-required]";

/** Run a command on the remote host, optionally piping `input` to its stdin. */
/**
 * `Permission denied (publickey,password,keyboard-interactive)` is ssh listing
 * what the *server* would accept, which reads like a server problem when the
 * real cause is on this side: no password was supplied and no key is set up.
 * Say which of the two happened.
 */
function authHint(stderr: string, password?: string): string {
  if (!stderr) return "no output";
  if (!/Permission denied/i.test(stderr)) return stderr;
  return password
    ? `${stderr} — the password was rejected by the host. ${SSH_AUTH_REQUIRED_MARKER}`
    : `${stderr} — no password was given and no usable key was found. Enter the host's password in the connect dialog, or set an identity file. ${SSH_AUTH_REQUIRED_MARKER}`;
}

export function sshExec(
  settings: SshRemoteSettings,
  remoteCommand: string,
  options: { input?: Buffer; password?: string } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const password = options.password ?? sessionPassword;
    const askpass = password ? createAskpass(password) : null;
    const child = spawn("ssh", sshArgs(settings, remoteCommand, password), {
      stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
      ...(askpass ? { env: askpass.env } : {}),
    });
    // ConnectTimeout only bounds the TCP handshake. A host that accepts the
    // connection and then stalls — sshd rate-limiting a source that failed
    // auth too often is the common case — would otherwise hang every caller
    // indefinitely, and the connect dialog just sits on "Listing…".
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, SSH_EXEC_TIMEOUT_SECONDS * 1000);
    const cleanup = () => {
      clearTimeout(deadline);
      askpass?.cleanup();
    };
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (data) => chunks.push(data));
    child.stderr.on("data", (data) => errChunks.push(data));
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (timedOut) {
        reject(
          new Error(
            `SSH command timed out after ${SSH_EXEC_TIMEOUT_SECONDS}s. The host accepted the connection but never answered — it may be rate-limiting this machine after failed sign-ins.`,
          ),
        );
      } else if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`SSH command failed (exit ${code}): ${authHint(stderr, password)}`));
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
    // configAlias even here: the alias is the one value this parser cannot get
    // wrong, and connecting through it beats connecting through our reading of
    // the block.
    if (current) {
      hosts.push({ ...current, host: current.host || current.alias, configAlias: current.alias });
    }
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

/**
 * Every non-wildcard `Host` alias reachable from `configPath`, following
 * `Include` directives the way ssh does.
 *
 * Enumeration is the one thing `ssh -G` cannot do for us — it answers about a
 * host you name, it does not list them — so this stays hand-rolled. It only
 * has to recognise `Host` and `Include` lines, though; every *value* is
 * resolved by ssh itself in `resolveSshConfigHost`, so the subtleties this
 * parser does not model (Match blocks, wildcards, later-wins precedence,
 * percent expansion) no longer produce wrong answers here.
 */
export function collectSshConfigAliases(configPath: string, depth = 0): string[] {
  // ssh itself caps Include nesting; the guard is really against a cycle.
  if (depth > 8) return [];
  let text: string;
  try {
    if (!fs.existsSync(configPath)) return [];
    text = fs.readFileSync(configPath, "utf8");
  } catch {
    return [];
  }
  const baseDir = path.dirname(configPath);
  const aliases: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\S+)\s+(.*)$/.exec(line.replace(/^([A-Za-z]+)\s*=\s*/, "$1 "));
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();
    if (keyword === "host") {
      // A block can declare several patterns; every literal one is a target.
      for (const pattern of value.split(/\s+/)) {
        // Wildcards are defaults for *other* hosts, and a leading dash would
        // be read as a flag by `ssh -G`.
        if (!pattern || /[*?!]/.test(pattern) || pattern.startsWith("-")) continue;
        aliases.push(pattern);
      }
    } else if (keyword === "include") {
      for (const pattern of value.split(/\s+/)) {
        for (const included of expandSshInclude(pattern, baseDir)) {
          aliases.push(...collectSshConfigAliases(included, depth + 1));
        }
      }
    }
  }
  return [...new Set(aliases)];
}

/**
 * Resolve one `Include` pattern to real files. Relative patterns are relative
 * to `~/.ssh` (ssh's rule for the user config), and only the final segment may
 * glob — which covers the shapes people actually write (`config.d/*`,
 * `conf.d/*.conf`) without pulling in a glob dependency.
 */
function expandSshInclude(pattern: string, baseDir: string): string[] {
  const expanded = pattern.startsWith("~/")
    ? path.join(resolveHomeDir(), pattern.slice(2))
    : path.isAbsolute(pattern)
      ? pattern
      : path.join(baseDir, pattern);
  const dir = path.dirname(expanded);
  const base = path.basename(expanded);
  if (!/[*?]/.test(base)) return fs.existsSync(expanded) ? [expanded] : [];
  const matcher = new RegExp(
    `^${base
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && matcher.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** Run `ssh` with `args`, resolving stdout on success and null on any failure. */
function sshCapture(args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (data: Buffer) => chunks.push(data));
    // Drained but discarded: ssh writes debug and warning noise here, and a full
    // pipe would block the child.
    child.stderr?.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

// Identity files ssh lists for *every* host whether or not the config names
// one. Copying these into a saved host would pin a default that ssh already
// tries, and make an unconfigured host look configured.
const DEFAULT_IDENTITY_BASENAMES = new Set([
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ecdsa_sk",
  "id_ed25519",
  "id_ed25519_sk",
  "id_xmss",
]);

/**
 * Turn `ssh -G` output — a flat, fully-resolved `keyword value` dump — into a
 * host entry. Values ssh would have used anyway (port 22, the local username,
 * the default key names) are dropped so the connect dialog shows what the
 * user actually configured rather than ssh's defaults echoed back.
 */
export function parseSshConfigQuery(alias: string, text: string): SshConfigHost {
  const values = new Map<string, string[]>();
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(.*)$/.exec(rawLine.trim());
    if (!match) continue;
    const list = values.get(match[1].toLowerCase());
    if (list) list.push(match[2].trim());
    else values.set(match[1].toLowerCase(), [match[2].trim()]);
  }
  const first = (key: string) => values.get(key)?.[0] || "";
  const port = Number.parseInt(first("port"), 10);
  const user = first("user");
  const identityFiles = values.get("identityfile") ?? [];
  const identityFile =
    identityFiles.length === 1 &&
    !DEFAULT_IDENTITY_BASENAMES.has(path.basename(identityFiles[0]).replace(/\.pub$/, ""))
      ? identityFiles[0]
      : "";
  let localUser = "";
  try {
    localUser = os.userInfo().username;
  } catch {
    // Unmapped uid (some containers) — then no user looks like a default.
  }
  return {
    alias,
    host: first("hostname") || alias,
    ...(Number.isInteger(port) && port > 0 && port < 65536 && port !== 22 ? { port } : {}),
    ...(user && user !== localUser ? { user } : {}),
    ...(identityFile ? { identityFile } : {}),
    configAlias: alias,
  };
}

/**
 * Ask ssh what `alias` resolves to. Null when ssh cannot answer.
 *
 * `-F configPath` names the very file the aliases were enumerated from. In
 * normal use that is the file ssh would have picked anyway, but ssh resolves
 * `~` from the passwd entry rather than `$HOME`, so without it the two halves
 * of this lookup can describe different files.
 */
async function resolveSshConfigHost(
  alias: string,
  configPath: string,
): Promise<SshConfigHost | null> {
  const output = await sshCapture(["-F", configPath, "-G", alias], SSH_CONFIG_QUERY_TIMEOUT_MS);
  return output === null ? null : parseSshConfigQuery(alias, output);
}

/** Resolve `aliases` through `ssh -G`, a few at a time. */
async function resolveSshConfigHosts(
  aliases: string[],
  configPath: string,
): Promise<SshConfigHost[] | null> {
  const resolved: SshConfigHost[] = [];
  let sshAnswered = false;
  const CONCURRENCY = 8;
  for (let index = 0; index < aliases.length; index += CONCURRENCY) {
    const batch = await Promise.all(
      aliases
        .slice(index, index + CONCURRENCY)
        .map((alias) => resolveSshConfigHost(alias, configPath)),
    );
    for (const entry of batch) {
      if (!entry) continue;
      sshAnswered = true;
      resolved.push(entry);
    }
  }
  // No alias resolved at all: ssh is missing or too old for -G. Say so, so the
  // caller can fall back rather than reporting an empty config.
  return sshAnswered ? resolved : null;
}

/**
 * The connectable hosts in the user's `~/.ssh/config`, as suggestions for the
 * connect dialog.
 *
 * Aliases are enumerated from the files (Includes followed) and every alias is
 * then resolved by `ssh -G`, so Match blocks, wildcard defaults and
 * later-wins precedence are applied by ssh rather than re-implemented here.
 * Falls back to the in-process parser only when `ssh -G` is unusable.
 */
export async function readSshConfigHosts(): Promise<SshConfigHost[]> {
  const configPath = path.join(resolveHomeDir(), ".ssh", "config");
  try {
    if (!fs.existsSync(configPath)) return [];
    const aliases = collectSshConfigAliases(configPath);
    if (aliases.length === 0) return [];
    const resolved = await resolveSshConfigHosts(aliases, configPath);
    if (resolved) return resolved;
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
  password?: string,
): Promise<{ path: string; directories: string[] }> {
  if (!settings.host) throw new Error("Host is required");
  const target = dirPath?.trim();
  // `cd "$HOME"` rather than a quoted `~`: shQuote deliberately blocks every
  // expansion, so a literal tilde would not resolve on the remote side.
  const cd = target ? `cd ${shQuote(target)}` : 'cd "$HOME"';
  const output = await sshExec(settings, `${cd} && pwd && ls -1pA`, { password });
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

export async function testSshRemoteConnection(
  settings: SshRemoteSettings,
  password?: string,
): Promise<{
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
    const output = await sshExec(settings, command, { password });
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
        // Same credentials as every other remote call: without this, a
        // password-authenticated workspace could read and edit files but every
        // bash call would fail with "Permission denied".
        const askpass = sessionPassword ? createAskpass(sessionPassword) : null;
        const child = spawn("ssh", sshArgs(settings, remoteCommand, sessionPassword), {
          stdio: ["ignore", "pipe", "pipe"],
          ...(askpass ? { env: askpass.env } : {}),
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
          askpass?.cleanup();
          reject(error);
        });
        const onAbort = () => child.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          askpass?.cleanup();
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
    async execute(id, params, signal, onUpdate) {
      const remote = getResolved();
      if (!remote) return localRead.execute(id, params, signal, onUpdate);
      const tool = createReadTool(localCwd, {
        operations: createRemoteReadOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate) {
      const remote = getResolved();
      if (!remote) return localWrite.execute(id, params, signal, onUpdate);
      const tool = createWriteTool(localCwd, {
        operations: createRemoteWriteOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate) {
      const remote = getResolved();
      if (!remote) return localEdit.execute(id, params, signal, onUpdate);
      const tool = createEditTool(localCwd, {
        operations: createRemoteEditOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate) {
      const remote = getResolved();
      if (!remote) return localBash.execute(id, params, signal, onUpdate);
      const tool = createBashTool(localCwd, {
        operations: createRemoteBashOps(remote.settings, remote.remoteCwd, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    resolved = null;
    ctx.ui.setStatus("ssh-remote", undefined);
    const settings = resolveSettings(ctx.cwd, ctx.isProjectTrusted());
    if (!settings) return;
    try {
      // Always talk to the host here, even when remotePath already tells us the
      // cwd. This one call establishes the shared ControlMaster connection
      // before any tool runs; without it the first burst of concurrent tool
      // calls would each race to become master and each authenticate
      // separately — exactly the cost multiplexing exists to remove.
      const probedCwd = (await sshExec(settings, "pwd")).toString("utf8").trim();
      const remoteCwd = settings.remotePath || probedCwd;
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

  // Hang up the shared connection when the session ends. ControlPersist would
  // expire it anyway; this keeps a closed workspace from leaving an
  // authenticated session open on the remote host for the rest of that window.
  pi.on("session_shutdown", () => {
    const remote = getResolved();
    resolved = null;
    if (remote) closeSshControlMaster(remote.settings);
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
