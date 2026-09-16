// Host preference gateway: sends `host_request` frames for `ui.*` display
// preferences and resolves the matching `host_response`. Mirrors the request
// correlation pattern of HostDataGateway — requests are correlated by a
// `preference-` prefixed requestId; error frames reject the pending call.

const DEFAULT_TIMEOUT_MS = 10_000;

export class PreferenceGateway {
  #adapter;
  #generation = 0;
  #nextRequestId = 1;
  #pending = new Map();
  #timeoutMs;

  constructor(adapter, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#adapter = adapter;
    this.#timeoutMs = timeoutMs;
    adapter.setReceiver((frame) => this.#receive(frame));
    adapter.setConnectionListener?.((connected) => {
      if (!connected) this.#disconnect();
    });
  }

  get(key) {
    return this.#request("get_preference", { key });
  }

  set(key, value) {
    return this.#request("set_preference", { key, value });
  }

  remove(key) {
    return this.#request("remove_preference", { key });
  }

  /** Reject every pending call and ignore late responses. */
  dispose() {
    this.#disconnect();
  }

  #request(operation, parameters) {
    const requestId = `preference-${this.#nextRequestId++}`;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      let timeout = null;
      if (Number.isFinite(this.#timeoutMs) && this.#timeoutMs > 0) {
        timeout = setTimeout(() => {
          this.#pending.delete(requestId);
          reject(new Error("Preference request timed out"));
        }, this.#timeoutMs);
      }
      this.#pending.set(requestId, { resolve, reject, generation, timeout });
      try {
        this.#adapter.send({
          type: "host_request",
          requestId,
          operation,
          ...parameters,
        });
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.#pending.delete(requestId);
        reject(error);
      }
    }).then((frame) => {
      if (operation === "get_preference") return frame.value ?? null;
      if (operation === "remove_preference") return Boolean(frame.removed);
      return frame.value;
    });
  }

  #receive(frame) {
    if (frame?.type !== "host_response" && frame?.type !== "error") return;
    const pending = this.#pending.get(frame?.requestId);
    if (!pending || pending.generation !== this.#generation) return;
    this.#pending.delete(frame.requestId);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (frame.type === "error") {
      pending.reject(
        new Error(frame.error?.message ?? String(frame.error?.code ?? "preference failed")),
      );
    } else {
      pending.resolve(frame);
    }
  }

  #disconnect() {
    this.#generation += 1;
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(new Error("Host disconnected before the preference request completed"));
    }
    this.#pending.clear();
  }
}
