// ABOUTME: Non-modal floating Quick Chat dialog: single runtime/view, minimize
// ABOUTME: chip, title-bar drag, New Chat replacement, and close confirmation.

import { EphemeralChatRuntime } from "./ephemeral-chat-runtime.js";
import { onLocaleChange, t } from "./i18n.js";

const INTERACTIVE_SELECTOR = "button, textarea, input, select, a, [contenteditable]";
const MIN_DIALOG_WIDTH = 360;
const MIN_DIALOG_HEIGHT = 280;
const RECOVERY_AREA = 48;
const RESIZE_DIRECTIONS = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];

const SVG_NS = "http://www.w3.org/2000/svg";

function appendTitleIcon(button, paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  button.replaceChildren(svg);
}

export class QuickChatDialog {
  constructor({ transport, dialogRoot, chipRoot, boundsElement, confirmDiscard, createView }) {
    this.transport = transport;
    this.dialogRoot = dialogRoot;
    this.chipRoot = chipRoot;
    this.boundsElement = boundsElement || dialogRoot;
    this.confirmDiscard = confirmDiscard || (async () => "discard");
    this.createView = createView || (() => null);

    this.descriptor = null;
    this.runtime = null;
    this.view = null;
    this.destroyed = false;
    this._positioned = false;
    this._creating = false;
    this._replacing = false;
    this._gesture = null;
    this._locked = false;
    this._geometry = {
      minWidth: MIN_DIALOG_WIDTH,
      minHeight: MIN_DIALOG_HEIGHT,
      recoveryArea: RECOVERY_AREA,
    };

    const doc = globalThis.document;
    this._buildDom(doc);
    this._unsubscribeLocale = onLocaleChange(() => this._updateLocalizedChrome());
    this._updateLocalizedChrome();
  }

  async open() {
    if (this.destroyed || this._creating) return;
    if (this.descriptor) {
      this._show();
      return;
    }
    this._creating = true;
    this._locked = true;
    this._showLoading();
    this._show();
    try {
      this.descriptor = await this.transport.createEphemeral("quick-chat");
      if (!this.descriptor) return;
      this._mount();
      this._show();
    } catch (error) {
      this._dialog.classList.add("hidden");
      this._chip.classList.add("hidden");
      throw error;
    } finally {
      this._locked = false;
      this._creating = false;
    }
  }

  minimize() {
    if (this.destroyed || this._locked || !this.descriptor) return;
    this.runtime.active = false;
    this.view?.deactivate?.();
    this._dialog.classList.add("hidden");
    this._chip.classList.remove("hidden");
    this._returnFocusToSidebar();
  }

  restore() {
    if (this.destroyed || this._locked || !this.descriptor) return;
    this._show();
  }

  async replace() {
    if (this.destroyed || this._locked || this._replacing) return;
    this._replacing = true;
    this._locked = true;
    this.view?.setInteractionLocked?.(true);
    if (this.descriptor) {
      const risk = this.runtime?.getCloseRisk();
      if (risk && (risk.hasMessages || risk.streaming)) {
        const decision = await this.confirmDiscard([risk], "quick-chat");
        if (decision !== "discard") return null;
      }
    }
    this._locked = true;
    try {
      const next = await this.transport.replaceQuickChat();
      if (!next) return null;
      this._disposeRuntime();
      this.descriptor = next;
      this._mount();
      this._show();
      return next;
    } finally {
      this._locked = false;
      this._replacing = false;
      this.view?.setInteractionLocked?.(false);
    }
  }

  async close() {
    if (this.destroyed || this._locked || !this.descriptor) return false;
    const risk = this.runtime?.getCloseRisk();
    if (risk && (risk.hasMessages || risk.streaming)) {
      const decision = await this.confirmDiscard([risk], "quick-chat");
      if (decision !== "discard") return false;
    }
    try {
      await this.transport.closeEphemeral(this.descriptor.instanceId, this.descriptor.generation);
    } catch {
      return false;
    }
    this._disposeRuntime();
    this.descriptor = null;
    this._dialog.classList.add("hidden");
    this._chip.classList.add("hidden");
    this._returnFocusToSidebar();
    return true;
  }

  rebind(descriptor, uiState) {
    if (this.destroyed || !descriptor) return;
    this._disposeRuntime();
    this.descriptor = descriptor;
    const geometry = uiState?.geometry || uiState;
    if (geometry && typeof geometry === "object") {
      this._applyGeometry(geometry);
      this._positioned = true;
    }
    this._mount();
    this._show();
  }

  setInteractionLocked(locked) {
    this._locked = Boolean(locked);
    this.view?.setInteractionLocked?.(locked);
  }

  getCloseRisk() {
    if (!this.runtime) return null;
    return this.runtime.getCloseRisk();
  }

  /** Window-close path: drop the runtime/view without a host round-trip. */
  cleanupAfterHostClose() {
    // Spec §Lifecycle: abort a streaming response before host cleanup so the
    // child stops generating while the window is being torn down.
    if (this.runtime?.isStreaming) this.runtime.abort();
    this._disposeRuntime();
    this.descriptor = null;
    this._dialog?.classList.add("hidden");
    this._chip?.classList.add("hidden");
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this._endDrag();
    this._disposeRuntime();
    if (this._handlePointerMove) window.removeEventListener("pointermove", this._handlePointerMove);
    if (this._handlePointerUp) {
      window.removeEventListener("pointerup", this._handlePointerUp);
      window.removeEventListener("pointercancel", this._handlePointerUp);
      this._title?.removeEventListener("lostpointercapture", this._handlePointerUp);
    }
    this._unsubscribeLocale?.();
    if (this._onDialogKeyDown) {
      this._dialog?.removeEventListener("keydown", this._onDialogKeyDown);
    }
    if (this._onWindowBlur) window.removeEventListener("blur", this._onWindowBlur);
    for (const handle of this._resizeHandles || []) {
      const handlers = this._resizePointerHandlers?.get(handle);
      if (handlers) {
        handle.removeEventListener("pointerdown", handlers.pointerDown);
        handle.removeEventListener("keydown", handlers.keyDown);
        handle.removeEventListener("lostpointercapture", handlers.lostCapture);
      }
    }
    this._dialog?.classList.add("hidden");
    this._chip?.classList.add("hidden");
    this.descriptor = null;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _buildDom(doc) {
    this._dialog = this.dialogRoot;
    this._dialog.classList.add("quick-chat-dialog", "hidden");

    const title = doc.createElement("div");
    title.className = "quick-chat-title";
    title.dataset.role = "quick-chat-title";

    this._titleText = doc.createElement("span");
    this._titleText.className = "quick-chat-title-text";
    this._titleText.textContent = t("ephemeral.quickChat");
    title.appendChild(this._titleText);

    this._titleButtons = new Map();
    this._titleActions = doc.createElement("div");
    this._titleActions.className = "quick-chat-title-actions";
    this._titleActions.append(
      this._titleButton("quick-chat-new", "ephemeral.newChat", ["M12 5v14", "M5 12h14"], () =>
        this.replace(),
      ),
      this._titleButton("quick-chat-minimize", "ephemeral.minimize", ["M5 12h14"], () =>
        this.minimize(),
      ),
      this._titleButton("quick-chat-close", "ephemeral.close", ["M18 6 6 18", "M6 6 18 18"], () =>
        this.close(),
      ),
    );
    title.appendChild(this._titleActions);
    this._dialog.appendChild(title);

    this._body = doc.createElement("div");
    this._body.className = "quick-chat-body";
    this._dialog.appendChild(this._body);

    this._resizePointerHandlers = new Map();
    this._resizeHandles = RESIZE_DIRECTIONS.map((direction) => {
      const handle = doc.createElement("div");
      handle.className = `quick-chat-resize-handle quick-chat-resize-${direction}`;
      handle.dataset.resize = direction;
      handle.setAttribute("role", "separator");
      handle.setAttribute("tabindex", "0");
      handle.setAttribute("aria-label", t("ephemeral.resize"));
      const pointerDown = (event) => this._onPointerDown(event);
      const keyDown = (event) => this._onResizeKeyDown(event);
      const lostCapture = () => this._endDrag();
      this._resizePointerHandlers.set(handle, { pointerDown, keyDown, lostCapture });
      handle.addEventListener("pointerdown", pointerDown);
      handle.addEventListener("keydown", keyDown);
      handle.addEventListener("lostpointercapture", lostCapture);
      this._dialog.appendChild(handle);
      return handle;
    });

    this._title = title;
    this._title.addEventListener("pointerdown", (event) => this._onPointerDown(event));
    this._handlePointerMove = (event) => this._onPointerMove(event);
    this._handlePointerUp = () => this._endDrag();
    window.addEventListener("pointermove", this._handlePointerMove);
    window.addEventListener("pointerup", this._handlePointerUp);
    window.addEventListener("pointercancel", this._handlePointerUp);
    this._title.addEventListener("lostpointercapture", this._handlePointerUp);
    this._onWindowBlur = () => this._endDrag();
    window.addEventListener("blur", this._onWindowBlur);
    // Spec §Focus and shortcuts: with Quick Chat focused, Escape aborts the
    // active response; it never closes or minimizes the dialog. Catching at
    // dialog scope (not just inside the textarea) keeps it effective when the
    // focus is on the model dropdown or title buttons.
    this._onDialogKeyDown = (event) => {
      if (event.key !== "Escape" || !this.runtime?.isStreaming) return;
      event.preventDefault();
      event.stopPropagation();
      this.runtime.abort();
    };
    this._dialog.setAttribute("tabindex", "-1");
    this._dialog.addEventListener("keydown", this._onDialogKeyDown);

    this._chip = this.chipRoot;
    this._chip.classList.add("quick-chat-chip", "hidden");
    this._chip.textContent = t("ephemeral.quickChat");
    this._chip.addEventListener("click", () => this.restore());
  }

  _titleButton(role, labelKey, paths, onClick) {
    const btn = globalThis.document.createElement("button");
    btn.type = "button";
    btn.className = "quick-chat-title-btn";
    btn.dataset.role = role;
    btn.dataset.i18nKey = labelKey;
    appendTitleIcon(btn, paths);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    this._titleButtons.set(role, btn);
    return btn;
  }

  _updateLocalizedChrome() {
    if (this.destroyed) return;
    this._titleText.textContent = t("ephemeral.quickChat");
    this._chip.textContent = t("ephemeral.quickChat");
    this._chip.setAttribute("aria-label", t("ephemeral.quickChat"));
    for (const button of this._titleButtons.values()) {
      const label = t(button.dataset.i18nKey);
      button.title = label;
      button.setAttribute("aria-label", label);
    }
    for (const handle of this._resizeHandles || []) {
      handle.setAttribute("aria-label", t("ephemeral.resize"));
    }
    this._renderChipState();
  }

  _returnFocusToSidebar() {
    const sidebarBtn = globalThis.document?.getElementById?.("quick-chat-btn");
    if (sidebarBtn && !sidebarBtn.classList.contains("hidden")) {
      sidebarBtn.focus();
      return;
    }
    // Spec §Focus: when the sidebar button is hidden/collapsed, focus the
    // main chat input as the closest meaningful control.
    const mainInput = globalThis.document?.getElementById?.("message-input");
    mainInput?.focus?.();
  }

  _mount() {
    this.runtime = new EphemeralChatRuntime({
      descriptor: this.descriptor,
      transport: this.transport,
    });
    this.runtime.active = true;
    this._onRuntimeRenderState = () => this._renderChipState();
    this._onRuntimeUnread = () => this._renderChipState();
    this.runtime.addEventListener("renderstate", this._onRuntimeRenderState);
    this.runtime.addEventListener("unreadchange", this._onRuntimeUnread);
    this.view = this.createView(this.runtime);
    if (this.view?.element) {
      this._body.replaceChildren(this.view.element);
    }
    this._dialog.setAttribute("aria-busy", "false");
    this._renderChipState();
    this.runtime.requestSnapshot();
  }

  _showLoading() {
    const loading = this._dialog.ownerDocument.createElement("div");
    loading.className = "quick-chat-loading";
    loading.setAttribute("role", "status");
    loading.textContent = t("ephemeral.startingQuickChat");
    this._body.replaceChildren(loading);
    this._dialog.setAttribute("aria-busy", "true");
  }

  _show() {
    this._dialog.classList.remove("hidden");
    this._chip.classList.add("hidden");
    this.view?.activate?.();
    this.runtime?.acknowledgeVisible();
    if (!this._positioned) {
      this._center();
      this._positioned = true;
    }
    this.view?.focusLastMeaningfulControl?.();
  }

  _center() {
    const bounds = this.boundsElement?.getBoundingClientRect?.();
    const width = Math.min(520, Math.max(MIN_DIALOG_WIDTH, (bounds?.width || 0) - 48));
    const height = Math.min(640, Math.max(MIN_DIALOG_HEIGHT, (bounds?.height || 0) - 48));
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
      this._applyGeometry({ left: 100, top: 80, width: 520, height: 640 });
      return;
    }
    this._applyGeometry({
      left: (bounds.width - width) / 2,
      top: (bounds.height - height) / 2,
      width,
      height,
    });
  }

  _onPointerDown(event) {
    if (this.destroyed || event.button !== 0) return;
    const handle = event.target?.closest?.("[data-resize]");
    if (!handle && event.target?.closest?.(INTERACTIVE_SELECTOR)) return;
    event.preventDefault();
    const rect = this._dialog.getBoundingClientRect();
    const bounds = this.boundsElement?.getBoundingClientRect?.();
    const width = rect.width || Number.parseFloat(this._dialog.style.width) || 520;
    const height = rect.height || Number.parseFloat(this._dialog.style.height) || 640;
    const left = Number.parseFloat(this._dialog.style.left) || rect.left - (bounds?.left || 0) || 0;
    const top = Number.parseFloat(this._dialog.style.top) || rect.top - (bounds?.top || 0) || 0;
    this._gesture = {
      type: handle ? "resize" : "drag",
      direction: handle?.dataset.resize || "",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left,
      top,
      width,
      height,
      target: handle || this._title,
    };
    this._dialog.classList.toggle("is-resizing", Boolean(handle));
    this._dialog.classList.toggle("is-dragging", !handle);
    try {
      this._gesture.target.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is not available in every browser test environment.
    }
  }

  _onPointerMove(event) {
    const gesture = this._gesture;
    if (!gesture) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (gesture.type === "drag") {
      this._applyGeometry({ left: gesture.left + dx, top: gesture.top + dy });
      return;
    }

    let { left, top, width, height } = gesture;
    if (gesture.direction.includes("e")) width += dx;
    if (gesture.direction.includes("s")) height += dy;
    if (gesture.direction.includes("w")) {
      width -= dx;
      left += dx;
    }
    if (gesture.direction.includes("n")) {
      height -= dy;
      top += dy;
    }
    if (width < MIN_DIALOG_WIDTH) {
      if (gesture.direction.includes("w")) left -= MIN_DIALOG_WIDTH - width;
      width = MIN_DIALOG_WIDTH;
    }
    if (height < MIN_DIALOG_HEIGHT) {
      if (gesture.direction.includes("n")) top -= MIN_DIALOG_HEIGHT - height;
      height = MIN_DIALOG_HEIGHT;
    }
    this._applyGeometry({ left, top, width, height });
  }

  _applyGeometry({ left, top, width, height }) {
    const bounds = this.boundsElement?.getBoundingClientRect?.();
    let nextWidth = width ?? (Number.parseFloat(this._dialog.style.width) || 520);
    let nextHeight = height ?? (Number.parseFloat(this._dialog.style.height) || 640);
    let nextLeft = left ?? (Number.parseFloat(this._dialog.style.left) || 0);
    let nextTop = top ?? (Number.parseFloat(this._dialog.style.top) || 0);
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      nextWidth = Math.min(nextWidth, Math.max(MIN_DIALOG_WIDTH, bounds.width));
      nextHeight = Math.min(nextHeight, Math.max(MIN_DIALOG_HEIGHT, bounds.height));
      nextLeft = Math.max(0, Math.min(nextLeft, bounds.width - RECOVERY_AREA));
      nextTop = Math.max(0, Math.min(nextTop, bounds.height - RECOVERY_AREA));
    }
    this._dialog.style.left = `${nextLeft}px`;
    this._dialog.style.top = `${nextTop}px`;
    if (width !== undefined) this._dialog.style.width = `${nextWidth}px`;
    if (height !== undefined) this._dialog.style.height = `${nextHeight}px`;
  }

  _endDrag() {
    const gesture = this._gesture;
    if (gesture) {
      try {
        gesture.target.releasePointerCapture?.(gesture.pointerId);
      } catch {
        // The pointer may already have been released or cancelled.
      }
    }
    this._gesture = null;
    this._dialog?.classList.remove("is-resizing", "is-dragging");
  }

  _onResizeKeyDown(event) {
    if (!this._dialog || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const amount = event.shiftKey ? 10 : 1;
    const direction = event.currentTarget?.dataset.resize || "se";
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -amount;
    if (event.key === "ArrowRight") dx = amount;
    if (event.key === "ArrowUp") dy = -amount;
    if (event.key === "ArrowDown") dy = amount;
    const rect = this._dialog.getBoundingClientRect();
    const left = Number.parseFloat(this._dialog.style.left) || rect.left || 0;
    const top = Number.parseFloat(this._dialog.style.top) || rect.top || 0;
    const width = rect.width || Number.parseFloat(this._dialog.style.width) || 520;
    const height = rect.height || Number.parseFloat(this._dialog.style.height) || 640;
    this._applyGeometry({
      left: direction.includes("w") ? left + dx : left,
      top: direction.includes("n") ? top + dy : top,
      width:
        direction.includes("e") || direction.includes("w")
          ? width + (direction.includes("w") ? -dx : dx)
          : width,
      height:
        direction.includes("n") || direction.includes("s")
          ? height + (direction.includes("n") ? -dy : dy)
          : height,
    });
  }

  _renderChipState() {
    if (!this._chip || !this.runtime) return;
    const labels = [t("ephemeral.quickChat")];
    if (this.runtime.isStreaming) labels.push(t("ephemeral.generating"));
    if (this.runtime.unread) labels.push(t("ephemeral.unread"));
    this._chip.textContent = labels.join(" · ");
    this._chip.setAttribute("aria-label", labels.join(" · "));
  }

  _disposeRuntime() {
    if (this.runtime && this._onRuntimeRenderState) {
      this.runtime.removeEventListener("renderstate", this._onRuntimeRenderState);
    }
    if (this.runtime && this._onRuntimeUnread) {
      this.runtime.removeEventListener("unreadchange", this._onRuntimeUnread);
    }
    this.runtime?.destroy();
    this.view?.destroy?.();
    this._body?.replaceChildren();
    this.runtime = null;
    this.view = null;
    this._onRuntimeRenderState = null;
    this._onRuntimeUnread = null;
  }
}
