const BLOCKING_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function renderExtensionText(element, value) {
  element.textContent = String(value ?? "");
}

export class ExtensionUiHost {
  #foregroundSessionId = null;
  #hooks;
  #queues = new Map();
  #runtime;
  #showDialog;

  constructor({ runtime, showDialog = async () => ({ cancelled: true }), hooks = {} }) {
    this.#runtime = runtime;
    this.#showDialog = showDialog;
    this.#hooks = hooks;
  }

  pendingCount(sessionId) {
    return this.#queues.get(sessionId)?.length ?? 0;
  }

  async setForegroundSession(sessionId) {
    this.#foregroundSessionId = sessionId;
    const queue = this.#queues.get(sessionId) ?? [];
    this.#queues.delete(sessionId);
    for (const pending of queue) await this.#showAndRespond(pending.target, pending.request);
  }

  async handle(target, request) {
    if (request?.type !== "extension_ui_request" || !request.id || !request.method) return;
    if (BLOCKING_METHODS.has(request.method)) {
      if (target.sessionId !== this.#foregroundSessionId) {
        const queue = this.#queues.get(target.sessionId) ?? [];
        queue.push({ target: structuredClone(target), request: structuredClone(request) });
        this.#queues.set(target.sessionId, queue);
        return;
      }
      await this.#showAndRespond(target, request);
      return;
    }
    switch (request.method) {
      case "notify":
        this.#hooks.notify?.(request);
        break;
      case "setStatus":
        this.#hooks.status?.(request);
        break;
      case "setWidget":
        this.#hooks.widget?.(request);
        break;
      case "setTitle":
        this.#hooks.title?.(request);
        break;
      case "set_editor_text":
        this.#hooks.editorText?.(request);
        break;
      default:
        await this.#runtime.request(
          {
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
            error: "unsupported",
          },
          target,
        );
    }
  }

  async cancelSession(target) {
    const queue = this.#queues.get(target.sessionId) ?? [];
    this.#queues.delete(target.sessionId);
    for (const pending of queue) {
      await this.#runtime.request(
        { type: "extension_ui_response", id: pending.request.id, cancelled: true },
        pending.target,
      );
    }
  }

  async #showAndRespond(target, request) {
    let result;
    try {
      result = await this.#showDialog(structuredClone(request));
    } catch {
      result = { cancelled: true };
    }
    const response = {
      type: "extension_ui_response",
      id: request.id,
      ...(result && typeof result === "object" ? result : { cancelled: true }),
    };
    await this.#runtime.request(response, target);
  }
}
