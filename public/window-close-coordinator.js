// ABOUTME: Single serialized window-close transaction: collects versioned risk,
// ABOUTME: settles files, cleans ephemeral chats, then approves the host close.

/**
 * Owns the only window-close decision flow. File + ephemeral features register
 * as risk/settlement participants; the coordinator freezes interaction, shows
 * one summary dialog, settles in order, and approves only on success.
 */
export class WindowCloseCoordinator {
  constructor({ transport, showSummaryDialog }) {
    this.transport = transport;
    this.showSummaryDialog = showSummaryDialog || (async () => "discard");
    this.participants = new Map();
    this._activeRequest = null;
    this._activePromise = null;
    this._onBeforeUnload = (event) => {
      if (!this._hasDirtyFiles()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    globalThis.window?.addEventListener?.("beforeunload", this._onBeforeUnload);
  }

  registerParticipant(name, participant) {
    if (!name || !participant) return;
    this.participants.set(name, participant);
  }

  setGlobalInteractionLock(locked) {
    for (const participant of this.participants.values()) {
      participant.setInteractionLocked?.(locked);
    }
  }

  handleHostCloseRequest(requestId) {
    // Serialize: a repeated request for the in-flight id joins the active flow.
    if (this._activeRequest === requestId) return this._activePromise;
    if (this._activeRequest) {
      // A different close request while one is active: focus the active dialog.
      return this._activePromise;
    }
    this._activeRequest = requestId;
    this._activePromise = this._run(requestId);
    return this._activePromise;
  }

  destroy() {
    globalThis.window?.removeEventListener?.("beforeunload", this._onBeforeUnload);
    this._resetTransaction(true);
    this.participants.clear();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  async _run(requestId) {
    try {
      this.setGlobalInteractionLock(true);
      let confirmedEphemeralSig = null;
      for (;;) {
        const risk = this._collectRisk();
        const hasRisk =
          risk.dirtyFiles.length > 0 ||
          risk.ephemeralChats.some((chat) => chat.hasMessages || chat.streaming);
        if (!hasRisk) {
          await this._finish(requestId);
          return;
        }
        const currentEphemeralSig = ephemeralSignature(risk);
        if (currentEphemeralSig === confirmedEphemeralSig) {
          // Ephemeral risk matches what the user already confirmed — proceed.
          // Dirty files either were settled (shrank, which is expected) or
          // settlement failed (caught by the remaining.dirtyFiles check below).
          await this._finish(requestId);
          return;
        }
        const decision = await this.showSummaryDialog(risk, {
          getCurrentRisk: () => this._collectRisk(),
        });
        if (!decision || decision === "cancel") {
          this._resetTransaction(true);
          return;
        }
        // Capture the ephemeral risk state at resolution time. A live-updating
        // dialog may have shown the user an expanded view before they clicked;
        // respect that by snapshotting AFTER the dialog resolves.
        confirmedEphemeralSig = ephemeralSignature(this._collectRisk());
        // Settle file buffers before any ephemeral participant. File settlement
        // may change the risk, so it is always re-read afterwards.
        const participants = Array.from(this.participants.entries()).sort(([a], [b]) => {
          if (a === "file") return -1;
          if (b === "file") return 1;
          return 0;
        });
        for (const [, participant] of participants) {
          if (participant.settleCloseRisk) await participant.settleCloseRisk(decision);
        }
        const remaining = this._collectRisk();
        if (remaining.dirtyFiles.length > 0) {
          // File settlement failed (e.g. save error): keep the window open.
          this._resetTransaction(true);
          return;
        }
        // Loop: if post-settlement ephemeral risk matches what the user
        // confirmed, the next iteration proceeds. If ephemeral risk expanded
        // during file settlement, the signature differs and the dialog re-opens.
      }
    } catch {
      this._resetTransaction(true);
    }
  }

  async _finish(requestId) {
    for (const participant of this.participants.values()) {
      participant.cleanupAfterHostClose?.();
    }
    await this.transport.approveWindowClose(requestId);
    this._resetTransaction();
  }

  _resetTransaction(cancelHost = false) {
    const requestId = this._activeRequest;
    this.setGlobalInteractionLock(false);
    this._activeRequest = null;
    this._activePromise = null;
    if (cancelHost && requestId && typeof this.transport.cancelWindowClose === "function") {
      void Promise.resolve(this.transport.cancelWindowClose(requestId)).catch(() => {});
    }
  }

  _hasDirtyFiles() {
    return this._collectRisk().dirtyFiles.length > 0;
  }

  _collectRisk() {
    let dirtyFiles = [];
    let ephemeralChats = [];
    for (const participant of this.participants.values()) {
      const risk = participant.getCloseRisk?.();
      if (!risk) continue;
      if (Array.isArray(risk.dirtyFiles)) dirtyFiles = dirtyFiles.concat(risk.dirtyFiles);
      if (Array.isArray(risk)) {
        ephemeralChats = ephemeralChats.concat(risk);
      } else if (Array.isArray(risk.ephemeralChats)) {
        ephemeralChats = ephemeralChats.concat(risk.ephemeralChats);
      } else if (risk.instanceId) {
        ephemeralChats.push(risk);
      }
    }
    return { version: 3, dirtyFiles, ephemeralChats };
  }
}

function ephemeralSignature(risk) {
  return (risk?.ephemeralChats || [])
    .filter((c) => c?.hasMessages || c?.streaming)
    .map(
      (c) =>
        `${c?.instanceId || ""}:${c?.generation || 0}:${c?.hasMessages ? "m" : ""}:${c?.streaming ? "s" : ""}`,
    )
    .sort()
    .join("|");
}
