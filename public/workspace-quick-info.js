// ABOUTME: Workspace quick-info controller — hover/focus card with folder name, total session count,
// ABOUTME: full path, on-demand Git metadata, Pin/Unpin control, 30s cache, and inert-text safety.
import { onLocaleChange, t } from "./i18n.js";

// ── Timing & sizing constants ────────────────────────────────────────

const HOVER_INTENT_MS = 120;
const CLOSE_DELAY_MS = 120;
const CACHE_TTL_MS = 30_000;
const CARD_MARGIN_PX = 8;

// ── Helpers ──────────────────────────────────────────────────────────

/** Extract the folder name from a path (handles both `/` and `\` separators). */
function lastPathSegment(path) {
  if (typeof path !== "string" || !path) return "";
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/** Total session count — includes archived (archived filtering is the sidebar's job). */
function totalSessionCount(workspace) {
  return Array.isArray(workspace?.sessions) ? workspace.sessions.length : 0;
}

/** Cache key by workspace path (survives provisional→history ID changes). */
function workspaceCacheKey(workspace) {
  return workspace?.normalizedPath || workspace?.path || "";
}

// ── Typed error ──────────────────────────────────────────────────────

/**
 * Operational error for workspace quick-info failures.
 * Pin capacity failures are surfaced via the pin-store result object
 * (`{ ok: false, error: "capacity" }`), not by throwing this class.
 */
export class WorkspaceQuickInfoError extends Error {
  constructor(message, code = "workspace-quick-info") {
    super(message);
    this.name = "WorkspaceQuickInfoError";
    this.code = code;
  }
}

// ── Controller ───────────────────────────────────────────────────────

/**
 * Manages the workspace quick-info card lifecycle.
 *
 * The card appears when the user hovers (120 ms intent delay, cancelled on
 * leave) or keyboard-focuses (immediate) a workspace header. It shows folder
 * name, total session count (including Archived), full workspace path, and
 * loads Git metadata on demand with a 30-second positive/negative/failure
 * cache keyed by workspace path. All workspace-supplied values (folder names,
 * paths, repositories, branches, errors) are rendered via `textContent` —
 * never `innerHTML`.
 *
 * Constructor options (all optional, injectable for deterministic testing):
 * - `container` — HTMLElement to append the card to (default: `document.body`)
 * - `pinStore` — `{ isWorkspacePinned(id), pinWorkspace(id, path), unpinWorkspace(id), subscribe(cb) }`
 * - `fetchImpl` — `fetch` function for metadata requests
 * - `setTimeout` / `clearTimeout` — injectable schedulers
 * - `measureViewport` — `() => ({ width, height })`
 * - `createAbortController` — `() => AbortController`
 */
export class WorkspaceQuickInfo {
  constructor({
    container,
    pinStore,
    fetchImpl,
    setTimeout: st,
    clearTimeout: ct,
    measureViewport,
    createAbortController,
  } = {}) {
    this._container = container || (typeof document !== "undefined" ? document.body : null);
    this._pinStore = pinStore || null;
    this._fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this._st = st || ((cb, ms) => setTimeout(cb, ms));
    this._ct = ct || ((id) => clearTimeout(id));
    this._measureViewport = measureViewport || null;
    this._createAbortController = createAbortController || (() => new AbortController());

    this._headers = new Map(); // headerEl → { workspace, handlers }
    this._workspaces = new Map(); // workspaceId → workspace
    this._cache = new Map(); // path → { kind, data?, expiresAt }

    this._currentHeader = null;
    this._currentWorkspace = null;
    this._openReason = null; // 'pointer' | 'keyboard' | null
    this._hoverIntentTimer = 0;
    this._closeTimer = 0;
    this._requestSeq = 0;
    this._abortController = null;
    this._cardVisible = false;

    this._buildCard();
    this._attachCardListeners();

    this._detachPinState = this._pinStore?.subscribe?.(() => this._onPinStateChange()) || null;
    this._detachLocale = onLocaleChange(() => this._onLocaleChange());
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Bind a workspace header element for hover/focus quick-info.
   * Called by the sidebar after rendering each workspace group header.
   */
  bindHeader(headerEl, workspace) {
    if (!headerEl || !workspace) return;

    if (this._headers.has(headerEl)) this.unbindHeader(headerEl);

    const handlers = {
      pointerenter: () => this._onHeaderPointerEnter(headerEl, workspace),
      pointerleave: () => this._onHeaderPointerLeave(),
      focusin: () => this._onHeaderFocusIn(headerEl, workspace),
      focusout: (e) => this._onHeaderFocusOut(e),
      keydown: (e) => this._onHeaderKeyDown(e),
    };

    for (const [type, fn] of Object.entries(handlers)) {
      headerEl.addEventListener(type, fn);
    }

    this._headers.set(headerEl, { workspace, handlers });
    if (workspace.workspaceId) {
      this._workspaces.set(workspace.workspaceId, workspace);
    }

    if (
      this._cardVisible &&
      this._currentWorkspace &&
      workspaceCacheKey(this._currentWorkspace) === workspaceCacheKey(workspace)
    ) {
      this._currentHeader = headerEl;
      this._currentWorkspace = workspace;
      this._updatePinState();
      this._clampCard();
    }
  }

  /** Unbind a single header and close the card if it was the active target. */
  unbindHeader(headerEl) {
    const entry = this._headers.get(headerEl);
    if (!entry) return;
    for (const [type, fn] of Object.entries(entry.handlers)) {
      headerEl.removeEventListener(type, fn);
    }
    this._headers.delete(headerEl);
    if (this._currentHeader === headerEl) this._hideCard();
  }

  /** Unbind all headers before a sidebar rerender. */
  clearHeaders({ preserveCard = false } = {}) {
    for (const [el, entry] of this._headers) {
      for (const [type, fn] of Object.entries(entry.handlers)) {
        el.removeEventListener(type, fn);
      }
    }
    this._headers.clear();
    if (!preserveCard) this._hideCard();
  }

  /**
   * Replace the workspace model (called on sidebar re-render).
   * Handles provisional→history identity replacement for an open card without
   * closing it: the cache is keyed by path, so cached Git data transfers.
   */
  setWorkspaces(workspaces) {
    this._workspaces.clear();
    if (Array.isArray(workspaces)) {
      for (const ws of workspaces) {
        if (ws?.workspaceId) this._workspaces.set(ws.workspaceId, ws);
      }
    }

    if (!this._cardVisible || !this._currentWorkspace) return;

    const currentPath = workspaceCacheKey(this._currentWorkspace);
    const replacement = Array.from(this._workspaces.values()).find(
      (ws) => workspaceCacheKey(ws) === currentPath,
    );
    if (replacement && replacement.workspaceId !== this._currentWorkspace.workspaceId) {
      this._currentWorkspace = replacement;
      this._updatePinState();
    }
  }

  /** Close the card immediately (public escape hatch). */
  close() {
    this._hideCard();
  }

  /** Tear down all DOM, listeners, timers, and caches. */
  destroy() {
    this._cancelHoverIntent();
    this._cancelCloseDelay();
    this._abortCurrent();
    this._detachPinState?.();
    this._detachPinState = null;
    this._detachLocale?.();
    this._detachLocale = null;

    this.clearHeaders();
    this._workspaces.clear();
    this._cache.clear();

    this._detachCardListeners();
    this._cardEl.remove();

    this._currentHeader = null;
    this._currentWorkspace = null;
    this._cardVisible = false;
  }

  // ── DOM construction ───────────────────────────────────────────────

  _buildCard() {
    const card = document.createElement("div");
    card.className = "workspace-quick-info";
    card.setAttribute("role", "dialog");
    card.style.display = "none";
    card.style.position = "fixed";
    card.style.zIndex = "9000";

    // Header row: folder icon + folder name + pin button
    const headerRow = document.createElement("div");
    headerRow.className = "wqi-header-row";

    const icon = document.createElement("span");
    icon.className = "wqi-folder-icon";
    icon.setAttribute("aria-hidden", "true");

    this._folderEl = document.createElement("span");
    this._folderEl.className = "wqi-folder-name";

    this._pinBtn = document.createElement("button");
    this._pinBtn.type = "button";
    this._pinBtn.className = "wqi-pin-btn";
    this._pinBtn.setAttribute("aria-pressed", "false");
    this._pinBtn.hidden = true;

    const pinIcon = document.createElement("span");
    pinIcon.className = "wqi-pin-icon";
    pinIcon.setAttribute("aria-hidden", "true");
    this._pinBtn.appendChild(pinIcon);

    headerRow.append(icon, this._folderEl, this._pinBtn);

    // Content
    const content = document.createElement("div");
    content.className = "wqi-content";

    const countRow = this._createIconRow("wqi-count-row", "wqi-count-icon", "wqi-count");
    this._countEl = countRow.value;

    const pathRow = this._createIconRow("wqi-path-row", "wqi-path-icon", "wqi-path");
    this._pathEl = pathRow.value;

    // Git region
    const gitRegion = document.createElement("div");
    gitRegion.className = "wqi-git-region";

    this._gitLoadingEl = document.createElement("div");
    this._gitLoadingEl.className = "wqi-git-loading";
    this._gitLoadingEl.hidden = true;
    this._gitLoadingEl.setAttribute("aria-live", "polite");

    const repoRow = this._createIconRow("wqi-repo-row", "wqi-repo-icon", "wqi-repo");
    repoRow.row.hidden = true;
    this._repoEl = repoRow.value;

    gitRegion.append(this._gitLoadingEl, repoRow.row);
    this._repoRow = repoRow.row;

    // Error indicator (pin capacity, etc.)
    this._errorEl = document.createElement("div");
    this._errorEl.className = "wqi-error";
    this._errorEl.hidden = true;

    content.append(countRow.row, pathRow.row, gitRegion, this._errorEl);
    card.append(headerRow, content);

    this._cardEl = card;
    this._container?.appendChild(card);
  }

  _createIconRow(rowClass, iconClass, valueClass) {
    const row = document.createElement("div");
    row.className = `wqi-row ${rowClass}`;
    const icon = document.createElement("span");
    icon.className = iconClass;
    icon.setAttribute("aria-hidden", "true");
    const value = document.createElement("span");
    value.className = `wqi-row-value ${valueClass}`;
    row.append(icon, value);
    return { row, value };
  }

  _attachCardListeners() {
    this._boundCardPointerEnter = () => this._cancelCloseDelay();
    this._boundCardPointerLeave = () => {
      if (this._openReason === "pointer") this._startCloseDelay();
    };
    this._boundCardKeyDown = (e) => this._onCardKeyDown(e);
    this._boundCardFocusOut = (e) => this._onCardFocusOut(e);
    this._boundPinClick = () => this._onPinClick();

    this._cardEl.addEventListener("pointerenter", this._boundCardPointerEnter);
    this._cardEl.addEventListener("pointerleave", this._boundCardPointerLeave);
    this._cardEl.addEventListener("keydown", this._boundCardKeyDown);
    this._cardEl.addEventListener("focusout", this._boundCardFocusOut);
    this._pinBtn.addEventListener("click", this._boundPinClick);
  }

  _detachCardListeners() {
    if (!this._cardEl) return;
    this._cardEl.removeEventListener("pointerenter", this._boundCardPointerEnter);
    this._cardEl.removeEventListener("pointerleave", this._boundCardPointerLeave);
    this._cardEl.removeEventListener("keydown", this._boundCardKeyDown);
    this._cardEl.removeEventListener("focusout", this._boundCardFocusOut);
    this._pinBtn?.removeEventListener("click", this._boundPinClick);
  }

  // ── Card show / hide ───────────────────────────────────────────────

  _showCard(headerEl, workspace, reason) {
    this._cancelCloseDelay();

    if (this._currentHeader === headerEl && this._cardVisible) return;

    this._abortCurrent();

    this._currentHeader = headerEl;
    this._currentWorkspace = workspace;
    this._openReason = reason;

    this._populateStatic(workspace);
    this._updatePinState();
    this._clearError();

    this._cardEl.style.display = "";
    this._cardVisible = true;
    this._clampCard();
    this._loadGitMetadata(workspace);
  }

  _hideCard() {
    this._cancelHoverIntent();
    this._cancelCloseDelay();
    this._abortCurrent();

    this._cardEl.style.display = "none";
    this._cardVisible = false;
    this._currentHeader = null;
    this._currentWorkspace = null;
    this._openReason = null;

    this._folderEl.textContent = "";
    this._countEl.textContent = "";
    this._pathEl.textContent = "";
    this._gitLoadingEl.hidden = true;
    this._repoRow.hidden = true;
    this._clearError();
  }

  _clampCard() {
    if (!this._currentHeader) return;

    const vw = this._measureViewport ? this._measureViewport().width : window.innerWidth;
    const vh = this._measureViewport ? this._measureViewport().height : window.innerHeight;

    const headerRect = this._currentHeader.getBoundingClientRect();
    const cardRect = this._cardEl.getBoundingClientRect();

    let top = headerRect.top;
    let left = headerRect.right + CARD_MARGIN_PX;

    // Clamp vertically into the viewport.
    if (top + cardRect.height > vh) {
      top = Math.max(0, vh - cardRect.height - CARD_MARGIN_PX);
    }
    if (top < 0) top = 0;

    // If the card would overflow the right edge, flip to the left of the header.
    if (left + cardRect.width > vw) {
      left = Math.max(0, headerRect.left - cardRect.width - CARD_MARGIN_PX);
    }
    // Final horizontal clamp.
    left = Math.min(left, Math.max(0, vw - cardRect.width - CARD_MARGIN_PX));

    this._cardEl.style.top = `${Math.round(top)}px`;
    this._cardEl.style.left = `${Math.round(left)}px`;
  }

  // ── Content population ─────────────────────────────────────────────

  _populateStatic(workspace) {
    const folder = workspace.folderName || lastPathSegment(workspace.path);
    this._folderEl.textContent = folder || "";

    const count = totalSessionCount(workspace);
    this._countEl.textContent = t("sidebar.quickInfo.threads", { count });
    this._pathEl.textContent = workspace.path || "";

    this._cardEl.setAttribute(
      "aria-label",
      t("sidebar.quickInfo.cardLabel", { folder: folder || "" }),
    );

    // Git metadata is intentionally unobtrusive while loading so the card
    // retains its compact prototype layout.
    this._gitLoadingEl.textContent = t("sidebar.quickInfo.loadingGit");
    this._gitLoadingEl.hidden = true;
    this._repoRow.hidden = true;
  }

  async _loadGitMetadata(workspace) {
    const key = workspaceCacheKey(workspace);
    if (!key || !workspace.workspaceId) {
      this._gitLoadingEl.hidden = true;
      return;
    }

    // Cache hit — apply synchronously (loading flash is invisible to the user).
    const cached = this._cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this._applyGitResult(cached);
      return;
    }

    const seq = ++this._requestSeq;
    const controller = this._createAbortController();
    this._abortController = controller;

    const params = new URLSearchParams({
      workspaceId: workspace.workspaceId,
    });
    const url = `/api/workspace-info?${params}`;

    let result;
    try {
      const response = await this._fetchImpl(url, {
        signal: controller.signal,
      });
      // Stale: a newer target superseded this request.
      if (seq !== this._requestSeq) return;

      if (!response.ok) {
        result = { kind: "failure", expiresAt: Date.now() + CACHE_TTL_MS };
      } else {
        let data = null;
        try {
          data = await response.json();
        } catch {
          data = null;
        }
        if (seq !== this._requestSeq) return;

        result =
          data && data.isGit === true
            ? { kind: "git", data, expiresAt: Date.now() + CACHE_TTL_MS }
            : { kind: "negative", expiresAt: Date.now() + CACHE_TTL_MS };
      }
    } catch (error) {
      // Aborted requests are never cached — they were intentionally cancelled.
      if (error?.name === "AbortError" || controller.signal.aborted) return;
      if (seq !== this._requestSeq) return;
      result = { kind: "failure", expiresAt: Date.now() + CACHE_TTL_MS };
    }

    this._cache.set(key, result);

    // Apply only if this is still the active target.
    if (
      seq === this._requestSeq &&
      this._currentWorkspace &&
      workspaceCacheKey(this._currentWorkspace) === key
    ) {
      this._applyGitResult(result);
    }
  }

  _applyGitResult(result) {
    this._gitLoadingEl.hidden = true;

    if (result.kind === "git" && result.data?.repository) {
      this._repoEl.textContent = result.data.repository; // inert text
      this._repoRow.hidden = false;
    }
    // 'negative' and 'failure' leave the repository row hidden.
  }

  _clearError() {
    this._errorEl.textContent = "";
    this._errorEl.hidden = true;
  }

  // ── Pin control ────────────────────────────────────────────────────

  _updatePinState() {
    if (!this._pinStore || !this._currentWorkspace) {
      this._pinBtn.hidden = true;
      return;
    }

    this._pinBtn.hidden = false;
    const pinned = this._pinStore.isWorkspacePinned(this._currentWorkspace.workspaceId);

    this._pinBtn.setAttribute("aria-pressed", pinned ? "true" : "false");
    const label = pinned ? t("sidebar.unpinWorkspace") : t("sidebar.pinWorkspace");
    this._pinBtn.setAttribute("aria-label", label);
    this._pinBtn.title = label;
  }

  _onPinClick() {
    if (!this._pinStore || !this._currentWorkspace) return;

    const header = this._currentHeader;
    const workspace = this._currentWorkspace;
    const reason = this._openReason;
    const { workspaceId, path } = workspace;
    const isPinned = this._pinStore.isWorkspacePinned(workspaceId);

    // Pin changes synchronously rebuild the sidebar. Hiding before that shared
    // state mutation prevents the detached card from being rebound to a newly
    // inserted PINNED header and flashing at the viewport edge.
    this._hideCard();
    const result = isPinned
      ? this._pinStore.unpinWorkspace(workspaceId)
      : this._pinStore.pinWorkspace(workspaceId, path);

    if (result?.ok === false && result?.error === "capacity" && header) {
      this._showCard(header, workspace, reason || "pointer");
      this._errorEl.textContent = t("sidebar.quickInfo.pinCapacityError");
      this._errorEl.hidden = false;
    }
  }

  // ── Event handlers ─────────────────────────────────────────────────

  _onHeaderPointerEnter(headerEl, workspace) {
    this._cancelCloseDelay();
    if (this._currentHeader === headerEl && this._cardVisible) return;
    this._cancelHoverIntent();
    this._hoverIntentTimer = this._st(() => {
      this._hoverIntentTimer = 0;
      this._showCard(headerEl, workspace, "pointer");
    }, HOVER_INTENT_MS);
  }

  _onHeaderPointerLeave() {
    this._cancelHoverIntent();
    if (this._openReason === "pointer") this._startCloseDelay();
  }

  _onHeaderFocusIn(headerEl, workspace) {
    this._cancelCloseDelay();
    this._cancelHoverIntent();
    if (this._currentHeader === headerEl && this._cardVisible) {
      // Upgrade to keyboard mode so focus-loss (not pointer-leave) closes.
      this._openReason = "keyboard";
      return;
    }
    this._showCard(headerEl, workspace, "keyboard");
  }

  _onHeaderFocusOut(event) {
    const related = event.relatedTarget;
    if (related && this._cardEl.contains(related)) return;
    if (this._openReason === "keyboard") this._startCloseDelay();
  }

  _onHeaderKeyDown(event) {
    if (event.key === "Escape" && this._cardVisible) {
      event.preventDefault();
      event.stopPropagation();
      this._hideCard();
    }
  }

  _onCardKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      const header = this._currentHeader;
      this._hideCard();
      if (header) {
        try {
          header.focus();
        } catch {
          // Element may have been removed from the DOM.
        }
      }
    }
  }

  _onCardFocusOut(event) {
    const related = event.relatedTarget;
    if (related && this._cardEl.contains(related)) return;
    if (related && this._currentHeader?.contains(related)) return;
    if (this._openReason === "keyboard") this._startCloseDelay();
  }

  // ── Timer management ───────────────────────────────────────────────

  _startCloseDelay() {
    this._cancelCloseDelay();
    this._closeTimer = this._st(() => {
      this._closeTimer = 0;
      this._hideCard();
    }, CLOSE_DELAY_MS);
  }

  _cancelCloseDelay() {
    if (this._closeTimer) {
      this._ct(this._closeTimer);
      this._closeTimer = 0;
    }
  }

  _cancelHoverIntent() {
    if (this._hoverIntentTimer) {
      this._ct(this._hoverIntentTimer);
      this._hoverIntentTimer = 0;
    }
  }

  // ── Request management ─────────────────────────────────────────────

  _abortCurrent() {
    if (this._abortController) {
      try {
        this._abortController.abort();
      } catch {
        // Controller may already be aborted.
      }
      this._abortController = null;
    }
  }

  // ── Locale & pin-state callbacks ───────────────────────────────────

  _onLocaleChange() {
    if (!this._cardVisible || !this._currentWorkspace) return;
    this._populateStatic(this._currentWorkspace);
    this._updatePinState();
    const key = workspaceCacheKey(this._currentWorkspace);
    const cached = this._cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this._applyGitResult(cached);
    }
  }

  _onPinStateChange() {
    if (this._cardVisible && this._currentWorkspace) {
      this._updatePinState();
    }
  }
}
