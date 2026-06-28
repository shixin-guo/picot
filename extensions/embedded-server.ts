/**
 * Embedded Server Extension for Picot desktop
 *
 * Starts the HTTP + WebSocket server that the Picot Tauri WebView talks to.
 * This is not a user-facing "pi extension" — it ships inside the Picot
 * .app bundle and is loaded by the bundled `pi` binary that Picot spawns
 * via `--extension <bundle>/embedded-server.mjs`.
 *
 * Responsibilities:
 * - Serve the static frontend assets (`public/`)
 * - Bridge browser RPC over `/api/rpc` (HTTP) and `/ws` (WebSocket) to the
 *   pi extension API (sendUserMessage, abort, set_model, etc.)
 * - Expose REST endpoints the frontend queries directly:
 *   `/api/sessions`, `/api/cost-dashboard`, `/api/files`, `/api/search`,
 *   `/api/open`, `/api/agent-config`, `/api/models-config`, `/api/instances`
 * - Forward all pi lifecycle events to connected browsers
 * - Generate session titles from user messages
 *
 * What's intentionally NOT here anymore (vs the old mirror-server.ts):
 * - QR / pairing flow — LAN mobile access is advertised as a plain URL
 * - Basic auth — the mobile entry point is an explicit local-network dev mode
 * - `/studiostart` / `/studiostop` / `/qr` commands — server lifecycle is
 *   tied 1:1 to the pi process Picot spawns
 * - Cross-process instance discovery via `~/.pi/pistudio-instances/` —
 *   Picot's Rust side already knows which ports it spawned. We keep a
 *   trivial single-entry registry so the frontend's `active` state stays
 *   correct without needing a Tauri invoke for `/api/instances` queries.
 * - `pi --version` exec probing — version is forwarded by Picot via
 *   `PI_STUDIO_PI_VERSION` env var.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import QRCode from "qrcode";
import { type WebSocket, WebSocketServer } from "ws";
import {
  buildCostDashboardPayload,
  buildEmptyCostDashboardPayload,
  type CostSession,
} from "./cost-dashboard-data.ts";
import { buildProjectSearchMatch } from "./session-search";

// `pi` is compiled with `bun build --compile`. Inside that runtime,
// `http.createServer(...).on("upgrade", ...)` accepts the upgrade event
// but `socket.write()` (which `ws.handleUpgrade` uses to send the
// `HTTP/1.1 101 Switching Protocols` reply) is silently dropped, so the
// client never completes the handshake. The result in Picot is
// "Disconnected" forever and chat sessions never render.
//
// `Bun.serve()` ships its own native WebSocket upgrade path and *does*
// work in the bundled binary, so when the global is present we go that
// route. The plain Node path is kept for dev (jiti/tsx loading the .ts
// source directly under Node) and as a defensive fallback.
interface BunRuntime {
  serve: (...args: unknown[]) => unknown;
  file: (path: string) => {
    exists: () => Promise<boolean>;
    type: string;
    size: number;
    slice: (start: number, end?: number) => unknown;
  };
}
declare const Bun: BunRuntime;
const HAS_BUN_SERVE =
  typeof (globalThis as { Bun?: BunRuntime }).Bun !== "undefined" &&
  typeof (globalThis as { Bun?: BunRuntime }).Bun?.serve === "function";

// Picot settings live under `pistudio` key in ~/.pi/agent/settings.json.
// We only honor the fields that still make sense in desktop-only mode.
// TODO(rename->picot): key is `pistudio` for historical reasons. Changing it to `picot`
// would break existing users' settings — add a migration path before renaming.
function buildHomeDirCandidates(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value?: string) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = path.resolve(trimmed);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(process.env.HOME);
  add(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    add(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  }
  add(os.homedir());

  return candidates;
}

function resolvePiAgentRoot(): string {
  // Prefer whichever home candidate already has .pi/agent on disk.
  for (const home of buildHomeDirCandidates()) {
    const candidate = path.join(home, ".pi", "agent");
    if (fs.existsSync(candidate)) return candidate;
  }

  // Fallback for some Windows setups where app data is relocated.
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.trim()) {
    const roamingCandidate = path.join(path.resolve(appData), "pi", "agent");
    if (fs.existsSync(roamingCandidate)) return roamingCandidate;
  }

  const home = buildHomeDirCandidates()[0] || "~";
  return path.join(home, ".pi", "agent");
}

const PI_AGENT_ROOT = resolvePiAgentRoot();

export const LAN_BIND_HOST = "0.0.0.0";

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function findLanHosts(): string[] {
  const hosts = new Set<string>();
  try {
    const interfaces = os.networkInterfaces();
    for (const details of Object.values(interfaces)) {
      if (!details) continue;
      for (const detail of details) {
        if (detail.family === "IPv4" && !detail.internal && detail.address) {
          hosts.add(detail.address);
        }
      }
    }
  } catch {}
  return [...hosts].sort();
}

export function buildLanAccessUrls(port: number, hosts: string[]): string[] {
  const brokerPort = Number.parseInt(process.env.PI_STUDIO_BROKER_PORT || "", 10);
  return hosts.map((host) => {
    const url = new URL(`http://${host}:${port}/`);
    url.searchParams.set("mobile", "1");
    if (Number.isFinite(brokerPort) && brokerPort > 0) {
      url.searchParams.set("brokerWs", `ws://${host}:${brokerPort}/ui-ws`);
    }
    return url.toString();
  });
}

function buildLanUrls(port: number): string[] {
  if (isLoopbackHost(BIND_HOST)) return [];
  const hosts = BIND_HOST === "0.0.0.0" ? findLanHosts() : [BIND_HOST];
  return buildLanAccessUrls(port, hosts);
}

function loadSettings(): { port: number } {
  let settings: { port?: number | string } = {};
  try {
    const settingsPath = path.join(PI_AGENT_ROOT, "settings.json");
    // TODO(rename->picot): key `pistudio` kept for backward compat — migrate to `picot` once a settings-migration path exists.
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).pistudio || {};
  } catch {}
  return {
    port: parseInt(String(process.env.PI_STUDIO_PORT || settings.port || "47821"), 10),
  };
}

const SETTINGS = loadSettings();
const PORT = SETTINGS.port;
const BIND_HOST = LAN_BIND_HOST;
// Forwarded by Picot (Rust side) from `scripts/pi-version.json`. We deliberately
// do not call `pi --version` here: this extension always runs *inside* the pi
// binary Picot spawned, so the version is known.
const EMBEDDED_PI_VERSION = process.env.PI_STUDIO_PI_VERSION || "";

const STATIC_DIR = process.env.PI_STUDIO_STATIC_DIR || findPublicDir();

function findPublicDir(): string {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (dir: string) => {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  // Common extension-relative paths. Picot's Rust side always sets
  // PI_STUDIO_STATIC_DIR, so this fallback chain is only exercised in
  // weird dev scenarios (e.g. loading the extension directly via pi -e).
  addCandidate(path.resolve(__dirname, "public"));
  addCandidate(path.resolve(__dirname, "../public"));
  addCandidate(path.resolve(process.cwd(), "public"));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }

  return path.resolve(process.cwd(), "public");
}
const SESSIONS_DIR = path.join(PI_AGENT_ROOT, "sessions");
// TODO(rename->picot): directory `pistudio-instances` kept for backward compat — migrate to `picot-instances` once existing users are handled.
const INSTANCES_DIR = path.join(path.dirname(PI_AGENT_ROOT), "pistudio-instances");

// Minimal single-process instance registry. We keep this so the frontend's
// `/api/instances` response reflects the running workspace without needing
// a Tauri invoke. Unlike the old mirror-server
// which scanned the whole INSTANCES_DIR (for tmux / standalone pi
// processes), we only ever write our own entry: Picot's Rust side
// manages all pi processes it spawns.
function registerInstance(port: number, sessionFile: string, cwd: string) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const info = { port, pid: process.pid, sessionFile, cwd, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(INSTANCES_DIR, `${process.pid}.json`), JSON.stringify(info));
}

function updateInstanceSession(sessionFile: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.sessionFile = sessionFile;
    fs.writeFileSync(file, JSON.stringify(info));
  } catch {}
}

function getRunningInstances(): Array<{
  port: number;
  pid: number;
  sessionFile: string;
  cwd: string;
}> {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: Array<{ port: number; pid: number; sessionFile: string; cwd: string }> = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Check if process is still alive
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try {
          fs.unlinkSync(path.join(INSTANCES_DIR, file));
        } catch {}
      }
    } catch {}
  }
  return instances;
}

type GitBranchContextLike = {
  sessionManager?: {
    getEntries?: () => Array<{ type?: string; cwd?: string }>;
  };
} | null;

export function normalizeApiRoutePath(urlPath: string): string {
  return urlPath.split("?")[0] || "/";
}

export function resolveGitBranchCwd({
  foregroundPort,
  fallbackCwd,
  instances,
  latestCtx,
}: {
  foregroundPort: number | null;
  fallbackCwd: string;
  instances: Array<{ port: number; pid: number; sessionFile: string; cwd: string }>;
  latestCtx: GitBranchContextLike;
}): string {
  if (typeof foregroundPort === "number" && Number.isFinite(foregroundPort)) {
    const matchedWorkspace = instances.find((instance) => instance?.port === foregroundPort)?.cwd;
    if (typeof matchedWorkspace === "string" && matchedWorkspace.trim()) {
      return matchedWorkspace;
    }
  }

  if (latestCtx?.sessionManager?.getEntries) {
    try {
      const entries = latestCtx.sessionManager.getEntries();
      const sessionEntry = entries.find((e: { type?: string }) => e.type === "session");
      if (sessionEntry?.cwd) return sessionEntry.cwd;
    } catch {}
  }

  return fallbackCwd;
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ─── Process-global server state ──────────────────────────────────────────────
//
// pi reloads the extension on every `new_session` / `switch_session` / `fork`:
// the old extension instance receives `session_shutdown`, the module is
// rebound, and the new instance receives `session_start`. If we closed the
// HTTP+WS server in `session_shutdown` and re-listened on `session_start`,
// the WebView (anchored at e.g. `http://localhost:3001`) would either:
//   - race against the slow `server.close()` and end up on PORT+1, OR
//   - just see a dead socket while close() drains active connections.
// Both manifest to the user as "create session does nothing".
//
// Fix: own the HTTP server, WS server, client set, and heartbeat at the
// process scope. We start them once (lazily on the first `session_start`)
// and keep them alive for the lifetime of the pi process. Each new extension
// instance just (re)publishes its `handleCommand` / `latestCtx` / event
// broadcaster into the global so the long-lived `wss.on("connection", …)`
// handler always dispatches through the *current* session's bindings.
// Cache key for parsed session file headers / metrics. We key on absolute
// path and invalidate on (mtimeMs, size). pi *appends* to JSONL files for the
// active session, so size grows monotonically until the session ends — this
// is sufficient to detect "needs reparse" without diffing content.
type SessionFileCacheEntry<T> = {
  mtimeMs: number;
  size: number;
  value: T;
};

// A unified handle to whichever underlying server is currently bound.
// Only one of `nodeServer` / `bunServer` is non-null at any time; the
// other fields (port / close) abstract over the differences so the rest
// of the code (lifecycle, instance registry, shutdown) doesn't need to
// branch on runtime.
type ServerHandle = {
  port: number;
  // Force-close everything, used in tests / hot reload — production never
  // calls this, the server lives for the pi process lifetime.
  close: () => void;
  // The native handle, for callers that genuinely need it (currently
  // only the `server.address()` peek in the re-register path).
  nodeServer: http.Server | null;
  bunServer: unknown | null;
};

// Unified WebSocket wrapper: either the `ws`-library WebSocket (node path)
// or Bun's `ServerWebSocket` (bun path). We only depend on the small
// surface used by the rest of this extension: send/close/readyState/ping,
// plus a synthetic `isAlive` flag for the heartbeat reaper.
//
// We keep this as a structural type rather than a wrapper class because
// the bun ServerWebSocket already exposes `.send(string)`, `.readyState`,
// `.ping()`, and `.close()` — they just lack `.terminate()` and the
// event-emitter `.on(...)` API. The wrapper closes that gap minimally.
interface RpcCommand {
  type: string;
  id?: string;
  apiKey?: string;
  customInstructions?: string;
  images?: Array<{ data?: string; mimeType?: string }>;
  level?: string;
  message: string;
  modelId?: string;
  name?: string;
  outputPath?: string;
  provider?: string;
  sessionPath?: string;
  streamingBehavior?: string;
  [key: string]: unknown;
}

type UnifiedWS = {
  readyState: number;
  send: (data: string) => unknown;
  close: () => void;
  terminate: () => void;
  ping: () => void;
  isAlive?: boolean;
};

type EmbeddedServerGlobal = {
  server: ServerHandle | null;
  wss: WebSocketServer | null;
  clients: Set<UnifiedWS>;
  heartbeatTimer: NodeJS.Timeout | null;
  localUrl: string;
  lanUrl: string;
  // Re-published by every extension instance on session_start so the
  // connection handler dispatches to the new session's pi/ctx.
  handleCommand: ((ws: WebSocket, command: RpcCommand) => Promise<void>) | null;
  buildStateSnapshot: ((ctx: ExtensionContext) => Promise<unknown>) | null;
  getLatestCtx: (() => ExtensionContext | null) | null;
  // Cached process-scoped references that don't change across sessions.
  //
  // `ModelRegistry` (and its `AuthStorage`) are owned by the pi process,
  // not by any one session: `~/.pi/agent/auth.json` is shared across every
  // `new_session` / `switch_session` / `fork` and every extension reload
  // pi-mono does. The auth Settings panel (`list_auth_status` /
  // `set_api_key` / `remove_api_key`) only needs the registry — gating it
  // behind the per-session `latestCtx` caused "Failed to load providers"
  // whenever the user opened Settings → Authentication during the brief
  // window before pi fires its first `session_start`, or in the gap
  // between sessions during a reload. We cache the first registry we see
  // here and prefer it (when present) over `latestCtx?.modelRegistry`.
  modelRegistry: ModelRegistry | null;
  // The freshest `ExtensionAPI` (i.e. `pi`) reference, re-published on
  // every `session_start`. Command handlers MUST go through this getter
  // instead of capturing the `pi` parameter from `export default function`
  // in their closure: pi-mono invalidates the old `pi` after `new_session`,
  // `switch_session`, `fork`, and `reload`, and any session-bound call on
  // a stale `pi` (e.g. `pi.setThinkingLevel`, `pi.sendUserMessage`,
  // `pi.setSessionName`) throws an error that pi-mono surfaces as an
  // `extension_error` event — which the frontend renders as a red error
  // bubble in chat. Routing through `getApi()` guarantees we always hit
  // the current session's `pi`.
  getApi: (() => ExtensionAPI | null) | null;
  // Process-scoped parse caches. Live across extension reloads (which would
  // otherwise wipe per-extension `Map`s on every new_session). Without these,
  // `/api/sessions` re-reads + re-parses the JSONL header of every session
  // file in `~/.pi/agent/sessions/**` on every request, which dominates
  // launcher / sidebar warmup latency for users with many sessions.
  sessionHeaderCache: Map<string, SessionFileCacheEntry<unknown>>;
  sessionMetricsCache: Map<string, SessionFileCacheEntry<unknown>>;
};

const EMBEDDED_GLOBAL_KEY = "__piStudioEmbeddedServer__";

interface SessionMetrics {
  id: string;
  title: string;
  cwd: string;
  timestamp: Date | null;
  lastActive: Date | null;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolCostByName: Record<string, number>;
}

// Normalize an unknown thrown value to a human-readable message.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

function getOrCreateGlobalState(): EmbeddedServerGlobal {
  const g = globalThis as Record<string, unknown>;
  if (!g[EMBEDDED_GLOBAL_KEY]) {
    g[EMBEDDED_GLOBAL_KEY] = {
      server: null,
      wss: null,
      clients: new Set<UnifiedWS>(),
      heartbeatTimer: null,
      localUrl: "",
      lanUrl: "",
      handleCommand: null,
      buildStateSnapshot: null,
      getLatestCtx: null,
      getApi: null,
      modelRegistry: null,
      sessionHeaderCache: new Map<string, SessionFileCacheEntry<unknown>>(),
      sessionMetricsCache: new Map<string, SessionFileCacheEntry<unknown>>(),
    } as EmbeddedServerGlobal;
  }
  return g[EMBEDDED_GLOBAL_KEY] as EmbeddedServerGlobal;
}

export default function (pi: ExtensionAPI) {
  const globalState = getOrCreateGlobalState();

  // Store latest context reference for use in command handlers
  let latestCtx: ExtensionContext | null = null;

  // ═══════════════════════════════════════
  // Always resolve the freshest `pi` from globalState before calling any
  // session-bound API.
  //
  // pi-mono invalidates the captured `pi` after `new_session`,
  // `switch_session`, `fork`, and `reload`. If a WS command (e.g.
  // `cycle_thinking_level`) is dispatched through a closure that captured
  // the *old* `pi` — for example because `globalState.handleCommand` was
  // re-published a tick later than expected — calling
  // `oldPi.setThinkingLevel()` etc. throws "This extension ctx is stale
  // after session replacement or reload". pi-mono surfaces that throw as
  // an `extension_error` event, which the frontend renders as a red error
  // bubble in chat (`public/app.js` `extension_error` case).
  //
  // Routing through `currentPi()` guarantees the call is dispatched to
  // whichever extension instance most recently received `session_start`
  // (and thus owns the live, non-stale `pi` for the active session).
  // Returns `null` only during the brief window between an old instance's
  // `session_shutdown` and the new instance's `session_start`; callers
  // must treat that as "no active session".
  function currentPi(): ExtensionAPI | null {
    return globalState.getApi?.() ?? null;
  }

  // ═══════════════════════════════════════
  // Helper: send to one client
  //
  // Accepts either a `ws.WebSocket` or a Bun `ServerWebSocket` — both
  // expose `.send(string)` and `.readyState`. We hard-code the OPEN
  // constant (1) instead of referencing `WebSocket.OPEN`, because on the
  // Bun path the `ws` library isn't actually live (just imported for
  // types) and pulling its constants would defeat the whole point.
  // ═══════════════════════════════════════
  const WS_OPEN = 1;
  const PROTOCOL_VERSION = 1;
  const workspaceId = `workspace:${process.cwd()}`;

  function currentSessionIdFromCtx(ctx: ExtensionContext | null): string | null {
    if (!ctx) return null;
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (typeof sessionFile === "string" && sessionFile.trim()) return sessionFile;
    } catch {}
    try {
      const entries = ctx.sessionManager.getEntries();
      const sessionEntry = entries.find(
        (e: { type?: string; id?: unknown }) => e?.type === "session" && typeof e?.id === "string",
      );
      if (sessionEntry?.id) return sessionEntry.id;
    } catch {}
    return null;
  }

  function withRouteMeta(data: unknown) {
    const currentCtx = globalState.getLatestCtx?.() ?? latestCtx;
    const sessionId = currentSessionIdFromCtx(currentCtx);
    const extra = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    return {
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      sessionId: sessionId || undefined,
      port: globalState.server?.port || PORT,
      ...extra,
    };
  }

  function sendTo(ws: UnifiedWS, data: unknown) {
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify(withRouteMeta(data)));
      } catch {}
    }
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: unknown) {
    const json = JSON.stringify(withRouteMeta(data));
    for (const client of globalState.clients) {
      if (client.readyState === WS_OPEN) {
        try {
          client.send(json);
        } catch {}
      }
    }
  }

  // NOTE: we intentionally do NOT close the HTTP/WS server on
  // `session_shutdown`. The server is owned by `globalState` and lives for
  // the whole pi process lifetime — see the comment on `EmbeddedServerGlobal`
  // above for why. Per-session cleanup (clearing context, unregistering the
  // instance entry) happens in the `session_shutdown` handler instead.

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all Pi events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "model_select",
  ] as const;

  // Cache the process-scoped ModelRegistry the first time we see any ctx.
  // See the EmbeddedServerGlobal.modelRegistry comment for why this is
  // process-scoped (and why gating auth handlers on latestCtx was wrong).
  function rememberCtx(ctx: ExtensionContext) {
    latestCtx = ctx;
    if (!globalState.modelRegistry && ctx?.modelRegistry) {
      globalState.modelRegistry = ctx.modelRegistry;
    }
  }

  for (const eventType of eventTypes) {
    pi.on(
      eventType as Parameters<typeof pi.on>[0],
      async (event: unknown, ctx: ExtensionContext) => {
        rememberCtx(ctx);

        // Forward event to all connected browser clients
        // Wrap in { type: "event", event: ... } to match the existing frontend protocol
        broadcast({
          type: "event",
          event: { type: eventType, ...(event as Record<string, unknown>) },
        });
      },
    );
  }

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  pi.on("session_start", async (_event, ctx) => {
    rememberCtx(ctx);
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
  });

  pi.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  pi.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (msg?.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: { type?: string }) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  pi.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    // Defensive: if the turn that just ended also kicked off a session
    // replacement (e.g. `/new`, `/fork`, `/switch`), the captured `pi` of
    // this OLD extension instance is now stale. Route through the freshest
    // `pi` published on `globalState` so we never call a stale
    // `getSessionName` / `setSessionName`.
    const a = currentPi();
    if (!a) return;

    const sessionName = a.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      a.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({ type: "event", event: { type: "session_name", name: title } });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find((m) => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(
        /^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i,
        "",
      )
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = `${title.substring(0, spaceIdx > 20 ? spaceIdx : 57)}…`;
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    // Get session entries for message history
    const entries = ctx.sessionManager.getEntries();

    // Get model info
    const model = ctx.model;
    const api = currentPi();
    const thinkingLevel = api?.getThinkingLevel() ?? "off";
    const sessionName = api?.getSessionName() ?? "";
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      sessionName,
      sessionFile,
      isStreaming: !ctx.isIdle(),
      contextUsage,
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: UnifiedWS, command: RpcCommand) {
    const id = command.id;
    const ctx = latestCtx;
    // Always resolve `pi` from the global publisher rather than the
    // closure-captured one. See `currentPi()` for the rationale.
    const api = currentPi();

    const success = (cmd: string, data?: unknown) => {
      const resp: Record<string, unknown> = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    // Used by every case that performs a session-bound mutation
    // (`sendUserMessage`, `setThinkingLevel`, `setModel`, `setSessionName`,
    // …). Returning a clean error here is cheaper than letting the call
    // throw `"This extension ctx is stale after session replacement"` and
    // having pi-mono re-emit it as an `extension_error` event in chat.
    const requireApi = (cmd: string): ExtensionAPI | null => {
      if (api) return api;
      sendTo(ws, error(cmd, "No active session"));
      return null;
    };

    try {
      switch (command.type) {
        // ─── Prompting ───
        case "prompt": {
          const a = requireApi("prompt");
          if (!a) break;
          if (ctx && !ctx.isIdle()) {
            const behavior = command.streamingBehavior || "steer";
            if (behavior === "steer") {
              a.sendUserMessage(command.message, { deliverAs: "steer" });
            } else {
              a.sendUserMessage(command.message, { deliverAs: "followUp" });
            }
          } else {
            // Build content with optional images
            if (command.images?.length) {
              const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
              // biome-ignore lint/suspicious/noExplicitAny: mixed text/image content blocks for sendUserMessage
              const content: any[] = [
                { type: "text", text: command.message || "(see attached image)" },
              ];
              for (const img of command.images) {
                if (!img.data || typeof img.data !== "string") {
                  console.error("[embedded-server] Skipping image: missing or invalid data");
                  continue;
                }
                // Strip data URL prefix if accidentally included
                const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                const mimeType = (
                  validMimes.includes(img.mimeType ?? "") ? (img.mimeType as string) : "image/png"
                ) as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                console.log(
                  `[embedded-server] Image: mimeType=${mimeType}, dataLen=${data.length}, rawMimeType=${img.mimeType}`,
                );
                const imageBlock = {
                  type: "image" as const,
                  data: data,
                  mimeType: mimeType,
                };
                // Defensive: verify mimeType is actually set (debug crash where it was missing)
                if (!imageBlock.mimeType) {
                  console.error(
                    `[embedded-server] BUG: mimeType is falsy after assignment! img.mimeType=${img.mimeType}, falling back to image/png`,
                  );
                  imageBlock.mimeType = "image/png";
                }
                content.push(imageBlock);
              }
              // Only send content array if we actually have images, otherwise just text
              const hasImages = content.some((c) => c.type === "image");
              if (hasImages) {
                a.sendUserMessage(content);
              } else {
                a.sendUserMessage(command.message);
              }
            } else {
              a.sendUserMessage(command.message);
            }
          }
          sendTo(ws, success("prompt"));
          break;
        }

        case "steer": {
          const a = requireApi("steer");
          if (!a) break;
          a.sendUserMessage(command.message, { deliverAs: "steer" });
          sendTo(ws, success("steer"));
          break;
        }

        case "follow_up": {
          const a = requireApi("follow_up");
          if (!a) break;
          a.sendUserMessage(command.message, { deliverAs: "followUp" });
          sendTo(ws, success("follow_up"));
          break;
        }

        case "abort": {
          if (ctx) ctx.abort();
          sendTo(ws, success("abort"));
          break;
        }

        case "new_session": {
          if (!ctx) {
            sendTo(ws, error("new_session", "No context available"));
            break;
          }
          if (typeof (ctx as unknown as { newSession?: unknown }).newSession !== "function") {
            sendTo(
              ws,
              error(
                "new_session",
                "New session requires the desktop broker with this embedded pi version.",
              ),
            );
            break;
          }
          const result = await ctx.newSession();
          sendTo(ws, success("new_session", result || {}));
          break;
        }

        case "switch_session": {
          if (!ctx) {
            sendTo(ws, error("switch_session", "No context available"));
            break;
          }
          if (!command.sessionPath || typeof command.sessionPath !== "string") {
            sendTo(ws, error("switch_session", "sessionPath is required"));
            break;
          }
          if (typeof (ctx as unknown as { switchSession?: unknown }).switchSession !== "function") {
            sendTo(
              ws,
              error(
                "switch_session",
                "Session switching requires the desktop broker with this embedded pi version.",
              ),
            );
            break;
          }
          const result = await ctx.switchSession(command.sessionPath);
          sendTo(ws, success("switch_session", result || {}));
          break;
        }

        // ─── State ───
        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          const model = ctx.model;
          const state = {
            model,
            thinkingLevel: api?.getThinkingLevel() ?? "off",
            isStreaming: !ctx.isIdle(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionName: api?.getSessionName() ?? "",
            autoCompactionEnabled: true, // Extension can't easily check this
          };
          sendTo(ws, success("get_state", state));
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        case "get_pi_version": {
          // Embedded pi version is forwarded by Picot (Rust) at spawn time.
          sendTo(ws, success("get_pi_version", { version: EMBEDDED_PI_VERSION }));
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          sendTo(ws, success("get_available_models", { models }));
          break;
        }

        // ─── API keys (auth.json) ───
        //
        // Why: GUI-launched Picot (Finder/dock) does not inherit
        // ANTHROPIC_API_KEY etc. from the user's login shell, and we
        // deliberately removed the brittle login-shell env-harvest path in
        // commit 8b1f5e4. The user therefore needs an in-app way to write
        // their API key into ~/.pi/agent/auth.json once, which then sticks
        // across runs (same file format pi's `/login` writes).
        //
        // These handlers expose a minimal CRUD over auth.json scoped to the
        // built-in providers we know about. OAuth providers are deliberately
        // excluded — they require a browser round-trip we don't support yet
        // from the desktop UI; users who need OAuth should run `pi /login`
        // from a terminal.
        case "list_auth_status": {
          // Use the cached process-scoped registry when available so this
          // works even if the user opens Settings → Authentication before
          // pi's first session_start has fired, or between sessions during
          // a new_session / switch_session / fork reload. See the
          // EmbeddedServerGlobal.modelRegistry comment for the full why.
          const registry = ctx?.modelRegistry ?? globalState.modelRegistry;
          if (!registry) {
            sendTo(
              ws,
              error("list_auth_status", "Model registry not ready yet — try again in a moment."),
            );
            break;
          }
          // Collect unique providers from all known models (built-in + custom).
          const allModels = registry.getAll();
          const providerNames = new Set<string>();
          for (const m of allModels) providerNames.add(m.provider);
          const providers = Array.from(providerNames)
            .sort()
            .map((p) => {
              const status = registry.getProviderAuthStatus(p);
              return {
                provider: p,
                displayName: registry.getProviderDisplayName(p),
                configured: status.configured,
                source: status.source, // "stored" | "environment" | "runtime" | "fallback" | undefined
                label: status.label,
              };
            });
          sendTo(ws, success("list_auth_status", { providers }));
          break;
        }

        case "set_api_key": {
          const registry = ctx?.modelRegistry ?? globalState.modelRegistry;
          if (!registry) {
            sendTo(
              ws,
              error("set_api_key", "Model registry not ready yet — try again in a moment."),
            );
            break;
          }
          const provider = typeof command.provider === "string" ? command.provider.trim() : "";
          const apiKey = typeof command.apiKey === "string" ? command.apiKey.trim() : "";
          if (!provider) {
            sendTo(ws, error("set_api_key", "provider is required"));
            break;
          }
          if (!apiKey) {
            sendTo(ws, error("set_api_key", "apiKey is required"));
            break;
          }
          try {
            registry.authStorage.set(provider, { type: "api_key", key: apiKey });
            // Refresh so getAvailable() picks up the new key without restart.
            registry.refresh();
            sendTo(ws, success("set_api_key", { provider }));
          } catch (e: unknown) {
            sendTo(ws, error("set_api_key", errMessage(e)));
          }
          break;
        }

        case "remove_api_key": {
          const registry = ctx?.modelRegistry ?? globalState.modelRegistry;
          if (!registry) {
            sendTo(
              ws,
              error("remove_api_key", "Model registry not ready yet — try again in a moment."),
            );
            break;
          }
          const provider = typeof command.provider === "string" ? command.provider.trim() : "";
          if (!provider) {
            sendTo(ws, error("remove_api_key", "provider is required"));
            break;
          }
          try {
            registry.authStorage.remove(provider);
            registry.refresh();
            sendTo(ws, success("remove_api_key", { provider }));
          } catch (e: unknown) {
            sendTo(ws, error("remove_api_key", errMessage(e)));
          }
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          const a = requireApi("set_model");
          if (!a) break;
          const models = await ctx.modelRegistry.getAvailable();
          const model = models.find(
            (m: { provider?: string; id?: string }) =>
              m.provider === command.provider && m.id === command.modelId,
          );
          if (!model) {
            sendTo(
              ws,
              error("set_model", `Model not found: ${command.provider}/${command.modelId}`),
            );
            break;
          }
          const ok = await a.setModel(model);
          if (!ok) {
            sendTo(ws, error("set_model", "No API key for this model"));
            break;
          }
          sendTo(ws, success("set_model", model));
          break;
        }

        case "cycle_model": {
          // Extension API doesn't have cycleModel directly
          // Workaround: get available models, find current, pick next
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const a = requireApi("cycle_model");
          if (!a) break;
          const availModels = await ctx.modelRegistry.getAvailable();
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const idx = availModels.findIndex(
            (m: { provider?: string; id?: string }) =>
              m.provider === currentModel.provider && m.id === currentModel.id,
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          await a.setModel(nextModel);
          sendTo(
            ws,
            success("cycle_model", {
              model: nextModel,
              thinkingLevel: a.getThinkingLevel(),
            }),
          );
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          const a = requireApi("cycle_thinking_level");
          if (!a) break;
          const levels = ["off", "minimal", "low", "medium", "high"];
          const current = a.getThinkingLevel();
          const idx = levels.indexOf(current);
          const next = levels[(idx + 1) % levels.length];
          a.setThinkingLevel(next as Parameters<typeof a.setThinkingLevel>[0]);
          sendTo(ws, success("cycle_thinking_level", { level: next }));
          break;
        }

        case "set_thinking_level": {
          const a = requireApi("set_thinking_level");
          if (!a) break;
          a.setThinkingLevel(command.level as Parameters<typeof a.setThinkingLevel>[0]);
          sendTo(ws, success("set_thinking_level"));
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const usage = ctx.getContextUsage();
          const entries = ctx.sessionManager.getEntries();
          let userMessages = 0,
            assistantMessages = 0,
            toolCalls = 0;
          for (const e of entries) {
            if (e.type === "message") {
              if (e.message?.role === "user") userMessages++;
              else if (e.message?.role === "assistant") assistantMessages++;
              else if (e.message?.role === "toolResult") toolCalls++;
            }
          }
          sendTo(
            ws,
            success("get_session_stats", {
              sessionFile: ctx.sessionManager.getSessionFile(),
              userMessages,
              assistantMessages,
              toolCalls,
              totalMessages: entries.length,
              tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
            }),
          );
          break;
        }

        case "set_session_name": {
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          const a = requireApi("set_session_name");
          if (!a) break;
          a.setSessionName(name);
          sendTo(ws, success("set_session_name"));
          break;
        }

        case "set_auto_compaction": {
          // Extension can't easily toggle auto-compaction
          // Just acknowledge
          sendTo(ws, success("set_auto_compaction"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Broadcast compaction start to all clients
            broadcast({ type: "auto_compaction_start" });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: { summary?: string }) => {
                broadcast({ type: "auto_compaction_end", summary: result?.summary });
              },
              onError: (err: unknown) => {
                broadcast({ type: "auto_compaction_end", summary: `Error: ${errMessage(err)}` });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            const { execSync } = require("node:child_process");
            const args = command.outputPath
              ? `"${sessionFile}" "${command.outputPath}"`
              : `"${sessionFile}"`;
            // process.execPath at runtime is the embedded pi binary, which
            // supports --export when invoked as a top-level CLI.
            const output = execSync(`"${process.execPath}" --export ${args}`, {
              cwd: process.cwd(),
              timeout: 30000,
              encoding: "utf-8",
            });
            // pi prints the output path
            const result =
              output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: unknown) {
            sendTo(ws, error("export_html", errMessage(e)));
          }
          break;
        }

        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = await buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        // Desktop mode does not need basic auth (WebView is local). We keep
        // the RPC surface so the frontend's settings panel doesn't break,
        // but always report "not configured" so the auth toggle stays
        // hidden client-side.
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: false, enabled: false }));
          break;
        }

        case "set_auth": {
          sendTo(ws, error("set_auth", "Auth is not configurable in desktop mode"));
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: unknown) {
      sendTo(ws, error(command.type || "unknown", errMessage(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Auto-redirect remote browsers to the full mobile URL so users don't
    // need to manually append ?mobile=1&brokerWs=... to the LAN address.
    const brokerPort = Number.parseInt(process.env.PI_STUDIO_BROKER_PORT || "", 10);
    const host = req.headers.host || "";
    const hostName = host.split(":")[0];
    const isLoopback = hostName === "localhost" || hostName === "127.0.0.1" || hostName === "::1";
    const rawPath = urlPath.split("?")[0];
    const hasParams = urlPath.includes("mobile=1");
    if (
      rawPath === "/" &&
      !isLoopback &&
      !hasParams &&
      Number.isFinite(brokerPort) &&
      brokerPort > 0
    ) {
      const redirect = new URL(`http://${host}/`);
      redirect.searchParams.set("mobile", "1");
      redirect.searchParams.set("brokerWs", `ws://${hostName}:${brokerPort}/ui-ws`);
      res.writeHead(302, { Location: redirect.toString() });
      res.end();
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Pretty routes
    if (urlPath === "/") urlPath = "/index.html";
    if (urlPath === "/cost" || urlPath === "/cost/") urlPath = "/cost.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  async function handleApiRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    urlPath: string,
  ) {
    urlPath = normalizeApiRoutePath(urlPath);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/health") {
      // Keep the legacy `mirrorUrl` field name in the payload — the frontend
      // still reads it via the old name, and renaming is a churn-without-
      // benefit change scoped out of this migration.
      res.writeHead(200, { "Content-Type": "application/json" });
      const healthPayload: Record<string, unknown> = {
        status: "ok",
        mode: "embedded",
        mirrorUrl: globalState.localUrl,
      };
      const lanUrls = buildLanUrls(globalState.server?.port || PORT);
      if (!isLoopbackHost(BIND_HOST)) {
        healthPayload.bindHost = BIND_HOST;
        healthPayload.lanUrl = lanUrls[0] || null;
        healthPayload.lanUrls = lanUrls;
      }
      res.end(JSON.stringify(healthPayload));
      return;
    }

    if (urlPath === "/api/lan-qr" && req.method === "GET") {
      const lanUrls = buildLanUrls(globalState.server?.port || PORT);
      const url = lanUrls[0] || "";
      if (!url) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "LAN URL unavailable" }));
        return;
      }
      try {
        const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ dataUrl, url }));
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate QR code" }));
      }
      return;
    }

    if (urlPath === "/api/pi-version" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, version: EMBEDDED_PI_VERSION }));
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ instances: getRunningInstances() }));
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    if (urlPath.startsWith("/api/cost-dashboard") && req.method === "GET") {
      serveCostDashboard(req, res);
      return;
    }

    // Current git branch for the active workspace
    if (urlPath === "/api/git-branch" && req.method === "GET") {
      const gitBranchUrl = new URL(`http://localhost${req.url}`);
      const requestedPort = Number(gitBranchUrl.searchParams.get("foregroundPort"));
      const cwd = resolveGitBranchCwd({
        foregroundPort: Number.isFinite(requestedPort) ? requestedPort : null,
        fallbackCwd: process.cwd(),
        instances: getRunningInstances(),
        latestCtx,
      });
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }, (err, stdout) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (err) {
          res.end(JSON.stringify({ branch: null }));
          return;
        }
        const branch = stdout.toString().trim();
        res.end(JSON.stringify({ branch: branch || null }));
      });
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const explicitPath = filesUrl.searchParams.get("path");
        let dirPath = explicitPath || process.cwd();
        if (!explicitPath && latestCtx) {
          try {
            const entries = latestCtx.sessionManager.getEntries();
            const sessionEntry = entries.find((e: { type?: string }) => e.type === "session");
            if (sessionEntry?.cwd) dirPath = sessionEntry.cwd;
          } catch {}
        }
        serveFileList(res, dirPath);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMessage(err) }));
      }
      return;
    }

    // File browser: open file natively (or hand a URL off to the OS default browser).
    if (urlPath === "/api/open" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          execFile("open", [fp], (err) => {
            if (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: errMessage(err) }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          });
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(err) }));
        }
      });
      return;
    }

    // Session file endpoint: /api/sessions/:dirName/:file
    const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      serveSessionFile(res, sessionMatch[1], sessionMatch[2]);
      return;
    }

    // RPC proxy — handle via WebSocket command handler
    if (urlPath === "/api/rpc" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const command = JSON.parse(body);
          // Create a fake WebSocket-like object to capture the response
          const responsePromise = new Promise<unknown>((resolve) => {
            const fakeWs: UnifiedWS = {
              readyState: WS_OPEN,
              send: (data: string) => resolve(JSON.parse(data)),
              close: () => {},
              terminate: () => {},
              ping: () => {},
            };
            handleCommand(fakeWs, command);
          });
          const response = await responsePromise;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions/delete-batch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { filePaths } = JSON.parse(body);
          if (!Array.isArray(filePaths)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePaths must be an array" }));
            return;
          }

          let deleted = 0;
          const errors: string[] = [];
          const resolvedSessionsDir = path.resolve(SESSIONS_DIR);

          for (const fp of filePaths) {
            // Safety: must be a string, end with .jsonl, and resolve inside SESSIONS_DIR
            if (
              typeof fp !== "string" ||
              !fp.endsWith(".jsonl") ||
              !path.resolve(fp).startsWith(resolvedSessionsDir + path.sep)
            ) {
              errors.push(fp);
              continue;
            }
            try {
              await fs.promises.unlink(fp);
              globalState.sessionHeaderCache.delete(fp);
              globalState.sessionMetricsCache.delete(fp);
              deleted++;
            } catch {
              errors.push(fp);
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted, errors }));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    // Session switch — in embedded mode, this is a no-op (session is controlled by Picot).
    if (urlPath === "/api/sessions/switch" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          embedded: true,
          note: "Session switching is controlled by Picot's Rust side",
        }),
      );
      return;
    }

    if (urlPath === "/api/workspace/open" && req.method === "POST") {
      console.log("[Embedded] Received workspace open request");
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const { path: workspacePath } = JSON.parse(body);
          if (!workspacePath || typeof workspacePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          const resolved = workspacePath.startsWith("~")
            ? path.join(process.env.HOME || "", workspacePath.slice(1))
            : workspacePath;
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Directory not found: ${resolved}` }));
            return;
          }
          // Open a new terminal window running pi in the selected directory.
          // Note: this still uses the user's PATH `pi`, not the embedded one,
          // because Picot's own workspace flow lives in Tauri commands;
          // this endpoint is the legacy "open in external terminal" affordance.
          const { execSync } = require("node:child_process");
          const escaped = resolved.replace(/'/g, "'\\''");
          try {
            execSync(
              `osascript -e 'tell app "Terminal" to do script "cd '"'"'${escaped}'"'"' && pi"'`,
            );
          } catch {
            try {
              execSync(
                `osascript -e 'tell app "iTerm2" to create window with default profile command "cd '"'"'${escaped}'"'"' && pi"'`,
              );
            } catch {
              /* no terminal app available */
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, path: resolved }));
        } catch (e: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    // Agent config read/write
    if (urlPath === "/api/agent-config" && req.method === "GET") {
      try {
        const configPath = path.join(PI_AGENT_ROOT, "settings.json");
        const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "{}";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, content, path: configPath }));
      } catch (e: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: errMessage(e) }));
      }
      return;
    }

    if (urlPath === "/api/agent-config" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "content must be a string" }));
            return;
          }
          // Validate JSON before saving
          JSON.parse(content);
          const configPath = path.join(PI_AGENT_ROOT, "settings.json");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, content, "utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: errMessage(e) }));
        }
      });
      return;
    }

    // LLM providers / models.json read/write
    //
    // Exposes ~/.pi/agent/models.json — the file pi uses to declare custom
    // providers and models (Ollama, vLLM, LM Studio, OpenAI-compat proxies,
    // OpenRouter routing overrides, etc). See docs/models.md in the embedded
    // pi runtime for the schema. The frontend Settings → Configuration →
    // "LLM providers" panel reads and writes through these endpoints so users
    // never have to leave Picot to edit the file by hand.
    //
    // After a successful save we call modelRegistry.refresh() so the new
    // providers/models show up in the model picker immediately — matching the
    // pi behaviour where /model rereads models.json on each invocation.
    if (urlPath === "/api/models-config" && req.method === "GET") {
      try {
        const configPath = path.join(PI_AGENT_ROOT, "models.json");
        const content = fs.existsSync(configPath)
          ? fs.readFileSync(configPath, "utf8")
          : '{\n  "providers": {}\n}\n';
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, content, path: configPath }));
      } catch (e: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: errMessage(e) }));
      }
      return;
    }

    if (urlPath === "/api/models-config" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", async () => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "content must be a string" }));
            return;
          }
          // Validate as JSON before saving.
          const parsed = JSON.parse(content);
          // Light schema sanity check — pi itself does the real validation
          // on reload, but reject the obviously wrong shape early so users
          // get a clear error instead of a silently broken models.json.
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            if (
              "providers" in parsed &&
              (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
            ) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: "'providers' must be an object" }));
              return;
            }
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "models.json must be a JSON object" }));
            return;
          }
          const configPath = path.join(PI_AGENT_ROOT, "models.json");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, content, "utf8");
          // Reload pi's in-memory model registry so the picker sees the new
          // providers/models without restarting the workspace.
          // IMPORTANT: await refresh() so the registry is fully updated
          // before we respond — the frontend calls get_available_models
          // immediately after receiving our response, and without await it
          // would race against the async reload and return stale models.
          let refreshed = false;
          try {
            const registry = globalState.modelRegistry;
            if (registry && typeof (registry as { refresh?: unknown }).refresh === "function") {
              await (registry as { refresh: () => unknown }).refresh();
              refreshed = true;
            }
          } catch {
            // Non-fatal: file is saved, user can /reload or restart.
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, refreshed }));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: errMessage(e) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // Wraps `parseSessionFile` with an mtime+size keyed in-memory cache so we
  // only re-parse files that have actually changed since the last call.
  // A `null` parse result (file rejected by the trivial-session filter) is
  // also cached so we don't keep retrying. Also returns the stat so callers
  // can avoid a second `fs.statSync`.
  async function parseSessionFileCached(
    filePath: string,
    readline: typeof import("node:readline"),
  ) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      globalState.sessionHeaderCache.delete(filePath);
      return null;
    }

    const cached = globalState.sessionHeaderCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { parsed: cached.value, stat };
    }

    const parsed = await parseSessionFile(filePath, readline);
    globalState.sessionHeaderCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value: parsed,
    });
    return { parsed, stat };
  }

  // Drop cache entries for files that no longer exist under SESSIONS_DIR.
  // Cheap (single iteration over the Map keys) and bounds memory growth in
  // long-lived pi processes where users archive / delete sessions.
  function pruneSessionCaches(liveFiles: Set<string>) {
    for (const key of globalState.sessionHeaderCache.keys()) {
      if (!liveFiles.has(key)) globalState.sessionHeaderCache.delete(key);
    }
    for (const key of globalState.sessionMetricsCache.keys()) {
      if (!liveFiles.has(key)) globalState.sessionMetricsCache.delete(key);
    }
  }

  // Bounded async map to avoid EMFILE when users have many session files.
  async function mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const current = nextIndex++;
          if (current >= items.length) return;
          results[current] = await mapper(items[current]);
        }
      }),
    );

    return results;
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      const readline = await import("node:readline");
      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const liveFiles = new Set<string>();

      // Walk the tree first to build the (dir, files) work list and the
      // live-file set used for cache pruning. Parsing then happens in
      // parallel per project — most cost is fs.read on cold cache, and
      // bun + node handle a few hundred concurrent stream reads cheaply.
      const projectWork: {
        dirName: string;
        projectDir: string;
        files: string[];
        decodedPath: string;
      }[] = [];
      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(SESSIONS_DIR, dir.name);
        let files: string[] = [];
        try {
          files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          // Ignore inaccessible/removed project directories while listing.
          continue;
        }
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        for (const f of files) liveFiles.add(path.join(projectDir, f));
        projectWork.push({ dirName: dir.name, projectDir, files, decodedPath });
      }

      pruneSessionCaches(liveFiles);

      const projects = (
        await mapWithConcurrencyLimit(
          projectWork,
          8,
          async ({ dirName, projectDir, files, decodedPath }) => {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic session-list entries built by spreading parsed JSONL headers
            const sessions: any[] = [];
            const results = await mapWithConcurrencyLimit(files, 24, async (file) => {
              const filePath = path.join(projectDir, file);
              try {
                const result = await parseSessionFileCached(filePath, readline);
                if (!result?.parsed) return null;
                return {
                  ...result.parsed,
                  file,
                  filePath,
                  mtime: result.stat.mtimeMs,
                  ctime: result.stat.birthtimeMs,
                };
              } catch {
                return null;
              }
            });
            for (const r of results) {
              if (r) sessions.push(r);
            }

            sessions.sort((a, b) => {
              const aCreated = a.timestamp ? new Date(a.timestamp).getTime() : a.ctime || 0;
              const bCreated = b.timestamp ? new Date(b.timestamp).getTime() : b.ctime || 0;
              return bCreated - aCreated;
            });

            if (sessions.length === 0) return null;

            // Directory-name decoding is lossy for paths containing "-" (e.g. "pi-mono").
            // Prefer the real cwd recorded in session headers when available.
            const cwdCounts = new Map<string, number>();
            for (const s of sessions) {
              if (!s.cwd) continue;
              cwdCounts.set(s.cwd, (cwdCounts.get(s.cwd) || 0) + 1);
            }
            const inferredPath =
              Array.from(cwdCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || decodedPath;

            return { path: inferredPath, dirName, sessions };
          },
        )
      ).filter(
        // biome-ignore lint/suspicious/noExplicitAny: dynamic session-list entries
        (p): p is { path: string; dirName: string; sessions: any[] } => p !== null,
      );

      projects.sort((a, b) => {
        const aSession = a.sessions[0];
        const bSession = b.sessions[0];
        const aTime = aSession?.timestamp
          ? new Date(aSession.timestamp).getTime()
          : aSession?.ctime || 0;
        const bTime = bSession?.timestamp
          ? new Date(bSession.timestamp).getTime()
          : bSession?.ctime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) }));
    }
  }

  function parseDateOnly(value: string): Date | null {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  function parseRangeParams(req: http.IncomingMessage) {
    const reqUrl = req.url || "";
    const parsed = new URL(reqUrl, "http://localhost");
    const range = (parsed.searchParams.get("range") || "30d").toLowerCase();
    const granularity = (parsed.searchParams.get("granularity") || "day").toLowerCase();
    const scope = (parsed.searchParams.get("scope") || "all").toLowerCase();
    const modelsParam = parsed.searchParams.get("models") || "";
    const models = new Set(
      modelsParam
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );

    const now = new Date();
    let from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    let to = now;

    if (range === "7d") from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    else if (range === "90d") from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    else if (range === "custom") {
      const fromParam = parsed.searchParams.get("from");
      const toParam = parsed.searchParams.get("to");
      const parsedFrom = fromParam ? parseDateOnly(fromParam) : null;
      const parsedTo = toParam ? parseDateOnly(toParam) : null;
      if (parsedFrom) from = parsedFrom;
      if (parsedTo) to = parsedTo;
    }

    if (to < from) {
      const tmp = from;
      from = to;
      to = tmp;
    }

    return {
      from,
      to,
      range,
      granularity: granularity === "week" || granularity === "month" ? granularity : "day",
      scope: scope === "all" ? "all" : "current",
      models,
    };
  }

  async function parseSessionMetrics(
    filePath: string,
    readline: typeof import("node:readline"),
  ): Promise<SessionMetrics | null> {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const data: SessionMetrics = {
      id: "",
      title: "",
      cwd: "",
      timestamp: null,
      lastActive: null,
      model: "unknown",
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolCostByName: {} as Record<string, number>,
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!data.lastActive && entry.timestamp) {
          const ts = parseDateOnly(entry.timestamp);
          if (ts) data.lastActive = ts;
        } else if (entry.timestamp) {
          const ts = parseDateOnly(entry.timestamp);
          if (ts) data.lastActive = ts;
        }

        if (entry.type === "session") {
          data.id = entry.id || data.id;
          data.cwd = entry.cwd || data.cwd;
          if (entry.timestamp) {
            const ts = parseDateOnly(entry.timestamp);
            if (ts) data.timestamp = ts;
          }
          continue;
        }

        if (entry.type === "session_info" && entry.name) {
          data.title = entry.name;
          continue;
        }

        if (entry.type === "model_change" && entry.model) {
          data.model = entry.model;
          continue;
        }

        if (entry.type !== "message" || !entry.message) continue;
        const msg = entry.message;
        if (msg.role === "user") {
          data.userMessages += 1;
          continue;
        }

        if (msg.role !== "assistant") continue;
        data.assistantMessages += 1;

        if (typeof msg.model === "string" && msg.model) {
          data.model = msg.model;
        }

        const usage = msg.usage || {};
        const cost = Number(usage?.cost?.total || 0);
        data.totalCost += cost;
        data.inputTokens += Number(usage?.input || 0);
        data.outputTokens += Number(usage?.output || 0);
        data.cacheRead += Number(usage?.cacheRead || 0);
        data.cacheWrite += Number(usage?.cacheWrite || 0);

        const toolCalls = Array.isArray(msg.content)
          ? msg.content.filter(
              (b: { type?: string; name?: unknown }) =>
                b?.type === "toolCall" && typeof b?.name === "string",
            )
          : [];
        data.toolCalls += toolCalls.length;
        if (toolCalls.length > 0 && cost > 0) {
          const perToolCost = cost / toolCalls.length;
          for (const toolCall of toolCalls) {
            data.toolCostByName[toolCall.name] =
              (data.toolCostByName[toolCall.name] || 0) + perToolCost;
          }
        }
      } catch {
        // ignore malformed lines
      }
    }

    rl.close();
    stream.destroy();

    if (!data.id) return null;
    if (!data.lastActive) {
      const stat = fs.statSync(filePath);
      data.lastActive = new Date(stat.mtimeMs);
    }
    if (!data.timestamp) data.timestamp = data.lastActive;
    return data;
  }

  async function serveCostDashboard(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildEmptyCostDashboardPayload()));
        return;
      }

      const readline = await import("node:readline");
      const params = parseRangeParams(req);
      const currentWorkspace = (() => {
        try {
          return fs.realpathSync(process.cwd());
        } catch {
          return path.resolve(process.cwd());
        }
      })();

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const sessions: CostSession[] = [];

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = path.join(projectDir, file);
          // Cache-aware fetch: cost dashboard scans every session file in the
          // tree, which is dramatically more expensive than `/api/sessions`
          // because it parses every JSONL line (not just the header). The
          // mtime+size key means re-opening the dashboard reuses prior work
          // for any session that hasn't been written to since.
          let stat: fs.Stats;
          try {
            stat = fs.statSync(filePath);
          } catch {
            globalState.sessionMetricsCache.delete(filePath);
            continue;
          }
          let parsed: SessionMetrics | null;
          const cached = globalState.sessionMetricsCache.get(filePath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            parsed = cached.value as SessionMetrics;
          } else {
            parsed = await parseSessionMetrics(filePath, readline);
            globalState.sessionMetricsCache.set(filePath, {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              value: parsed,
            });
          }
          if (!parsed) continue;

          const sessionCwdResolved = (() => {
            try {
              return parsed.cwd ? fs.realpathSync(parsed.cwd) : "";
            } catch {
              return parsed.cwd ? path.resolve(parsed.cwd) : "";
            }
          })();
          if (
            params.scope === "current" &&
            sessionCwdResolved &&
            sessionCwdResolved !== currentWorkspace
          )
            continue;
          if (params.models.size > 0 && !params.models.has(parsed.model)) continue;

          const time = parsed.lastActive || parsed.timestamp;
          if (!time || time < params.from || time > params.to) continue;

          sessions.push({
            id: parsed.id,
            title: parsed.title || "Untitled",
            workspace: parsed.cwd || "",
            model: parsed.model || "unknown",
            time: time.toISOString(),
            totalCost: parsed.totalCost,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            cacheRead: parsed.cacheRead,
            cacheWrite: parsed.cacheWrite,
            totalTokens: parsed.inputTokens + parsed.outputTokens + parsed.cacheRead,
            toolCalls: parsed.toolCalls,
            userMessages: parsed.userMessages,
            assistantMessages: parsed.assistantMessages,
            costPerUserMessage:
              parsed.userMessages > 0 ? parsed.totalCost / parsed.userMessages : parsed.totalCost,
            toolCostByName: parsed.toolCostByName || {},
          });
        }
      }

      const payload = buildCostDashboardPayload(sessions, params, new Date());

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (e: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) || "Failed to build cost dashboard" }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFile(res: http.ServerResponse, dirName: string, file: string) {
    const filePath = path.join(SESSIONS_DIR, dirName, file);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous parsed JSONL entries
    const entries: any[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            /* skip */
          }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try {
          entries.push(JSON.parse(buffer));
        } catch {
          /* skip */
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) }));
    });
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: typeof import("node:readline")) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: { id?: string; timestamp?: string; cwd?: string } | null = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: { type?: string }) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch {
        /* skip */
      }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    if (!header?.id) return null;
    // Heuristic to suppress one-shot "pipe mode" invocations (no user input, no assistant turn).
    // Real interactive sessions write at least the session header + a model/thinking change pair,
    // and a brand-new chat with a single short user message can be as compact as ~7 lines, so we
    // only filter out trivially-short files that have NO user messages at all.
    if (userMessageCount === 0 && lineCount <= 4) return null;

    return {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules",
    ".git",
    "__pycache__",
    ".DS_Store",
    ".Trash",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".cache",
    ".turbo",
    "venv",
    ".venv",
    "env",
    ".env.local",
    ".pi",
    "coverage",
    ".nyc_output",
    ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      // biome-ignore lint/suspicious/noExplicitAny: dynamic file-browser entries (name/isDirectory/etc.)
      const items: any[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (IGNORED_NAMES.has(entry.name)) continue;

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {
          /* skip inaccessible */
        }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(err) }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      // biome-ignore lint/suspicious/noExplicitAny: dynamic search result rows
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));

        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = path.join(projectDir, file);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let firstMessage = "";
            let sessionWorkspace = decodedPath;
            // biome-ignore lint/suspicious/noExplicitAny: dynamic search match rows
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                  if (typeof entry.cwd === "string" && entry.cwd.trim()) {
                    sessionWorkspace = entry.cwd;
                  }
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content
                      .filter((b: { type?: string }) => b.type === "text")
                      .map((b: { text?: string }) => b.text)
                      .join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text?.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet =
                      (start > 0 ? "…" : "") +
                      text.substring(start, end) +
                      (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch {
                /* skip line */
              }
            }

            rl.close();
            stream.destroy();

            const projectMatch = buildProjectSearchMatch(q, sessionWorkspace);
            if (projectMatch && !matches.some((match) => match.role === "project")) {
              matches.unshift(projectMatch);
            }

            if (matches.length > 0) {
              results.push({
                filePath,
                project: sessionWorkspace,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch {
            /* skip file */
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(err) }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable across extension reloads)
  // ═══════════════════════════════════════
  //
  // The HTTP/WS server is process-scoped (see `globalState`). On the first
  // session_start of the pi process we actually create and bind the server.
  // On every subsequent session_start (after new_session / switch_session /
  // fork → extension reload), we just re-publish the current session's
  // command handler / state-snapshot builder / latest ctx into the global so
  // the long-lived `wss.on("connection", …)` callback below dispatches to
  // the new session. This is what keeps the WebView's URL alive across
  // session changes.
  function startServer(ctx: ExtensionContext) {
    // Always (re)publish per-session bindings — these are what every
    // request and WS message dispatches through.
    globalState.handleCommand = handleCommand;
    globalState.buildStateSnapshot = buildStateSnapshot;
    globalState.getLatestCtx = () => latestCtx;
    globalState.getApi = () => pi;

    // Re-register the instance entry with the *current* session file so
    // `/api/instances` reports the right session.
    if (globalState.server) {
      const port = globalState.server.port;
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());
      return;
    }

    // ─── Common: per-client lifecycle ────────────────────────────────────
    //
    // Both the Bun.serve and node http+ws paths funnel new connections
    // through `onClientConnected` so the rest of the system (handleCommand,
    // broadcast, heartbeat) doesn't care which runtime is underneath.
    function onClientConnected(ws: UnifiedWS) {
      console.log("[Embedded] Browser client connected");
      globalState.clients.add(ws);
      ws.isAlive = true;

      sendTo(ws, { type: "state", isStreaming: false, mode: "embedded" });

      const currentCtx = globalState.getLatestCtx?.() ?? null;
      const snapshotBuilder = globalState.buildStateSnapshot;
      if (currentCtx && snapshotBuilder) {
        snapshotBuilder(currentCtx)
          .then((snapshot) => {
            sendTo(ws, snapshot);
          })
          .catch((err) => {
            console.error("[Embedded] Failed to build initial snapshot:", err);
          });
      }
    }

    function onClientMessage(ws: UnifiedWS, raw: string | ArrayBuffer | Buffer) {
      try {
        const text =
          typeof raw === "string"
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString();
        const incoming = JSON.parse(text);
        const command =
          incoming?.type === "broker_command"
            ? { ...(incoming.payload || {}), id: incoming.payload?.id ?? incoming.requestId }
            : incoming;
        const dispatch = globalState.handleCommand;
        if (dispatch) {
          dispatch(ws, command);
        } else {
          sendTo(ws, {
            type: "response",
            command: command?.type || "unknown",
            success: false,
            error: "No active session",
            id: command?.id,
          });
        }
      } catch (e) {
        console.error("[Embedded] Failed to parse client message:", e);
      }
    }

    function onClientClosed(ws: UnifiedWS) {
      console.log("[Embedded] Browser client disconnected");
      globalState.clients.delete(ws);
    }

    // ─── Heartbeat (process-scoped, identical across runtimes) ───────────
    //
    // Removes stale clients (the WebView usually closes cleanly, but
    // ungraceful disconnects need a reaper). The Bun ServerWebSocket has
    // `.ping()` but not `.terminate()` — we fall back to `.close()` in the
    // wrapper exposed via UnifiedWS.
    globalState.heartbeatTimer = setInterval(() => {
      for (const client of globalState.clients) {
        if (client.readyState !== WS_OPEN) {
          globalState.clients.delete(client);
          continue;
        }
        if (!client.isAlive) {
          try {
            client.terminate();
          } catch {}
          globalState.clients.delete(client);
          continue;
        }
        client.isAlive = false;
        try {
          client.ping();
        } catch {}
      }
    }, 20000);

    // ─── Path A: Bun runtime ─────────────────────────────────────────────
    //
    // The bundled `pi` is compiled with `bun build --compile`, where the
    // node-style `http.createServer().on("upgrade", ...)` path silently
    // drops `socket.write` and the handshake never completes. `Bun.serve`
    // has a native upgrade path that works.
    if (HAS_BUN_SERVE) {
      const tryBunListen = (port: number, maxAttempts = 10) => {
        try {
          const bunServer = Bun.serve({
            port,
            hostname: BIND_HOST,
            // Sustained streaming responses (e.g. SSE / long polls hitting
            // our REST surface) should not be killed by Bun's default 10s
            // idle timeout. 0 = disable.
            idleTimeout: 0,
            fetch: bunFetchHandler,
            websocket: {
              open(ws: unknown) {
                onClientConnected(ws as UnifiedWS);
              },
              message(ws: unknown, msg: string | Buffer) {
                onClientMessage(ws as UnifiedWS, msg);
              },
              close(ws: unknown) {
                onClientClosed(ws as UnifiedWS);
              },
              drain() {
                /* no-op; backpressure is fine for our small JSON messages */
              },
              // Bun marks the client as alive on any pong it receives; we
              // expose a hook to flip the heartbeat sentinel.
              pong(ws: unknown) {
                (ws as UnifiedWS).isAlive = true;
              },
            },
          });
          onListening(port);
          globalState.server = {
            port,
            close: () => {
              try {
                (bunServer as { stop?: (force?: boolean) => void }).stop?.(true);
              } catch {}
            },
            nodeServer: null,
            bunServer,
          };
        } catch (err: unknown) {
          const msg = errMessage(err);
          // Bun surfaces EADDRINUSE as both `err.code === "EADDRINUSE"`
          // and as a message containing the literal string, depending on
          // version. Check both.
          const errCode = (err as { code?: string } | null)?.code;
          if (
            (errCode === "EADDRINUSE" || msg.includes("EADDRINUSE")) &&
            port < PORT + maxAttempts
          ) {
            console.log(`[Embedded] Port ${port} in use, trying ${port + 1}...`);
            tryBunListen(port + 1, maxAttempts);
          } else {
            console.error(`[Embedded] Failed to start Bun server:`, msg);
          }
        }
      };

      // Adapt our existing node-style `serveStaticFile(req, res)` API to
      // Bun's `fetch(Request) => Response` shape. The WS upgrade has to
      // short-circuit *before* the adapter runs, because once `req.body`
      // is consumed by the adapter the upgrade window is gone.
      //
      // Static asset requests bypass the adapter entirely: Bun's native
      // `Bun.file(path)` already supports byte ranges, content-type
      // inference, and zero-copy streaming, and the adapter's buffered
      // body approach would defeat all of that for the 200+ KB JS bundle.
      async function bunFetchHandler(req: Request, server: unknown): Promise<Response | undefined> {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if ((server as { upgrade: (req: Request) => boolean }).upgrade(req)) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        if (!url.pathname.startsWith("/api/")) {
          return serveStaticAssetBun(url, req);
        }
        return runNodeStyleHandler(req);
      }

      // Native Bun static serving — mirrors the routing in `serveStaticFile`
      // (pretty `/` and `/cost` paths, directory traversal guard, 404 on
      // missing files) but reads via `Bun.file` so large assets stream
      // straight from disk without going through our buffering adapter.
      async function serveStaticAssetBun(url: URL, req: Request): Promise<Response> {
        let urlPath = url.pathname;

        // Auto-redirect remote browsers to the full mobile URL.
        const brokerPort = Number.parseInt(process.env.PI_STUDIO_BROKER_PORT || "", 10);
        const host = req.headers.get("host") || url.host;
        const hostName = host.split(":")[0];
        const isLoopback =
          hostName === "localhost" || hostName === "127.0.0.1" || hostName === "::1";
        if (
          urlPath === "/" &&
          !isLoopback &&
          !url.searchParams.has("mobile") &&
          Number.isFinite(brokerPort) &&
          brokerPort > 0
        ) {
          const redirect = new URL(`http://${host}/`);
          redirect.searchParams.set("mobile", "1");
          redirect.searchParams.set("brokerWs", `ws://${hostName}:${brokerPort}/ui-ws`);
          return Response.redirect(redirect.toString(), 302);
        }

        if (urlPath === "/") urlPath = "/index.html";
        if (urlPath === "/cost" || urlPath === "/cost/") urlPath = "/cost.html";

        const filePath = path.join(STATIC_DIR, urlPath);
        // Guard against directory-traversal. We do this with the resolved
        // filesystem path rather than the URL path so symlink shenanigans
        // can't escape STATIC_DIR either.
        if (!filePath.startsWith(STATIC_DIR)) {
          return new Response("Forbidden", { status: 403 });
        }

        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            return new Response("Not Found", { status: 404 });
          }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || file.type || "application/octet-stream";
          return new Response(file as unknown as BodyInit, {
            headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
          });
        } catch (err: unknown) {
          return new Response(`Internal error: ${errMessage(err)}`, { status: 500 });
        }
      }

      tryBunListen(PORT);
      return;
    }

    // ─── Path B: Node runtime fallback (dev/jiti) ────────────────────────
    //
    // Real Node.js doesn't have the bun upgrade bug, so the original
    // ws-on-http.createServer path is fine here. We keep it so
    // `tauri dev` (which loads the .ts source via jiti and node) still
    // works.
    const server = http.createServer((req, res) => serveStaticFile(req, res));
    const wss = new WebSocketServer({ noServer: true });
    globalState.wss = wss;

    server.on("upgrade", (request, socket, head) => {
      if (request.url === "/ws") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws: WebSocket) => {
      // The `ws` library's WebSocket is structurally compatible with
      // UnifiedWS once we add the `isAlive` flag, except it uses
      // EventEmitter rather than fields for delivery. Wire those events
      // into the shared lifecycle hooks.
      const wrapped = ws as unknown as UnifiedWS;
      onClientConnected(wrapped);

      ws.on("pong", () => {
        wrapped.isAlive = true;
      });
      ws.on("message", (data) => {
        onClientMessage(wrapped, data as Buffer);
      });
      ws.on("close", () => {
        onClientClosed(wrapped);
      });
      ws.on("error", (e) => {
        console.error("[Embedded] Client error:", e);
        globalState.clients.delete(wrapped);
      });
    });

    const tryListen = (port: number, maxAttempts = 10) => {
      // Picot's mobile dev mode is always reachable from the local network.
      server.listen(port, BIND_HOST, () => {
        onListening(port);
        globalState.server = {
          port,
          close: () => {
            try {
              server.close();
            } catch {}
          },
          nodeServer: server,
          bunServer: null,
        };
      });
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          console.log(`[Embedded] Port ${port} in use, trying ${port + 1}...`);
          server.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error("[Embedded] Failed to start server:", errMessage(err));
        }
      });
    };

    function onListening(port: number) {
      const localHost = isLoopbackHost(BIND_HOST) ? BIND_HOST : "127.0.0.1";
      globalState.localUrl = `http://${localHost}:${port}`;
      const lanUrls = buildLanUrls(port);
      globalState.lanUrl = lanUrls[0] || "";
      console.log(`[Embedded] Picot embedded server running on ${globalState.localUrl}`);
      const statusTarget = !isLoopbackHost(BIND_HOST)
        ? `${BIND_HOST}:${port}${globalState.lanUrl ? ` (${globalState.lanUrl})` : ""}`
        : `${BIND_HOST}:${port}`;
      ctx.ui.setStatus("embedded", `Embedded: ${statusTarget}`);
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());
    }

    tryListen(PORT);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Request adapter: convert a `Request` (web-fetch) into the node-style
  // `(req, res)` pair our existing handlers expect, then run `serveStaticFile`
  // and resolve to the final `Response`.
  //
  // Why we keep the node-style API:
  //   - `handleApiRoute` and friends are 1000+ lines of hand-rolled
  //     `res.writeHead(...)` / `res.end(...)` / `req.on("data", ...)`
  //     code. Rewriting all of it to return Response objects would be a
  //     much larger change and a much bigger risk of regression than
  //     the small adapter below.
  //
  // Things to know about this adapter:
  //   - We collect the body up-front (`await req.text()`) and feed it
  //     through synthetic `data` + `end` events. The request body sizes
  //     we deal with (RPC commands, agent-config saves) are tiny, so the
  //     buffering overhead is negligible.
  //   - We don't try to support streaming responses through this adapter:
  //     all our endpoints either return JSON in one shot or stream a
  //     session JSONL file fully into memory before writing. If a future
  //     endpoint needs true response streaming, it should branch on
  //     HAS_BUN_SERVE and return a Bun Response with a ReadableStream.
  // ═══════════════════════════════════════════════════════════════════════
  async function runNodeStyleHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const bodyText = req.method !== "GET" && req.method !== "HEAD" ? await req.text() : "";

    return await new Promise<Response>((resolve) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      // Build a minimal IncomingMessage-shaped object. Only the fields
      // our handlers actually touch are emulated; everything else is a
      // sealed `undefined` to fail loudly if a handler ever reaches for
      // something Bun.serve can't provide.
      const dataListeners: Array<(chunk: unknown) => void> = [];
      const endListeners: Array<() => void> = [];
      const reqLike: Record<string, unknown> = {
        url: url.pathname + url.search,
        method: req.method,
        headers,
        // Only `data`/`end` are consumed by our POST handlers — see
        // /api/rpc, /api/agent-config (PUT), etc.
        on(event: string, fn: (chunk?: unknown) => void) {
          if (event === "data") dataListeners.push(fn);
          else if (event === "end") endListeners.push(fn as () => void);
          return reqLike;
        },
      };

      let resolved = false;
      let statusCode = 200;
      const resHeaders: Record<string, string> = {};
      const bodyChunks: Array<Buffer> = [];
      const resLike: Record<string, unknown> = {
        setHeader(name: string, value: string) {
          resHeaders[name] = value;
        },
        writeHead(code: number, maybeHeaders?: Record<string, string>) {
          statusCode = code;
          if (maybeHeaders) {
            for (const [k, v] of Object.entries(maybeHeaders)) {
              resHeaders[k] = v;
            }
          }
        },
        write(chunk: unknown) {
          if (chunk == null) return;
          bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        },
        end(chunk?: unknown) {
          if (resolved) return;
          resolved = true;
          if (chunk != null) {
            bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const body = Buffer.concat(bodyChunks);
          resolve(new Response(body, { status: statusCode, headers: resHeaders }));
        },
      };

      // Special case: session JSONL streaming. `serveSessionFile` uses
      // `fs.createReadStream(...).pipe(res)`. Our adapter doesn't
      // implement pipe, so emulate it with `on("data")`+`on("end")`.
      // We attach the pipe shim only when the handler tries to use it.
      resLike.pipe = undefined;
      resLike.on = (_event: string, _fn: unknown) => resLike;

      try {
        serveStaticFile(
          reqLike as unknown as http.IncomingMessage,
          resLike as unknown as http.ServerResponse,
        );
      } catch (err: unknown) {
        if (!resolved) {
          resolved = true;
          resolve(new Response(`Internal error: ${errMessage(err)}`, { status: 500 }));
        }
      }

      // Deliver the buffered body to the handler. Doing this *after*
      // calling `serveStaticFile` ensures the handler has already
      // registered its `data`/`end` listeners.
      if (bodyText) {
        for (const fn of dataListeners) fn(Buffer.from(bodyText));
      }
      for (const fn of endListeners) fn();
    });
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    rememberCtx(ctx);
    startServer(ctx);

    // Push a fresh state snapshot to every already-connected client.
    //
    // Why: pi reloads this extension on `switch_session` / `new_session` /
    // `fork`, which fires `session_shutdown` on the old instance and
    // `session_start` on the new one. The HTTP/WS server is process-scoped
    // and survives that reload (see `EmbeddedServerGlobal`), so the
    // WebView's existing WS connection stays open across the swap. Without
    // an explicit re-broadcast, those clients would keep showing the old
    // session's entries — `buildStateSnapshot` is otherwise only sent on
    // *new* connections in the `wss.on("connection", …)` handler above.
    //
    // We send the same `mirror_sync` payload `handleMirrorSync` already
    // knows how to consume, so the UI replays history, updates the model
    // label, and re-anchors `mirrorActiveSessionFile` to the new session.
    if (globalState.clients.size === 0) return;
    try {
      const snapshot = await buildStateSnapshot(ctx);
      broadcast(snapshot);
    } catch (err) {
      console.error("[Embedded] Failed to broadcast post-switch snapshot:", err);
    }
  });

  // ═══════════════════════════════════════
  // Per-session teardown (NOT process shutdown — see EmbeddedServerGlobal)
  // ═══════════════════════════════════════
  pi.on("session_shutdown", async () => {
    // Drop our captured ctx so we don't accidentally use a torn-down session
    // before the next instance re-publishes its bindings.
    latestCtx = null;
    // Tear down the global pointers IFF they still point at *this* instance,
    // so any WS messages that arrive in the gap before the next
    // session_start fail cleanly with "No active session" instead of hitting
    // a stale handler. We use identity on the bound `handleCommand` closure
    // to detect "still this instance".
    if (globalState.handleCommand === handleCommand) {
      globalState.handleCommand = null;
      globalState.buildStateSnapshot = null;
      globalState.getLatestCtx = null;
      globalState.getApi = null;
    }
    console.log("[Embedded] Session shutdown (server stays up)");
  });
}
