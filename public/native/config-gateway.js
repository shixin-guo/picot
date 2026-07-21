// Client for the Picot Configuration data plane.
//
// pi's native RPC command set is fixed and cannot be extended, so Configuration
// operations (model catalog, API keys, agent-config / models.json files) are
// served by the `picot-config` command registered in the picot-bridge
// extension. We invoke it by sending a native RPC `prompt` of the form
// `/picot-config <json>` — extension commands execute immediately without
// hitting the LLM or session history. The handler returns its result through
// `ctx.ui.notify(JSON)`, which arrives here as a `notify` extension-UI event.
// We correlate requests and responses by a per-call id.
//
// `consumeNotify(request)` must be called for every incoming `notify` event; it
// returns true when the notification was a config response (and should NOT be
// rendered as a chat message), false otherwise.

import { randomId } from "./random-id.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export class ConfigGateway {
  #runtime;
  #getTarget;
  #pending = new Map();

  constructor({ runtime, getTarget }) {
    this.#runtime = runtime;
    this.#getTarget = getTarget;
  }

  // Invoke a configuration operation. Resolves with the handler payload
  // `{ ok: boolean, data?, error? }`. Rejects only on transport/timeout errors.
  call(op, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const target = this.#getTarget();
    if (!target) return Promise.reject(new Error("No active session for configuration request"));
    const id = `cfg-${randomId()}`;
    const message = `/picot-config ${JSON.stringify({ id, op, params })}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Configuration request "${op}" timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#runtime
        .request({ type: "prompt", message }, target, { idempotencyKey: id })
        .catch((error) => {
          const pending = this.#pending.get(id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(id);
          reject(error);
        });
    });
  }

  // Returns true if the notification was a config response (consumed).
  consumeNotify(request) {
    const message = request?.message;
    if (typeof message !== "string" || !message.includes("__picotConfig")) return false;
    let payload;
    try {
      payload = JSON.parse(message);
    } catch {
      return false;
    }
    const id = payload?.__picotConfig;
    if (typeof id !== "string") return false;
    const pending = this.#pending.get(id);
    if (!pending) return true; // ours, but already settled/timed out — still swallow it
    clearTimeout(pending.timer);
    this.#pending.delete(id);
    const { __picotConfig, ...result } = payload;
    pending.resolve(result);
    return true;
  }
}
