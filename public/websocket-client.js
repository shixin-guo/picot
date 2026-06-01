/**
 * WebSocket Client - Handles connection to backend WebSocket server
 */

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
    this.connectionState = 'idle';
    this.protocolVersion = 1;
    this.workspaceId = null;
    this.sessionId = null;
    this.requestCounter = 0;
  }

  setRoutingContext({ workspaceId, sessionId }) {
    if (typeof workspaceId === 'string' && workspaceId.trim()) this.workspaceId = workspaceId.trim();
    if (typeof sessionId === 'string' && sessionId.trim()) this.sessionId = sessionId.trim();
  }

  connect() {
    if (this.connectionState === 'connecting') return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;

    this.isIntentionallyClosed = false;
    this.connectionState = 'connecting';
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Close only fully stale sockets before reconnecting
    if (this.ws && (this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED)) {
      this.ws = null;
    }
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected');
      this.reconnectAttempts = 0;
      this.connectionState = 'open';
      this.dispatchEvent(new CustomEvent('connected'));
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } catch (error) {
        console.error('[WS] Failed to parse message:', error);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
      this.dispatchEvent(new CustomEvent('error', { detail: error }));
    };

    this.ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code=${event.code}, reason=${event.reason || 'n/a'})`);
      this.connectionState = 'closed';
      this.dispatchEvent(new CustomEvent('disconnected'));

      if (!this.isIntentionallyClosed) {
        this.attemptReconnect();
      }
    };
  }

  disconnect() {
    this.isIntentionallyClosed = true;
    this.connectionState = 'closed';
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
    this.connectionState = 'closed';
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(1000, 'force reconnect'); } catch (e) {}
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  attemptReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[WS] Max reconnection attempts reached');
      this.dispatchEvent(new CustomEvent('reconnectFailed'));
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.maxReconnectDelay, this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1));
    
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Prefer broker envelope, while remaining backward-compatible with
      // servers that still expect raw command payloads.
      const payload = (data && data.type === 'broker_command') ? data : {
        type: 'broker_command',
        protocolVersion: this.protocolVersion,
        requestId: `req-${++this.requestCounter}`,
        workspaceId: this.workspaceId || undefined,
        sessionId: this.sessionId || undefined,
        payload: data,
      };
      this.ws.send(JSON.stringify(payload));
    } else {
      console.error('[WS] Cannot send, not connected');
    }
  }

  handleMessage(message) {
    if (message.type === 'broker_event') {
      const payload = message.payload || {};
      this.dispatchEvent(new CustomEvent('brokerEvent', { detail: message }));
      if (message.workspaceId || message.sessionId) {
        this.setRoutingContext({
          workspaceId: message.workspaceId || undefined,
          sessionId: message.sessionId || undefined,
        });
      }
      this.handleMessage(payload);
      return;
    }

    // Emit events based on message type
    switch (message.type) {
      case 'event':
        this.dispatchEvent(new CustomEvent('rpcEvent', { detail: message.event }));
        break;
      case 'state':
        this.dispatchEvent(new CustomEvent('stateUpdate', { detail: message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('serverError', { detail: message }));
        break;
      case 'response':
        // Broker acknowledgment for a broker_command we sent (requestId-keyed).
        // No frontend handler needed currently; dispatch for future use.
        this.dispatchEvent(new CustomEvent('commandResponse', { detail: message }));
        break;
      case 'session_switch':
        this.dispatchEvent(new CustomEvent('sessionSwitch'));
        break;
      case 'mirror_sync':
        if (message.workspaceId || message.sessionId) {
          this.setRoutingContext({
            workspaceId: message.workspaceId || undefined,
            sessionId: message.sessionId || undefined,
          });
        }
        this.dispatchEvent(new CustomEvent('mirrorSync', { detail: message }));
        break;
      default:
        console.warn('[WS] Unknown message type:', message.type);
    }
  }
}
