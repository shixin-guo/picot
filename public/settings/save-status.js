const messageTimers = new WeakMap();

export function clearSettingsSaveMessage(messageEl) {
  if (!messageEl) return;
  const timer = messageTimers.get(messageEl);
  if (timer) {
    clearTimeout(timer);
    messageTimers.delete(messageEl);
  }
  messageEl.textContent = "";
  messageEl.classList.add("hidden");
  delete messageEl.dataset.tone;
}

export function showSettingsSaveError(messageEl, message) {
  if (!messageEl) return;
  clearSettingsSaveMessage(messageEl);
  messageEl.textContent = message;
  messageEl.dataset.tone = "error";
  messageEl.classList.remove("hidden");
}

export function showSettingsSaveSuccess(messageEl, message = "Saved") {
  if (!messageEl) return;
  clearSettingsSaveMessage(messageEl);
  messageEl.textContent = message;
  messageEl.dataset.tone = "ok";
  messageEl.classList.remove("hidden");
  const timer = setTimeout(() => clearSettingsSaveMessage(messageEl), 2000);
  messageTimers.set(messageEl, timer);
}

export function setSettingsSaveButtonSaving(button, isSaving) {
  if (!button) return;
  button.disabled = isSaving;
  button.textContent = isSaving ? "Saving…" : "Save";
}
