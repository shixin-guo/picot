// ABOUTME: Renders isolated extension dialogs and notifications for one chat view.
// ABOUTME: Routes responses through the injected owner-scoped transport callback.

import { onLocaleChange, t } from "../i18n.js";

export class DialogHandler {
  constructor({ container, notificationContainer = null, send = null }) {
    this.container = container;
    this.notificationContainer = notificationContainer;
    this.send = send;
    this.timeoutId = null;
    this._destroyed = false;
    this.unsubscribeLocaleChange = onLocaleChange(() => {
      if (!this.currentDialog) return;
      const updateBtn = (selector, key) => {
        const btn = this.currentDialog?.querySelector(selector);
        if (btn) btn.textContent = t(key);
      };
      updateBtn(".dialog-cancel", "dialogs.cancel");
      updateBtn(".dialog-no", "dialogs.no");
      updateBtn(".dialog-yes", "dialogs.yes");
      updateBtn(".dialog-submit", "dialogs.submit");
      updateBtn(".dialog-save", "dialogs.save");
    });
  }

  showSelect(request) {
    this.clearCurrentDialog();
    const { id, title, options, timeout } = request;
    const dialog = this._createDialog(title || t("dialogs.selectOption"));
    const optionsContainer = document.createElement("div");
    optionsContainer.className = "dialog-options";
    dialog.appendChild(optionsContainer);
    (options || []).forEach((option) => {
      const optionDiv = document.createElement("button");
      optionDiv.type = "button";
      optionDiv.className = "dialog-option";
      optionDiv.textContent = option;
      optionDiv.addEventListener("click", () => this.respond(id, { value: option }));
      optionsContainer.appendChild(optionDiv);
    });
    const actions = this._createActions(["cancel"]);
    actions.querySelector(".dialog-cancel").addEventListener("click", () => {
      this.respond(id, { cancelled: true });
    });
    dialog.appendChild(actions);
    this.showDialog(dialog, timeout, id);
  }

  showConfirm(request) {
    this.clearCurrentDialog();
    const { id, title, message, timeout } = request;
    const dialog = this._createDialog(title || t("dialogs.confirm"), message);
    const actions = this._createActions(["no", "yes"]);
    actions.querySelector(".dialog-yes").addEventListener("click", () => {
      this.respond(id, { confirmed: true });
    });
    actions.querySelector(".dialog-no").addEventListener("click", () => {
      this.respond(id, { confirmed: false });
    });
    dialog.appendChild(actions);
    this.showDialog(dialog, timeout, id);
  }

  showInput(request) {
    this.clearCurrentDialog();
    const { id, title, placeholder, timeout } = request;
    const dialog = this._createDialog(title || t("dialogs.input"));
    const input = document.createElement("input");
    input.type = "text";
    input.className = "dialog-input";
    input.placeholder = placeholder || "";
    dialog.appendChild(input);
    const submit = () => {
      const value = input.value.trim();
      this.respond(id, value ? { value } : { cancelled: true });
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
    });
    const actions = this._createActions(["cancel", "submit"]);
    actions.querySelector(".dialog-submit").addEventListener("click", submit);
    actions.querySelector(".dialog-cancel").addEventListener("click", () => {
      this.respond(id, { cancelled: true });
    });
    dialog.appendChild(actions);
    this.showDialog(dialog, timeout, id);
    setTimeout(() => input.focus(), 100);
  }

  showEditor(request) {
    this.clearCurrentDialog();
    const { id, title, prefill, timeout } = request;
    const dialog = this._createDialog(title || t("dialogs.editor"));
    const textarea = document.createElement("textarea");
    textarea.className = "dialog-textarea";
    textarea.value = prefill || "";
    dialog.appendChild(textarea);
    const actions = this._createActions(["cancel", "save"]);
    actions.querySelector(".dialog-save").addEventListener("click", () => {
      const value = textarea.value;
      this.respond(id, value ? { value } : { cancelled: true });
    });
    actions.querySelector(".dialog-cancel").addEventListener("click", () => {
      this.respond(id, { cancelled: true });
    });
    dialog.appendChild(actions);
    this.showDialog(dialog, timeout, id);
    setTimeout(() => textarea.focus(), 100);
  }

  showNotification(request) {
    const { message, notifyType } = request;
    const notification = document.createElement("div");
    notification.className = "error-message";
    const icon = notifyType === "error" || notifyType === "warning" ? "⚠️" : "ℹ️";
    notification.textContent = `${icon} ${message}`;

    const target = this.notificationContainer || document.getElementById("messages");
    if (target) {
      target.appendChild(notification);
      if (typeof target.scrollTop === "number") target.scrollTop = target.scrollHeight;
      setTimeout(() => notification.remove(), 5000);
    }
  }

  showDialog(dialogElement, timeout, requestId) {
    this.currentDialog = dialogElement;
    this.container?.replaceChildren(dialogElement);
    this.container?.classList.remove("hidden");
    if (timeout) {
      this.timeoutId = setTimeout(() => {
        this.respond(requestId, { cancelled: true });
      }, timeout);
    }
  }

  clearCurrentDialog() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.container?.replaceChildren();
    this.container?.classList.add("hidden");
    this.currentDialog = null;
  }

  respond(id, response) {
    this.clearCurrentDialog();
    if (typeof this.send === "function") {
      this.send({ type: "extension_ui_response", id, ...response });
    }
  }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.unsubscribeLocaleChange?.();
    this.unsubscribeLocaleChange = null;
    this.clearCurrentDialog();
    this.send = null;
    this.container = null;
    this.notificationContainer = null;
  }

  _createDialog(title, message = "") {
    const dialog = document.createElement("div");
    dialog.className = "dialog";
    const titleElement = document.createElement("div");
    titleElement.className = "dialog-title";
    titleElement.textContent = title;
    dialog.appendChild(titleElement);
    if (message) {
      const messageElement = document.createElement("div");
      messageElement.className = "dialog-message";
      messageElement.textContent = message;
      dialog.appendChild(messageElement);
    }
    return dialog;
  }

  _createActions(names) {
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    for (const name of names) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `dialog-${name}`;
      button.textContent = t(`dialogs.${name}`);
      actions.appendChild(button);
    }
    return actions;
  }
}
