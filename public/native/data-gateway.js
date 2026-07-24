const READ_OPERATIONS = new Set([
  "list_files",
  "list_sessions",
  "list_all_sessions",
  "search_sessions",
  "cost_dashboard",
  "workspace_info",
  "read_session_messages",
]);

const DEFAULT_SESSION_LIST_HTTP_TIMEOUT_MS = 1500;
const DEFAULT_HOST_READY_TIMEOUT_MS = 2000;
const DEFAULT_DATA_REQUEST_TIMEOUT_MS = 15000;

export class HostDataGateway {
  #adapter;
  #fetch;
  #generation = 0;
  #hostReadyTimeoutMs;
  #location;
  #dataRequestTimeoutMs;
  #nextRequestId = 1;
  #pending = new Map();
  #sessionListHttpTimeoutMs;

  constructor(
    adapter,
    {
      fetchImpl = null,
      location = globalThis.location,
      sessionListHttpTimeoutMs = DEFAULT_SESSION_LIST_HTTP_TIMEOUT_MS,
      hostReadyTimeoutMs = DEFAULT_HOST_READY_TIMEOUT_MS,
      dataRequestTimeoutMs = DEFAULT_DATA_REQUEST_TIMEOUT_MS,
    } = {},
  ) {
    this.#adapter = adapter;
    this.#fetch = fetchImpl;
    this.#hostReadyTimeoutMs = hostReadyTimeoutMs;
    this.#location = location;
    this.#dataRequestTimeoutMs = dataRequestTimeoutMs;
    this.#sessionListHttpTimeoutMs = sessionListHttpTimeoutMs;
    adapter.setReceiver((frame) => this.#receive(frame));
    adapter.setConnectionListener?.((connected) => {
      if (!connected) this.#disconnect();
    });
  }

  async request(operation, parameters = {}) {
    if (!READ_OPERATIONS.has(operation)) {
      throw new Error(`Unsupported read-only data operation: ${operation}`);
    }
    if (typeof this.#adapter.ready === "function") {
      await this.#withTimeout(
        this.#adapter.ready(),
        this.#hostReadyTimeoutMs,
        "Host connection timed out before the data request could start",
      );
    }
    const requestId = `data-${this.#nextRequestId++}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      let timeout = null;
      if (Number.isFinite(this.#dataRequestTimeoutMs) && this.#dataRequestTimeoutMs > 0) {
        timeout = setTimeout(() => {
          this.#pending.delete(requestId);
          reject(new Error("Host data request timed out"));
        }, this.#dataRequestTimeoutMs);
      }
      this.#pending.set(requestId, { resolve, reject, generation, timeout });
      try {
        this.#adapter.send({
          type: "data_request",
          requestId,
          operation,
          ...parameters,
        });
      } catch (error) {
        this.#pending.delete(requestId);
        if (timeout) clearTimeout(timeout);
        reject(error);
      }
    });
  }

  listFiles(workspaceId, path = "") {
    return this.request("list_files", { workspaceId, path });
  }

  listSessions(workspaceId) {
    return this.request("list_sessions", { workspaceId });
  }

  // Sessions across every project, grouped by project in the sidebar. Sessions
  // belonging to `workspaceId` are tagged `isCurrentWorkspace: true`.
  listAllSessions(workspaceId) {
    if (this.#fetch) {
      return this.#listAllSessionsHttp(workspaceId).catch(() =>
        this.request("list_all_sessions", { workspaceId }),
      );
    }
    return this.request("list_all_sessions", { workspaceId });
  }

  searchSessions(workspaceId, query) {
    return this.request("search_sessions", { workspaceId, query });
  }

  costDashboard(workspaceId) {
    return this.request("cost_dashboard", { workspaceId });
  }

  workspaceInfo(workspaceId) {
    return this.request("workspace_info", { workspaceId });
  }

  /**
   * Read session messages directly from the on-disk JSONL file, without
   * waiting for the Pi process to start. Returns the same message format
   * as the runtime snapshot so `renderHistory` can consume it immediately.
   * Used as the fast path during session switching.
   */
  readSessionMessages(workspaceId, sessionId) {
    return this.request("read_session_messages", { workspaceId, sessionId });
  }

  async #listAllSessionsHttp(workspaceId) {
    const url = new URL("/v2/sessions", this.#location?.origin ?? globalThis.location?.origin);
    url.searchParams.set("workspaceId", workspaceId);
    const response = await this.#fetchWithTimeout(url, this.#sessionListHttpTimeoutMs);
    if (!response.ok) throw new Error("Session list request failed");
    return response.json();
  }

  #fetchWithTimeout(url, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return this.#fetch(url);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timeout = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        controller?.abort();
        reject(new Error("Session list HTTP request timed out"));
      }, timeoutMs);
    });
    const fetchPromise = controller
      ? this.#fetch(url, { signal: controller.signal })
      : this.#fetch(url);
    return Promise.race([fetchPromise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  #withTimeout(promise, timeoutMs, message) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timeout = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  #receive(frame) {
    const pending = this.#pending.get(frame?.requestId);
    if (!pending || pending.generation !== this.#generation) return;
    this.#pending.delete(frame.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (frame.error) pending.reject(new Error(frame.error.message ?? String(frame.error)));
    else pending.resolve(frame);
  }

  #disconnect() {
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Host disconnected before the data request completed"));
    }
    this.#pending.clear();
  }
}
