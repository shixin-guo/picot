const POLL_INTERVAL_MS = 500;

function sessionParameters(session, operation) {
  return {
    machineId: session.machineId,
    sessionId: session.id,
    cwd: session.projectPath,
    operation,
  };
}

async function parseResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data?.error || `Remote session request failed: ${response.status}`);
  return data;
}

export class RemoteSessionGateway {
  #fetch;
  #pollTimer = null;
  #pollGeneration = 0;

  constructor(fetchImpl = globalThis.fetch) {
    this.#fetch = fetchImpl;
  }

  async get(session, operation) {
    const url = new URL("/v2/remote-session", globalThis.location?.origin || "http://localhost");
    for (const [key, value] of Object.entries(sessionParameters(session, operation))) {
      url.searchParams.set(key, value);
    }
    return parseResponse(await this.#fetch(url.pathname + url.search, { cache: "no-store" }));
  }

  async post(session, operation, payload = {}) {
    return parseResponse(
      await this.#fetch("/v2/remote-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sessionParameters(session, operation), payload }),
      }),
    );
  }

  async create(session) {
    return parseResponse(
      await this.#fetch("/v2/remote-session/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machineId: session.machineId, cwd: session.projectPath }),
      }),
    );
  }

  async snapshot(session) {
    const [history, status, stream] = await Promise.all([
      this.get(session, "messages"),
      this.get(session, "status"),
      this.get(session, "stream-snapshot"),
    ]);
    const messages = Array.isArray(history?.messages) ? [...history.messages] : [];
    if (stream?.partial) messages.push(stream.partial);
    return { messages, status, stream };
  }

  async configuration(session) {
    const [models, thinking, commands] = await Promise.all([
      this.get(session, "models"),
      this.get(session, "thinking-levels"),
      this.get(session, "commands"),
    ]);
    return {
      models: Array.isArray(models?.models) ? models.models : [],
      thinkingLevels: Array.isArray(thinking?.levels) ? thinking.levels : [],
      commands: Array.isArray(commands) ? commands : [],
    };
  }

  prompt(session, { text, streamingBehavior = "steer", attachments = [] }) {
    return this.post(session, "prompt", { text, streamingBehavior, attachments });
  }

  abort(session) {
    return this.post(session, "abort");
  }

  setModel(session, provider, modelId) {
    return this.post(session, "model", { provider, modelId });
  }

  cycleThinkingLevel(session) {
    return this.post(session, "thinking-level/cycle");
  }

  startPolling(session, onSnapshot, onError) {
    this.stopPolling();
    const generation = this.#pollGeneration;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || generation !== this.#pollGeneration) return;
      inFlight = true;
      try {
        const snapshot = await this.snapshot(session);
        if (generation === this.#pollGeneration) onSnapshot(snapshot);
      } catch (error) {
        if (generation === this.#pollGeneration) onError?.(error);
      } finally {
        inFlight = false;
      }
    };
    void tick();
    this.#pollTimer = setInterval(tick, POLL_INTERVAL_MS);
  }

  stopPolling() {
    this.#pollGeneration += 1;
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
  }
}
