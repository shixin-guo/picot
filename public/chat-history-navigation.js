// ABOUTME: Chat history navigator — indexes user turns and renders a magnifying tick rail with preview.
// ABOUTME: Owns turn pairing, streaming summaries, scroll anchoring, click navigation, and lifecycle cleanup.
import { onLocaleChange, t } from "./i18n.js";

const PROMPT_CODE_POINT_LIMIT = 2000;
const RESPONSE_CODE_POINT_LIMIT = 4000;
const MIN_VISIBLE_TURNS = 2;
const MAGNIFY_NEIGHBORS = 6;
const PREVIEW_CLOSE_DELAY_MS = 120;
const ANCHOR_RATIO = 0.3;
const HYSTERESIS_PX = 12;
const NAV_HIGHLIGHT_MS = 600;

const RESPONSE_WAITING = "waiting";
const RESPONSE_STREAMING = "streaming";
const RESPONSE_COMPLETE = "complete";

const ROOT_HIDDEN_CLASS = "hidden";

function isTouchLayout() {
  const win = typeof window !== "undefined" ? window : null;
  if (!win || typeof win.matchMedia !== "function") return false;
  return (
    win.matchMedia?.("(hover: none)")?.matches || win.matchMedia?.("(pointer: coarse)")?.matches
  );
}

function prefersReducedMotion() {
  const win = typeof window !== "undefined" ? window : null;
  if (!win || typeof win.matchMedia !== "function") return false;
  return win.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
}

/** Slice a string by Unicode code points (not UTF-16 code units). */
function limitCodePoints(value, limit) {
  if (typeof value !== "string") return "";
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  return codePoints.slice(0, limit).join("");
}

/**
 * Extract visible text from a plain (non-element) content source.
 * App calls pass already-extracted visible text as a string, so this is a
 * passthrough that tolerates non-string input by returning "".
 */
function toVisibleText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((block) => (typeof block === "string" ? block : (block?.text ?? ""))).join("");
  }
  return "";
}

/**
 * Low-level layout helper: distribute `count` ticks across a fixed-height rail.
 * Exported only for deterministic unit testing.
 */
export function computeTickPositions(count, railHeight, padding = 4) {
  if (count <= 0 || railHeight <= 0) return [];
  const usable = Math.max(0, railHeight - padding * 2);
  if (count === 1) return [padding + usable / 2];
  if (count === 2) return [padding + usable * 0.25, padding + usable * 0.75];
  const step = usable / (count - 1);
  const positions = [];
  for (let i = 0; i < count; i++) {
    positions.push(padding + step * i);
  }
  return positions;
}

/**
 * Determine the active turn index from cached offsets and the scroll anchor.
 * Exported only for deterministic unit testing.
 */
export function computeActiveTurn(offsets, scrollTop, clientHeight) {
  if (offsets.length === 0) return -1;
  const anchor = scrollTop + clientHeight * ANCHOR_RATIO;
  // Find the last offset at or above the anchor via linear scan (binary search
  // is used in the live path; this helper keeps the boundary logic testable).
  let idx = -1;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= anchor) idx = i;
    else break;
  }
  if (idx === -1) return 0;
  return idx;
}

/**
 * Binary search the active turn. Returns the index of the last offset at or
 * above the anchor. Clamps to [0, lastIndex]. Exported for unit testing.
 */
export function binarySearchActiveTurn(offsets, anchor) {
  if (offsets.length === 0) return -1;
  let lo = 0;
  let hi = offsets.length - 1;
  if (offsets[0] > anchor) return 0;
  if (offsets[hi] <= anchor) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (offsets[mid] <= anchor) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class ChatHistoryNavigator {
  constructor(chatPanel, options = {}) {
    this.chatPanel = chatPanel || null;
    this.messagesContainer = options.messagesContainer || null;
    this.transport = options.transport || null;

    // Injectable scheduling for deterministic tests.
    this._raf =
      options.requestAnimationFrame || options.requestFrame || ((cb) => requestAnimationFrame(cb));
    this._craf =
      options.cancelAnimationFrame || options.cancelFrame || ((id) => cancelAnimationFrame(id));
    this._st = options.setTimeout || ((cb, ms) => setTimeout(cb, ms));
    this._ct = options.clearTimeout || ((id) => clearTimeout(id));

    this._reducedMotion = options.reducedMotion ?? false;
    this._touchLayout = options.touchLayout ?? false;
    this._measureViewport = options.measureViewport || null;
    this._measureElementOffset = options.measureElementOffset || null;

    this.turns = [];
    this._activeIndex = -1;
    this._hoverIndex = -1;
    this._previewTurn = null;
    this._previewPointerY = null;
    this._lastMagnify = { center: -1, indices: [] };

    this._layoutFrame = 0;
    this._offsetsDirty = true;
    this._offsets = [];
    this._resizeObserver = null;
    this._scroller = null;
    this._boundScroll = this._onScroll.bind(this);
    this._boundPointer = this._onPointer.bind(this);
    this._boundEnter = this._onEnter.bind(this);
    this._boundLeave = this._onLeave.bind(this);
    this._boundPreviewEnter = this._onPreviewEnter.bind(this);
    this._boundPreviewLeave = this._onPreviewLeave.bind(this);
    this._boundClick = this._onClick.bind(this);
    this._boundImageLoad = this._onImageLoad.bind(this);

    this._closeTimer = 0;
    this._highlightTimer = 0;
    this._streamingTurn = null;
    this._streamingPending = false;

    this._buildDom();
    this._updateVisibility();
    this._installListeners();

    this._detachLocale = onLocaleChange(() => this._onLocaleChange());
  }

  // ── DOM construction ────────────────────────────────────────────────

  _buildDom() {
    this.root = document.createElement("div");
    this.root.className = "chat-nav";
    this.root.setAttribute("aria-hidden", "true");

    this.rail = document.createElement("div");
    this.rail.className = "chat-nav-rail";

    this.preview = document.createElement("div");
    this.preview.className = "chat-nav-preview";
    this.preview.style.display = "none";

    this.previewPrompt = document.createElement("div");
    this.previewPrompt.className = "chat-nav-preview-prompt";

    this.previewResponse = document.createElement("div");
    this.previewResponse.className = "chat-nav-preview-response";

    this.preview.appendChild(this.previewPrompt);
    this.preview.appendChild(this.previewResponse);
    this.root.appendChild(this.rail);
    this.root.appendChild(this.preview);

    this._ticks = [];

    if (this.chatPanel && typeof this.chatPanel.appendChild === "function") {
      this.chatPanel.appendChild(this.root);
    }
  }

  _installListeners() {
    this.rail.addEventListener("pointermove", this._boundPointer);
    this.rail.addEventListener("pointerdown", this._boundEnter);
    this.rail.addEventListener("pointerleave", this._boundLeave);
    this.rail.addEventListener("click", this._boundClick);
    this.preview.addEventListener("pointerenter", this._boundPreviewEnter);
    this.preview.addEventListener("pointerleave", this._boundPreviewLeave);
    this.messagesContainer?.addEventListener("scroll", this._boundScroll, { passive: true });

    if (this.messagesContainer && typeof ResizeObserver === "function") {
      this._resizeObserver = new ResizeObserver(() => this.invalidateLayout());
      this._resizeObserver.observe(this.messagesContainer);
      for (const turn of this.turns) {
        if (turn.userElement) this._resizeObserver.observe(turn.userElement);
      }
    }
  }

  _attachImageListeners(turn) {
    const el = turn.userElement;
    if (!el || el.__navImgBound) return;
    el.__navImgBound = true;
    el.addEventListener("load", this._boundImageLoad, true);
    el.addEventListener("error", this._boundImageLoad, true);
  }

  _onImageLoad(event) {
    // Any image load inside a tracked user message can shift layout and
    // invalidate cached offsets.
    this.invalidateLayout();
    event.stopPropagation?.();
  }

  // ── Public lifecycle API ────────────────────────────────────────────

  /**
   * Add a user turn. `userElement` may be an HTMLElement (live render path) or
   * null. `text`/`images` describe the visible prompt. Returns the turn id.
   */
  addUserTurn({ id, userElement, element, text, images, hasImage } = {}) {
    const userText = limitCodePoints(toVisibleText(text), PROMPT_CODE_POINT_LIMIT);
    const hasUserImage = Array.isArray(images) ? images.length > 0 : Boolean(images || hasImage);
    const turn = {
      id: id ?? `turn-${this.turns.length}`,
      userElement: userElement || element || null,
      userText: userText || (hasUserImage ? t("chatNavigation.imageMessage") : ""),
      hasUserImage,
      assistantText: "",
      responseState: RESPONSE_WAITING,
    };
    this.turns.push(turn);
    this._streamingTurn = turn;
    this._streamingPending = true;
    if (turn.userElement) {
      this._attachImageListeners(turn);
      this._resizeObserver?.observe(turn.userElement);
    }
    this.invalidateLayout();
    return turn.id;
  }

  /**
   * Mark the latest turn as streaming an assistant message. This begins
   * accumulating visible assistant text for that turn.
   */
  beginAssistantMessage(arg = {}) {
    const { id } = typeof arg === "string" ? {} : arg || {};
    const turn = this._resolveStreamingTurn(id);
    if (!turn) return;
    if (turn.assistantText) {
      turn.assistantText = limitCodePoints(`${turn.assistantText}\n\n`, RESPONSE_CODE_POINT_LIMIT);
    }
    turn._segmentStart = Array.from(turn.assistantText).length;
    turn.responseState = RESPONSE_STREAMING;
    this._streamingTurn = turn;
    this._streamingPending = false;
    this.invalidateLayout();
  }

  /**
   * Accumulate visible assistant text for the streaming turn. `text` is the raw
   * visible content of this assistant message delta. Multiple assistant
   * segments within one turn are concatenated, separated by a blank line.
   */
  updateAssistantMessage(arg = {}) {
    const payload = typeof arg === "string" ? { text: arg } : arg || {};
    const { id, text, segmentIndex } = payload;
    const turn = this._resolveStreamingTurn(id);
    if (!turn) return;
    turn.responseState = RESPONSE_STREAMING;
    const visible = toVisibleText(text);
    if (!visible) return;
    const segmentStart = Number.isInteger(turn._segmentStart) ? turn._segmentStart : 0;
    const prefix = Array.from(turn.assistantText).slice(0, segmentStart).join("");
    const value =
      segmentIndex != null && segmentIndex > 0 && segmentStart === 0
        ? `${turn.assistantText}\n\n${visible}`
        : `${prefix}${visible}`;
    turn.assistantText = limitCodePoints(value, RESPONSE_CODE_POINT_LIMIT);
    this._streamingTurn = turn;
    this._streamingPending = false;
    this._scheduleLayoutFrame();
    if (this._previewTurn === turn) this._schedulePreviewRefresh();
  }

  /**
   * Finalize the streaming turn. If the turn has no visible assistant text it
   * shows the no-visible-response label rather than the generating label.
   */
  completeAssistantMessage({ id } = {}) {
    const turn = this._resolveStreamingTurn(id);
    if (!turn) return;
    turn.responseState = RESPONSE_COMPLETE;
    turn.assistantText = limitCodePoints(turn.assistantText, RESPONSE_CODE_POINT_LIMIT);
    this._streamingTurn = null;
    this._streamingPending = false;
    this.invalidateLayout();
  }

  _resolveStreamingTurn(id) {
    if (id) {
      const byId = this.turns.find((tu) => tu.id === id);
      if (byId) return byId;
    }
    if (this._streamingTurn) return this._streamingTurn;
    // Fallback to the latest turn that is still waiting/streaming.
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const tu = this.turns[i];
      if (tu.responseState !== RESPONSE_COMPLETE) return tu;
    }
    return null;
  }

  // ── Layout invalidation & rendering ─────────────────────────────────

  /**
   * Mark cached offsets as stale and schedule a single coalesced layout frame.
   */
  invalidateLayout() {
    this._offsetsDirty = true;
    this._scheduleLayoutFrame();
  }

  _scheduleLayoutFrame() {
    if (this._layoutFrame) return;
    this._layoutFrame = this._raf(() => {
      this._layoutFrame = 0;
      this._runLayoutFrame();
    });
  }

  _runLayoutFrame() {
    this._updateVisibility();
    if (this.root.classList.contains(ROOT_HIDDEN_CLASS)) return;
    this._renderTicks();
    this._refreshOffsets();
    this._updateActiveTick();
    this._refreshPreview();
  }

  _updateVisibility() {
    const shouldHide =
      this.turns.length < MIN_VISIBLE_TURNS || this._touchLayout || isTouchLayout();
    this.root.classList.toggle(ROOT_HIDDEN_CLASS, shouldHide);
    if (shouldHide && this._previewTurn) this._hidePreview(true);
  }

  _renderTicks() {
    const count = this.turns.length;
    const tickEls = this._ticks;
    // Reuse/trim elements; never rebuild all on each frame.
    while (tickEls.length > count) {
      const el = tickEls.pop();
      el.remove();
    }
    while (tickEls.length < count) {
      const el = document.createElement("div");
      el.className = "chat-nav-tick";
      tickEls.push(el);
      this.rail.appendChild(el);
    }
  }

  _refreshOffsets() {
    if (!this._offsetsDirty) return;
    this._offsetsDirty = false;
    const offsets = [];
    for (const turn of this.turns) {
      const el = turn.userElement;
      if (!el) {
        offsets.push(0);
        continue;
      }
      if (this._measureElementOffset) {
        offsets.push(this._measureElementOffset(el, this.messagesContainer));
      } else if (el.offsetTop !== undefined && this.messagesContainer) {
        offsets.push(el.offsetTop - this.messagesContainer.offsetTop);
      } else {
        const rect = el.getBoundingClientRect();
        offsets.push(rect.top);
      }
    }
    this._offsets = offsets;
  }

  _updateActiveTick() {
    const container = this.messagesContainer;
    const scrollTop = container ? container.scrollTop : 0;
    const clientHeight = container ? container.clientHeight : 0;
    const anchor = scrollTop + clientHeight * ANCHOR_RATIO;
    let idx = binarySearchActiveTurn(this._offsets, anchor);
    if (idx < 0) idx = 0;

    // Hysteresis: only switch active turn when crossing the boundary by more
    // than HYSTERESIS_PX beyond the midpoint between adjacent turns.
    if (
      this._activeIndex >= 0 &&
      this._activeIndex !== idx &&
      this._offsets.length > Math.max(this._activeIndex, idx)
    ) {
      idx = this._applyHysteresis(idx, scrollTop, clientHeight);
    }
    if (idx === this._activeIndex) return;
    this._activeIndex = idx;
    for (let i = 0; i < this._ticks.length; i++) {
      this._ticks[i].classList.toggle("active", i === idx);
    }
  }

  _applyHysteresis(candidate, scrollTop, clientHeight) {
    const current = this._activeIndex;
    const offsets = this._offsets;
    if (candidate === current || offsets.length === 0) return candidate;
    const lo = Math.min(current, candidate);
    const hi = Math.max(current, candidate);
    const boundary = (offsets[lo] + offsets[hi]) / 2;
    const anchor = scrollTop + clientHeight * ANCHOR_RATIO;
    if (candidate > current) {
      // Moving down: require anchor past boundary + hysteresis.
      if (anchor < boundary + HYSTERESIS_PX) return current;
    } else {
      // Moving up: require anchor before boundary - hysteresis.
      if (anchor > boundary - HYSTERESIS_PX) return current;
    }
    return candidate;
  }

  // ── Pointer / magnification ─────────────────────────────────────────
  _onPointer(event) {
    if (this._layoutFrame) return;
    this._layoutFrame = this._raf(() => {
      this._layoutFrame = 0;
      const railRect = this.rail.getBoundingClientRect();
      const relY = event.clientY - railRect.top;
      const positions = computeTickPositions(
        this.turns.length,
        railRect.height || this.rail.offsetHeight || 200,
      );
      let nearest = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < positions.length; i++) {
        const distance = Math.abs(positions[i] - relY);
        if (distance < nearestDist) {
          nearestDist = distance;
          nearest = i;
        }
      }
      this._hoverIndex = nearest;
      this._applyMagnification(nearest);
      this._showPreview(nearest, event.clientY);
    });
  }

  _applyMagnification(center) {
    if (center < 0 || this.turns.length === 0) return;
    const indices = [];
    for (
      let i = Math.max(0, center - MAGNIFY_NEIGHBORS);
      i <= Math.min(this.turns.length - 1, center + MAGNIFY_NEIGHBORS);
      i++
    ) {
      indices.push(i);
    }
    // Reset only the previous neighborhood, not every tick.
    const last = this._lastMagnify;
    for (const i of last.indices) {
      const el = this._ticks[i];
      if (!el || indices.includes(i)) continue;
      el.style.removeProperty("--mag");
      el.classList.remove("near", "nearest");
    }
    for (const i of indices) {
      const el = this._ticks[i];
      if (!el) continue;
      const dist = Math.abs(i - center);
      const mag = dist === 0 ? 1 : Math.max(0, 1 - dist / (MAGNIFY_NEIGHBORS + 1));
      el.style.setProperty("--mag", String(mag));
      el.classList.toggle("nearest", i === center);
      el.classList.toggle("near", i !== center && mag > 0);
    }
    this._lastMagnify = { center, indices };
  }

  _resetMagnification() {
    for (const i of this._lastMagnify.indices) {
      const el = this._ticks[i];
      if (!el) continue;
      el.style.removeProperty("--mag");
      el.classList.remove("near", "nearest");
    }
    this._lastMagnify = { center: -1, indices: [] };
  }

  // ── Preview ─────────────────────────────────────────────────────────

  _showPreview(index, pointerY = null) {
    const turn = this.turns[index];
    if (!turn) return;
    this._cancelClose();
    this._previewTurn = turn;
    if (Number.isFinite(pointerY)) this._previewPointerY = pointerY;
    this.preview.style.display = "";
    this._populatePreview(turn);
    this._clampPreview();
  }

  _schedulePreviewRefresh() {
    if (this._layoutFrame) return;
    this._scheduleLayoutFrame();
  }

  _refreshPreview() {
    if (this._previewTurn) {
      this._populatePreview(this._previewTurn);
      this._clampPreview();
    }
  }

  _populatePreview(turn) {
    // Prompt: plain text; image-only turns use the localized label.
    let promptText = turn.userText;
    if (!promptText && turn.hasUserImage) {
      promptText = t("chatNavigation.imageMessage");
    }
    this.previewPrompt.textContent = promptText || "";

    // Response: visible text or a localized status label.
    const isStatus = !turn.assistantText;
    let responseText;
    if (turn.assistantText) {
      responseText = turn.assistantText;
    } else if (turn.responseState === RESPONSE_WAITING) {
      responseText = t("chatNavigation.waiting");
    } else if (turn.responseState === RESPONSE_STREAMING) {
      responseText = t("chatNavigation.generating");
    } else {
      responseText = t("chatNavigation.noVisibleResponse");
    }
    // textContent only — never innerHTML. Hostile payloads stay inert.
    this.previewResponse.textContent = responseText;
    this.previewResponse.classList.toggle("status", isStatus);
  }

  _clampPreview() {
    const vw = this._measureViewport ? this._measureViewport().width : window.innerWidth;
    const vh = this._measureViewport ? this._measureViewport().height : window.innerHeight;
    const cardRect = this.preview.getBoundingClientRect();
    const rootRect = this.root.getBoundingClientRect();
    const railRect = this.rail.getBoundingClientRect();
    const margin = 8;

    // Preview coordinates are relative to the transformed root, whereas the
    // pointer and viewport are page coordinates. Convert only after clamping
    // in page space so the card stays beside the hovered tick.
    const pointerY = this._previewPointerY ?? railRect.top + railRect.height / 2;
    const maxTop = Math.max(margin, vh - cardRect.height - margin);
    const visualTop = Math.min(Math.max(margin, pointerY - cardRect.height / 2), maxTop);
    this.preview.style.top = `${Math.round(visualTop + cardRect.height / 2 - rootRect.top)}px`;

    const desiredLeft = railRect.right + margin;
    const maxLeft = Math.max(margin, vw - cardRect.width - margin);
    const visualLeft = Math.min(Math.max(margin, desiredLeft), maxLeft);
    this.preview.style.left = `${Math.round(visualLeft - rootRect.left)}px`;
  }

  _hidePreview(immediate = false) {
    if (immediate) {
      this._closeNow();
      return;
    }
    this._startClose();
  }

  _startClose() {
    this._cancelClose();
    this._closeTimer = this._st(() => this._closeNow(), PREVIEW_CLOSE_DELAY_MS);
  }

  _cancelClose() {
    if (this._closeTimer) {
      this._ct(this._closeTimer);
      this._closeTimer = 0;
    }
  }

  _closeNow() {
    this._closeTimer = 0;
    this._previewTurn = null;
    this._previewPointerY = null;
    this.preview.style.display = "none";
    this.previewPrompt.textContent = "";
    this.previewResponse.textContent = "";
    this.previewResponse.classList.remove("status");
  }

  _onEnter() {
    this._cancelClose();
  }

  _onLeave() {
    this._hoverIndex = -1;
    this._resetMagnification();
    this._startClose();
  }

  _onPreviewEnter() {
    this._cancelClose();
  }

  _onPreviewLeave() {
    this._startClose();
  }

  // ── Scroll tracking ─────────────────────────────────────────────────

  _onScroll() {
    if (this.turns.length < MIN_VISIBLE_TURNS) return;
    this._scheduleLayoutFrame();
  }

  // ── Click navigation ────────────────────────────────────────────────

  _onClick() {
    const index = this._hoverIndex >= 0 ? this._hoverIndex : this._activeIndex;
    this._navigateTo(index);
  }

  _navigateTo(index) {
    const turn = this.turns[index];
    if (!turn) return;
    if (!turn.userElement || !document.body.contains(turn.userElement)) {
      // Stale target: remove the turn before navigation.
      this._removeTurn(index);
      return;
    }
    const reduceMotion = this._reducedMotion || prefersReducedMotion();
    try {
      turn.userElement.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
        block: reduceMotion ? "start" : "center",
      });
    } catch {
      turn.userElement.scrollIntoView();
    }
    this._highlight(turn.userElement);
    this._hidePreview(true);
  }

  _highlight(el) {
    el.classList.add("chat-nav-target");
    if (this._highlightTimer) this._ct(this._highlightTimer);
    this._highlightTimer = this._st(() => {
      this._highlightTimer = 0;
      el.classList.remove("chat-nav-target");
    }, NAV_HIGHLIGHT_MS);
  }

  _removeTurn(index) {
    const [turn] = this.turns.splice(index, 1);
    if (!turn) return;
    if (turn.userElement) {
      try {
        turn.userElement.removeEventListener("load", this._boundImageLoad, true);
        turn.userElement.removeEventListener("error", this._boundImageLoad, true);
      } catch {}
      this._resizeObserver?.unobserve?.(turn.userElement);
    }
    if (this._streamingTurn === turn) this._streamingTurn = null;
    this._offsetsDirty = true;
    this._scheduleLayoutFrame();
  }

  // ── Locale ──────────────────────────────────────────────────────────

  _onLocaleChange() {
    // Refresh an open preview's status text without rebuilding chat messages.
    if (this._previewTurn) this._populatePreview(this._previewTurn);
  }

  // ── Reset / destroy ─────────────────────────────────────────────────

  /**
   * Clear the turn index (session switch / new session / clear / load failure).
   * Cancels pending frames, observers for turns, and preview state.
   */
  reset() {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn.userElement) {
        try {
          turn.userElement.removeEventListener("load", this._boundImageLoad, true);
          turn.userElement.removeEventListener("error", this._boundImageLoad, true);
        } catch {}
        this._resizeObserver?.unobserve?.(turn.userElement);
      }
    }
    this.turns = [];
    this._offsets = [];
    this._offsetsDirty = true;
    this._activeIndex = -1;
    this._hoverIndex = -1;
    this._streamingTurn = null;
    this._streamingPending = false;
    this._hidePreview(true);
    this._resetMagnification();
    // Clear any stray ticks immediately.
    while (this._ticks.length) this._ticks.pop().remove();
    this._scheduleLayoutFrame();
  }

  /**
   * Tear down all DOM, listeners, observers, timers, and frames.
   */
  destroy() {
    this._detachLocale?.();
    this._detachLocale = null;
    if (this._layoutFrame) {
      this._craf(this._layoutFrame);
      this._layoutFrame = 0;
    }
    if (this._closeTimer) {
      this._ct(this._closeTimer);
      this._closeTimer = 0;
    }
    if (this._highlightTimer) {
      this._ct(this._highlightTimer);
      this._highlightTimer = 0;
    }
    this.messagesContainer?.removeEventListener("scroll", this._boundScroll);
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this.rail.removeEventListener("pointermove", this._boundPointer);
    this.rail.removeEventListener("pointerdown", this._boundEnter);
    this.rail.removeEventListener("pointerleave", this._boundLeave);
    this.rail.removeEventListener("click", this._boundClick);
    this.preview.removeEventListener("pointerenter", this._boundPreviewEnter);
    this.preview.removeEventListener("pointerleave", this._boundPreviewLeave);
    for (const turn of this.turns) {
      if (!turn.userElement) continue;
      try {
        turn.userElement.removeEventListener("load", this._boundImageLoad, true);
        turn.userElement.removeEventListener("error", this._boundImageLoad, true);
      } catch {}
    }
    this.root.remove();
    this.turns = [];
    this._ticks = [];
    this._offsets = [];
  }
}

export function createChatHistoryNavigation({
  host = null,
  messages = null,
  requestFrame,
  cancelFrame,
  ...options
} = {}) {
  if (!host) return createNoOpNavigator();
  try {
    return new ChatHistoryNavigator(host, {
      ...options,
      messagesContainer: messages,
      requestAnimationFrame: requestFrame,
      cancelAnimationFrame: cancelFrame,
    });
  } catch {
    console.warn("[Picot] Chat history navigation disabled");
    return createNoOpNavigator();
  }
}

const NOOP = () => {};

export function createNoOpNavigator() {
  return {
    addUserTurn: NOOP,
    beginAssistantMessage: NOOP,
    updateAssistantMessage: NOOP,
    completeAssistantMessage: NOOP,
    invalidateLayout: NOOP,
    reset: NOOP,
    destroy: NOOP,
  };
}
