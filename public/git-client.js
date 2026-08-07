// ABOUTME: Sends owner-scoped Git broker commands with workspace-generation binding.
// ABOUTME: Correlates replies and clears pending requests when the workspace changes.

export class GitClient {
  constructor({ send, timeoutMs = 10000 } = {}) {
    this.send = send;
    this.timeoutMs = timeoutMs;
    this.generation = null;
    this.counter = 0;
    this.pending = new Map();
    this.pendingWrites = new Set();
  }
  setWorkspaceGeneration(value) {
    const generation = Number(value);
    if (!Number.isSafeInteger(generation) || generation < 0) return false;
    if (this.generation !== null && this.generation !== generation) this.reset();
    this.generation = generation;
    return true;
  }
  command(payload = {}, frameType = "git_command") {
    if (this.generation === null) return null;
    const requestId = `git-${++this.counter}`;
    this.send?.({
      type: frameType,
      requestId,
      workspaceGeneration: this.generation,
      command: payload,
    });
    return requestId;
  }
  diff(snapshotId, group, pathBytesBase64, comparison) {
    return this.command({ type: "diff", snapshotId, group, pathBytesBase64, comparison });
  }
  write(operation, snapshotId, entries) {
    const requestId = this.command({ type: operation, snapshotId, entries });
    if (requestId) this.pendingWrites.add(requestId);
    return requestId;
  }
  consumeWriteAck(message) {
    if (message?.workspaceGeneration !== this.generation) return false;
    const requestId = message?.requestId;
    if (!this.pendingWrites.has(requestId)) return false;
    this.pendingWrites.delete(requestId);
    return true;
  }
  consumeWriteFailure(message) {
    if (message?.workspaceGeneration !== this.generation) return false;
    return this.pendingWrites.delete(message?.requestId);
  }
  aiCommitMessage() {
    return this.command({}, "git_ai_commit_message");
  }
  commit(snapshotId, message, confirmationToken = null) {
    return this.command({ type: "commit", snapshotId, message, confirmationToken });
  }
  sendAndAwait(payload, matcher = null, timeoutMs = this.timeoutMs) {
    if (this.generation === null) return Promise.resolve(null);
    const requestId = `git-${++this.counter}`;
    const promise = this._await(
      requestId,
      matcher || ((message) => message?.requestId === requestId),
      timeoutMs,
    );
    this.send?.({
      type: "git_command",
      requestId,
      workspaceGeneration: this.generation,
      command: payload,
    });
    return promise;
  }
  _await(requestId, matcher, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(requestId, {
        matcher,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
    });
  }
  resolveResponse(message) {
    const entry = this.pending.get(message?.requestId);
    if (!entry?.matcher(message)) return false;
    this.pending.delete(message.requestId);
    entry.resolve(message);
    return true;
  }
  reset() {
    for (const entry of this.pending.values()) entry.resolve(null);
    this.pending.clear();
    this.pendingWrites.clear();
    this.generation = null;
  }
}
