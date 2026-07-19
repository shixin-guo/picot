const READ_OPERATIONS = new Set([
  "list_files",
  "list_sessions",
  "search_sessions",
  "cost_dashboard",
]);

export class HostDataGateway {
  #adapter;
  #generation = 0;
  #nextRequestId = 1;
  #pending = new Map();

  constructor(adapter) {
    this.#adapter = adapter;
    adapter.setReceiver((frame) => this.#receive(frame));
    adapter.setConnectionListener?.((connected) => {
      if (!connected) this.#disconnect();
    });
  }

  request(operation, parameters = {}) {
    if (!READ_OPERATIONS.has(operation)) {
      return Promise.reject(new Error(`Unsupported read-only data operation: ${operation}`));
    }
    const requestId = `data-${this.#nextRequestId++}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, generation });
      try {
        this.#adapter.send({
          type: "data_request",
          requestId,
          operation,
          ...parameters,
        });
      } catch (error) {
        this.#pending.delete(requestId);
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

  searchSessions(workspaceId, query) {
    return this.request("search_sessions", { workspaceId, query });
  }

  costDashboard(workspaceId) {
    return this.request("cost_dashboard", { workspaceId });
  }

  #receive(frame) {
    const pending = this.#pending.get(frame?.requestId);
    if (!pending || pending.generation !== this.#generation) return;
    this.#pending.delete(frame.requestId);
    if (frame.error) pending.reject(new Error(frame.error.message ?? String(frame.error)));
    else pending.resolve(frame);
  }

  #disconnect() {
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      pending.reject(new Error("Host disconnected before the data request completed"));
    }
    this.#pending.clear();
  }
}
