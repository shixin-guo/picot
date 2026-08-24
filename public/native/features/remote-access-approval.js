import { onLocaleChange, t } from "../../i18n.js";

const POLL_INTERVAL_MS = 2000;
const MAX_DEVICE_LABEL_LENGTH = 128;

function safeLabel(value) {
  const clean = String(value ?? "").replace(/\p{Cc}/gu, "");
  return clean.slice(0, MAX_DEVICE_LABEL_LENGTH) || t("remoteApproval.unknownDevice");
}

export function setupRemoteAccessApproval({
  fetchImpl = globalThis.fetch,
  root = document.body,
  windowImpl = globalThis.window,
  documentImpl = globalThis.document,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  let stopped = false;
  let timer = null;
  let polling = false;
  let controller = null;
  let activeRequestId = null;
  const requests = new Map();
  const previousFocus = documentImpl.activeElement;
  let backgroundElements = [];

  const clearPollTimer = () => {
    if (timer !== null) {
      windowImpl.clearTimeout(timer);
      timer = null;
    }
  };
  const schedulePoll = (delay = pollIntervalMs) => {
    clearPollTimer();
    if (stopped) return;
    timer = windowImpl.setTimeout(() => {
      timer = null;
      void poll();
    }, delay);
  };
  const setBackgroundContained = (contained) => {
    if (contained) {
      backgroundElements = Array.from(root.children).filter(
        (element) => !element.classList.contains("remote-access-approval-overlay"),
      );
      for (const element of backgroundElements) {
        element.inert = true;
        element.setAttribute("aria-hidden", "true");
      }
      return;
    }
    for (const element of backgroundElements) {
      element.inert = false;
      element.removeAttribute("aria-hidden");
    }
    backgroundElements = [];
  };
  const restoreFocus = (element) => {
    if (element && documentImpl.contains(element)) element.focus();
    else previousFocus?.focus?.();
  };
  const closeModal = (requestId, { restore = true } = {}) => {
    const request = requests.get(requestId);
    if (!request?.entry) return;
    const { modal, restoreElement } = request.entry;
    modal.remove();
    request.entry = null;
    if (activeRequestId === requestId) {
      activeRequestId = null;
      setBackgroundContained(false);
      if (restore) restoreFocus(restoreElement);
    }
  };
  const renderNextModal = () => {
    if (stopped || activeRequestId) return;
    const request = Array.from(requests.values())[0];
    if (!request) return;
    const titleId = `remote-access-title-${request.requestId}`;
    const descriptionId = `remote-access-description-${request.requestId}`;
    const restoreElement = documentImpl.activeElement;
    const modal = documentImpl.createElement("div");
    modal.className = "ui-overlay remote-access-approval-overlay";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", titleId);
    modal.setAttribute("aria-describedby", descriptionId);
    const dialog = documentImpl.createElement("section");
    dialog.className = "ui-dialog remote-access-approval-dialog";
    const title = documentImpl.createElement("h2");
    title.id = titleId;
    title.textContent = t("remoteApproval.title");
    const device = documentImpl.createElement("p");
    device.className = "remote-access-approval-device";
    device.textContent = safeLabel(request.deviceName);
    const description = documentImpl.createElement("p");
    description.id = descriptionId;
    description.textContent = t("remoteApproval.warning");
    const error = documentImpl.createElement("p");
    error.className = "remote-access-approval-error";
    error.setAttribute("role", "alert");
    const actions = documentImpl.createElement("div");
    actions.className = "remote-access-approval-actions";
    const deny = documentImpl.createElement("button");
    deny.type = "button";
    deny.className = "ui-button ui-button--secondary";
    deny.textContent = t("remoteApproval.deny");
    const approve = documentImpl.createElement("button");
    approve.type = "button";
    approve.className = "ui-button ui-button--primary";
    approve.textContent = t("remoteApproval.approve");
    actions.append(deny, approve);
    dialog.append(title, device, description, error, actions);
    modal.appendChild(dialog);
    root.appendChild(modal);
    request.entry = { modal, title, device, description, error, deny, approve, restoreElement };
    activeRequestId = request.requestId;
    setBackgroundContained(true);

    const decide = async (decision) => {
      if (request.entry?.submitting) return;
      request.entry.submitting = true;
      deny.disabled = true;
      approve.disabled = true;
      try {
        const response = await fetchImpl(
          `/v2/auth/device-requests/${encodeURIComponent(request.requestId)}/${decision}`,
          { method: "POST", cache: "no-store" },
        );
        if (response.ok || response.status === 404 || response.status === 410) {
          closeModal(request.requestId);
          requests.delete(request.requestId);
          renderNextModal();
          void poll();
          return;
        }
        throw new Error("decision rejected");
      } catch {
        if (!request.entry) return;
        request.entry.submitting = false;
        deny.disabled = false;
        approve.disabled = false;
        error.textContent = t("remoteApproval.error");
      }
    };
    const trapFocus = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeModal(request.requestId);
        requests.delete(request.requestId);
        renderNextModal();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [approve, deny].filter((control) => !control.disabled);
      if (!focusable.length) return;
      const current = focusable.indexOf(documentImpl.activeElement);
      const next =
        focusable[(current + (event.shiftKey ? -1 : 1) + focusable.length) % focusable.length];
      event.preventDefault();
      next.focus();
    };
    deny.addEventListener("click", () => void decide("deny"));
    approve.addEventListener("click", () => void decide("approve"));
    modal.addEventListener("keydown", trapFocus);
    approve.focus();
  };
  const reconcileRequests = (list) => {
    const nextIds = new Set();
    for (const request of list) {
      if (!request?.requestId) continue;
      nextIds.add(request.requestId);
      const existing = requests.get(request.requestId);
      if (existing) {
        existing.deviceName = request.deviceName;
      } else {
        requests.set(request.requestId, { ...request, entry: null });
      }
    }
    for (const requestId of Array.from(requests.keys())) {
      if (!nextIds.has(requestId)) {
        if (activeRequestId === requestId) closeModal(requestId);
        requests.delete(requestId);
        if (activeRequestId === null) renderNextModal();
      }
    }
    renderNextModal();
  };
  const poll = async () => {
    clearPollTimer();
    if (
      stopped ||
      polling ||
      documentImpl.visibilityState === "hidden" ||
      windowImpl.navigator?.onLine === false
    ) {
      return;
    }
    polling = true;
    controller?.abort();
    controller = typeof AbortController === "function" ? new AbortController() : null;
    try {
      const response = await fetchImpl("/v2/auth/device-requests", {
        cache: "no-store",
        signal: controller?.signal,
      });
      if (response.ok) {
        const body = await response.json();
        reconcileRequests(Array.isArray(body.requests) ? body.requests : []);
      }
    } catch {
      // Desktop approval polling is best-effort; the next tick retries.
    } finally {
      polling = false;
      if (!stopped) schedulePoll();
    }
  };
  const resume = () => {
    clearPollTimer();
    void poll();
  };
  const unsubscribeLocaleChange = onLocaleChange(() => {
    const entry = activeRequestId && requests.get(activeRequestId)?.entry;
    if (!entry) return;
    entry.title.textContent = t("remoteApproval.title");
    entry.description.textContent = t("remoteApproval.warning");
    entry.deny.textContent = t("remoteApproval.deny");
    entry.approve.textContent = t("remoteApproval.approve");
  });
  documentImpl.addEventListener("visibilitychange", resume);
  windowImpl.addEventListener("online", resume);
  windowImpl.addEventListener("pagehide", cleanup);
  void poll();

  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearPollTimer();
    controller?.abort();
    documentImpl.removeEventListener("visibilitychange", resume);
    windowImpl.removeEventListener("online", resume);
    windowImpl.removeEventListener("pagehide", cleanup);
    unsubscribeLocaleChange?.();
    if (activeRequestId) closeModal(activeRequestId, { restore: false });
    setBackgroundContained(false);
    previousFocus?.focus?.();
    requests.clear();
  }
  return cleanup;
}
