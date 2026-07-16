// ABOUTME: Maintains the broker WebSocket, authentication handshake, and reconnect state.
// ABOUTME: Dispatches correlated control, session, and owner-scoped ephemeral frames.

/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

const BROKER_WS_STORAGE_KEY = "pi-studio:broker-ws-url";

// The shared broker URL is delivered to each page via the `?brokerWs=` query
// param (the Rust host appends it when opening a window, and in-app navigations
// carry it forward — see workspace-actions.withBrokerWs). We persist it to
// sessionStorage so a reload without the param still finds it. Keeping this in
// the transport-agnostic WS layer means the frontend does not depend on any
// desktop-specific bridge to discover the broker.
export function resolveBrokerWsUrl(env = globalThis.window || globalThis) {
  try {
    const loc = env?.location || globalThis.location;
    const search = loc?.search || "";
    const fromUrl = new URLSearchParams(search).get("brokerWs");
    if (fromUrl) {
      env?.sessionStorage?.setItem?.(BROKER_WS_STORAGE_KEY, fromUrl);
      return fromUrl;
    }
    return env?.sessionStorage?.getItem?.(BROKER_WS_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function resolveWebSocketUrl(env = globalThis.window || globalThis) {
  const brokerUrl = resolveBrokerWsUrl(env);
  if (brokerUrl.trim()) {
    return brokerUrl.trim();
  }

  const loc = env?.location || globalThis.location;
  const protocol = loc?.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${loc?.host || "127.0.0.1:47821"}/ws`;
}

export class WebSocketClient extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = Infinity;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 10000;
    this.isIntentionallyClosed = false;
    this.reconnectTimer = null;
    this.connectionState = "idle";
    this.protocolVersion = 1;
    this.workspaceId = null;
    this.sessionId = null;
    this.sourcePort = null;
    this.requestCounter = 0;
    // Whether the broker advertised native (OS/window) capabilities. Updated by
    // the authenticated `capabilities` handshake frame; consumers gate native-only
    // UI on it.
    this.capabilities = { native: false };
    // True once the broker has authenticated our `client_hello`. `connected` only
    // fires after this, so no command is sent before the owner/class is verified.
    this.authenticated = false;
    this._pendingConnect = false;
    // Pending control requests keyed by requestId. Each entry resolves/rejects
    // the promise returned by sendControl() when a matching control_response
    // arrives (or on timeout / disconnect). `onProgress` receives streamed
    // control_progress frames (e.g. updater download chunks).
    this.pendingControls = new Map();
    this.controlTimeoutMs = 30000;
  }

  setRoutingContext({ workspaceId, sessionId, sourcePort }) {
    if (typeof workspaceId === "string" && workspaceId.trim())
      this.workspaceId = workspaceId.trim();
    if (sessionId === null) this.sessionId = null;
    if (typeof sessionId === "string" && sessionId.trim()) this.sessionId = sessionId.trim();
    if (sourcePort === null) this.sourcePort = null;
    if (typeof sourcePort === "number" && Number.isFinite(sourcePort)) {
      this.sourcePort = sourcePort;
    }
    console.debug("[WS route] setRoutingContext", {
      workspaceId: this.workspaceId,
      sessionId: this.sessionId,
      sourcePort: this.sourcePort,
    });
  }

  connect() {
    if (this.connectionState === "connecting") return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = "connecting";
    this._pendingConnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close only fully stale sockets before reconnecting
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)
    ) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("[WS] Open; sending client_hello");
      this.reconnectAttempts = 0;
      this.connectionState = "open";
      this.authenticated = false;
      this._sendClientHello();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error("[WS] Failed to parse message:", error);
      }
    };

    this.ws.onerror = (error) => {
      console.error("[WS] Error:", error);
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || "n/a"})`);
      this.connectionState = "closed";
      this.dispatchEvent(new CustomEvent("disconnected"));

      this.rejectAllControls(new Error("WebSocket disconnected"));

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = "closed";
    this.authenticated = false;
    this._pendingConnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  // Force reconnect — resets attempt counter and connects fresh
  forceReconnect() {
    this.reconnectAttempts = 0;
    this.isIntentionallyClosed = false;
    this.connectionState = "closed";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close(1000, "force reconnect");
      } catch (_e) {}
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[WS] Max reconnection attempts reached");
      this.dispatchEvent(new CustomEvent("reconnectFailed"));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.maxReconnectDelay,
      this.reconnectDelay * 2 ** (this.reconnectAttempts - 1),
    );

    console.log(
      `[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Prefer broker envelope, while remaining backward-compatible with
      // servers that still expect raw command payloads.
      const payload =
        data && data.type === "broker_command"
          ? data
          : {
              type: "broker_command",
              protocolVersion: this.protocolVersion,
              requestId: `req-${++this.requestCounter}`,
              workspaceId: this.workspaceId || undefined,
              sessionId: this.sessionId || undefined,
              sourcePort: this.sourcePort || undefined,
              payload: data,
            };
      console.debug("[WS route] send", {
        command: payload.payload?.type || payload.type,
        requestId: payload.requestId,
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        sourcePort: payload.sourcePort,
      });
      this.ws.send(JSON.stringify(payload));
      // Return the requestId so callers can correlate a later
      // `command_undeliverable` reply back to the message they sent.
      return payload.requestId || null;
    } else {
      console.error("[WS] Cannot send, not connected");
      return null;
    }
  }

  // Read the host-injected native bearer capability exactly once, then delete
  // the global. The value is never logged or persisted to storage.
  _readNativeCapability() {
    try {
      const capability = globalThis.__PICOT_NATIVE_CAPABILITY__;
      if (typeof capability === "string" && capability) {
        try {
          delete globalThis.__PICOT_NATIVE_CAPABILITY__;
        } catch {
          // ignore non-configurable globals
        }
        return capability;
      }
    } catch {
      // ignore access errors
    }
    return null;
  }

  // Send the first-frame `client_hello`. Native clients present the injected
  // capability; remote (LAN/mobile) clients send a bare hello with no secret.
  _sendClientHello() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const capability = this._readNativeCapability();
    const hello = { type: "client_hello", protocolVersion: this.protocolVersion };
    if (capability) hello.capability = capability;
    try {
      this.ws.send(JSON.stringify(hello));
    } catch (err) {
      console.error("[WS] Failed to send client_hello:", err);
    }
  }

  // Send an owner-scoped ephemeral command and return its requestId. The broker
  // derives the owner from the authenticated connection, never from the payload.
  sendEphemeral(instanceId, generation, payload) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const requestId = `ep-${++this.requestCounter}`;
      const envelope = {
        type: "ephemeral_command",
        protocolVersion: this.protocolVersion,
        requestId,
        ephemeralInstanceId: instanceId,
        generation,
        payload,
      };
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (err) {
        console.error("[WS] Failed to send ephemeral command:", err);
        return null;
      }
      return requestId;
    }
    console.error("[WS] Cannot send ephemeral command, not connected");
    return null;
  }

  // Resolve once the socket is OPEN, or reject after `timeoutMs`. Lets control
  // commands sent during startup wait briefly for the broker connection instead
  // of failing the race between page load and the WS handshake.
  waitForOpen(timeoutMs = 5000) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeEventListener("connected", onConnected);
        reject(new Error("WebSocket not connected"));
      }, timeoutMs);
      const onConnected = () => {
        clearTimeout(timer);
        this.removeEventListener("connected", onConnected);
        resolve();
      };
      this.addEventListener("connected", onConnected);
    });
  }

  // Send a control command (process/window lifecycle or native op handled by
  // the broker host, not forwarded to a pi upstream) and resolve with the
  // broker's result. Mirrors the promise semantics of a Tauri `invoke()` so
  // callers can stay transport-agnostic. `onProgress` (optional) receives
  // streamed control_progress frames; `timeoutMs` overrides the default for
  // long/interactive ops (folder picker, updater download).
  //
  // When already connected we register + send synchronously (snappy + makes the
  // requestId correlation deterministic). When not yet connected we wait briefly
  // for the broker handshake to win the page-load race before sending.
  sendControl(command, args = {}, options = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return this._sendControlNow(command, args, options);
    }
    return this.waitForOpen().then(() => this._sendControlNow(command, args, options));
  }

  _sendControlNow(command, args = {}, { onProgress = null, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("WebSocket not connected; cannot send control command"));
        return;
      }
      const requestId = `ctl-${++this.requestCounter}`;
      const entry = { resolve, reject, onProgress, timer: null };
      const effectiveTimeout = typeof timeoutMs === "number" ? timeoutMs : this.controlTimeoutMs;
      if (effectiveTimeout > 0) {
        entry.timer = setTimeout(() => {
          if (this.pendingControls.has(requestId)) {
            this.pendingControls.delete(requestId);
            reject(new Error(`Control command "${command}" timed out`));
          }
        }, effectiveTimeout);
      }
      this.pendingControls.set(requestId, entry);

      const envelope = {
        type: "broker_control",
        protocolVersion: this.protocolVersion,
        requestId,
        command,
        args: args || {},
      };
      try {
        this.ws.send(JSON.stringify(envelope));
      } catch (err) {
        if (entry.timer) clearTimeout(entry.timer);
        this.pendingControls.delete(requestId);
        reject(err);
      }
    });
  }

  resolveControl(message) {
    const requestId = message?.requestId;
    if (!requestId) return;
    const pending = this.pendingControls.get(requestId);
    if (!pending) return;
    this.pendingControls.delete(requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok === false) {
      pending.reject(new Error(message.error || "Control command failed"));
    } else {
      pending.resolve(message.result);
    }
  }

  handleControlProgress(message) {
    const pending = this.pendingControls.get(message?.requestId);
    if (pending && typeof pending.onProgress === "function") {
      try {
        pending.onProgress(message.data);
      } catch (err) {
        console.error("[WS] control progress handler failed:", err);
      }
    }
  }

  rejectAllControls(error) {
    for (const [, pending] of this.pendingControls) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingControls.clear();
  }

  handleMessage(message, route = null) {
    if (message.type === "broker_event") {
      const payload = message.payload || {};
      // Extract routing metadata from the broker envelope but do NOT call
      // setRoutingContext here — incoming events must not silently hijack the
      // routing context that the user (or an explicit session-select action)
      // set. If session B streams an event while the user is viewing session A,
      // the next command must still go to A.
      const eventRoute = {
        workspaceId: message.workspaceId || payload.workspaceId || undefined,
        sessionId: message.sessionId || payload.sessionId || undefined,
        sourcePort: message.sourcePort || payload.port || undefined,
      };
      console.debug("[WS route] broker_event", {
        payloadType: payload.type,
        eventType: payload.event?.type,
        workspaceId: eventRoute.workspaceId,
        sessionId: eventRoute.sessionId,
        sourcePort: eventRoute.sourcePort,
      });
      this.dispatchEvent(new CustomEvent("brokerEvent", { detail: message }));
      this.handleMessage(payload, eventRoute);
      return;
    }

    // Broker reply for a broker_control we sent (requestId-keyed).
    if (message.type === "control_response") {
      this.resolveControl(message);
      this.dispatchEvent(new CustomEvent("controlResponse", { detail: message }));
      return;
    }

    // The broker could not route/deliver a broker_command we sent (the target
    // pi process is gone or no session is reachable). Surface it so a dropped
    // prompt does not vanish silently — callers correlate via requestId.
    if (message.type === "command_undeliverable") {
      this.dispatchEvent(new CustomEvent("commandUndeliverable", { detail: message }));
      return;
    }

    // Streamed progress for an in-flight broker_control (e.g. updater download).
    if (message.type === "control_progress") {
      this.handleControlProgress(message);
      return;
    }

    // Broker capability handshake — authenticates the client and tells the UI
    // whether native (OS/window) operations are available (class "native"
    // inside the desktop host, "remote" for LAN/mobile).
    if (message.type === "capabilities") {
      const cls = message.class === "native" ? "native" : "remote";
      this.capabilities = {
        native: cls === "native" || Boolean(message.native),
        class: cls,
      };
      this.authenticated = true;
      this.dispatchEvent(new CustomEvent("capabilities", { detail: this.capabilities }));
      if (this._pendingConnect) {
        this._pendingConnect = false;
        console.log("[WS] Authenticated; connected");
        this.dispatchEvent(new CustomEvent("connected"));
      }
      return;
    }

    // Owner-scoped bootstrap (live ephemeral descriptors) for a native client.
    if (message.type === "owner_bootstrap") {
      this.dispatchEvent(new CustomEvent("ownerBootstrap", { detail: message }));
      return;
    }

    // A sequenced event from one of this owner's ephemeral runtimes.
    if (message.type === "ephemeral_event") {
      this.dispatchEvent(new CustomEvent("ephemeralEvent", { detail: message }));
      return;
    }

    // An ephemeral command could not be routed/delivered (correlated by
    // requestId); the error is generic and never reveals instance existence.
    if (message.type === "ephemeral_command_failed") {
      this.dispatchEvent(new CustomEvent("ephemeralCommandFailed", { detail: message }));
      return;
    }

    // Host-targeted window close request: the coordinator runs its serialized
    // risk/settlement flow and replies with window_close_approve.
    if (message.type === "window_close_request") {
      this.dispatchEvent(new CustomEvent("windowCloseRequest", { detail: message }));
      return;
    }

    // Emit events based on message type
    switch (message.type) {
      case "event":
        this.dispatchEvent(
          new CustomEvent("rpcEvent", {
            detail: message.event
              ? {
                  ...message.event,
                  __broker: route,
                }
              : message.event,
          }),
        );
        break;
      case "state":
        this.dispatchEvent(new CustomEvent("stateUpdate", { detail: message }));
        break;
      case "error":
        this.dispatchEvent(new CustomEvent("serverError", { detail: message }));
        break;
      case "response":
        // Broker acknowledgment for a broker_command we sent (requestId-keyed).
        // No frontend handler needed currently; dispatch for future use.
        this.dispatchEvent(new CustomEvent("commandResponse", { detail: message }));
        break;
      case "session_switch":
        this.dispatchEvent(new CustomEvent("sessionSwitch"));
        break;
      case "mirror_sync":
        // Do NOT call setRoutingContext here. The broker broadcasts every
        // upstream's `mirror_sync` to all UI clients, so a snapshot emitted by
        // a *background* pi process (e.g. the previously-running session that
        // keeps streaming after the user switched away) must not silently
        // hijack the routing context — otherwise the user's next command would
        // be routed to that background session. Routing context is owned by the
        // app layer (`handleMirrorSync`), which guards against background
        // snapshots by source port. Surface the source port so it can decide.
        if (message.port == null && route?.sourcePort != null) {
          message = { ...message, port: route.sourcePort };
        }
        this.dispatchEvent(new CustomEvent("mirrorSync", { detail: message }));
        break;
      default:
        console.warn("[WS] Unknown message type:", message.type);
    }
  }
}
