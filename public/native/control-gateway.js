// Host control gateway: sends `host_request` frames over the native /v2/ws
// protocol and resolves the matching `host_response`. This is the write-capable
// counterpart to the read-only HostDataGateway — it covers package management
// and opening external links, which run the embedded `pi` CLI on the Rust host.
//
// Requests are correlated by a `host-` prefixed requestId; frames that don't
// match a pending request are ignored (other gateways share the same adapter).
export class HostControlGateway {
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

  #request(operation, parameters = {}) {
    const requestId = `host-${this.#nextRequestId++}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, generation });
      try {
        this.#adapter.send({
          type: "host_request",
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

  async listPiPackages() {
    const frame = await this.#request("list_pi_packages");
    return Array.isArray(frame?.packages) ? frame.packages : [];
  }

  async installPiPackage(source) {
    await this.#request("install_pi_package", { source });
  }

  async removePiPackage(source) {
    await this.#request("remove_pi_package", { source });
  }

  async listInstalledApps() {
    const frame = await this.#request("list_installed_apps");
    return Array.isArray(frame?.apps) ? frame.apps : [];
  }

  async openInApp(path, { appName = null, command = null } = {}) {
    await this.#request("open_in_app", { path, appName, command });
  }

  async openExternal(url) {
    await this.#request("open_external", { url });
  }

  // Permanently deletes saved sessions (by id) from disk. Best effort: the
  // response's `errors` lists ids that could not be removed; callers should
  // only drop successfully-deleted ids from local state.
  async deleteSessions(sessionIds) {
    const frame = await this.#request("delete_sessions", { sessionIds });
    return {
      deleted: Array.isArray(frame?.deleted) ? frame.deleted : [],
      errors: Array.isArray(frame?.errors) ? frame.errors : [],
    };
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
      pending.reject(new Error("Host disconnected before the control request completed"));
    }
    this.#pending.clear();
  }
}
