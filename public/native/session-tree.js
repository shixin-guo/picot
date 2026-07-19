export class SessionTreeController {
  #lifecycle;
  #runtime;
  #target;
  #tree = { tree: [], leafId: null };

  constructor({ runtime, target, lifecycle }) {
    this.#runtime = runtime;
    this.#target = target;
    this.#lifecycle = lifecycle;
  }

  current() {
    return structuredClone(this.#tree);
  }

  hydrate(tree) {
    this.#tree = structuredClone(tree);
  }

  async load() {
    const result = await this.#runtime.request({ type: "get_tree" }, this.#target);
    const tree = result?.response?.data ?? result?.data;
    if (!tree || !Array.isArray(tree.tree)) throw new Error("Pi returned an invalid session tree");
    this.hydrate(tree);
    return this.current();
  }

  async navigate(targetId, options) {
    if (this.#lifecycle() !== "idle") {
      throw new Error("Session tree navigation requires an idle runtime");
    }
    const args = {
      targetId,
      summarize: Boolean(options?.summarize),
      ...(options?.customInstructions ? { customInstructions: options.customInstructions } : {}),
      ...(options?.replaceInstructions !== undefined
        ? { replaceInstructions: options.replaceInstructions }
        : {}),
      ...(options?.label ? { label: options.label } : {}),
    };
    await this.#runtime.request(
      { type: "prompt", message: `/picot-navigate-tree ${JSON.stringify(args)}` },
      this.#target,
      { idempotencyKey: intentId() },
    );
    return this.#runtime.snapshot(this.#target.sessionId);
  }
}

function intentId() {
  return globalThis.crypto?.randomUUID?.() ?? `tree-${Date.now()}-${Math.random()}`;
}
