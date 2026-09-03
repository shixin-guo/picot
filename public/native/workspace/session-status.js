/**
 * Header connection/run status.
 *
 * Kept out of `app.js` because that module has top-level `await`s. Runtime
 * status hooks (and locale changes) can fire while `app.js` is paused, and a
 * `let statusKind` in that module would still be in the TDZ.
 */
export function createSessionStatus({ t }) {
  const state = {
    kind: "connecting",
    customText: "",
  };
  let ui = null;

  function applyHostStatus(statusText) {
    const raw = String(statusText || "");
    if (raw === "Working…" || raw === "Working...") {
      setStatus("working");
      return;
    }
    if (raw === "Disconnected") {
      setStatus("disconnected");
      return;
    }
    if (!raw || raw === "Connected") {
      setStatus("connected");
      return;
    }
    setStatus("custom", raw);
  }

  function statusLabel() {
    switch (state.kind) {
      case "working":
        return t("status.working");
      case "disconnected":
        return t("status.disconnected");
      case "loading":
        return t("status.loading");
      case "connecting":
        return t("status.connecting");
      case "custom":
        return state.customText;
      default:
        return t("status.connected");
    }
  }

  function renderStatus() {
    if (!ui?.statusPill) return;
    const working = state.kind === "working";
    ui.statusPill.kind = state.kind;
    ui.statusPill.label = statusLabel();
    const showAbort = working || Boolean(ui.hasPending?.(ui.getSessionId?.()));
    ui.composerCard?.classList.toggle("streaming", working);
    ui.abortButton?.classList.toggle("hidden", !showAbort);
    ui.sendButton?.classList.toggle("hidden", showAbort);
  }

  function setStatus(kind, customText = "") {
    state.kind = kind;
    state.customText = customText;
    renderStatus();
  }

  function bind(nextUi) {
    ui = nextUi;
    renderStatus();
  }

  return {
    applyHostStatus,
    bind,
    getKind: () => state.kind,
    renderStatus,
    setStatus,
  };
}
