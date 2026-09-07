/**
 * Conversation navigator rail (Codex-style dot track).
 *
 * Renders a vertical rail of dots — one per user/assistant turn — to the
 * right of the chat messages. Clicking a dot jumps to that conversation.
 * Hovering anywhere on the track shows a tooltip with the first ~120 chars
 * of the user prompt and ~180 chars of the assistant reply. The tooltip
 * stays visible for the whole time the pointer is on the track; only its
 * position and content change as the pointer moves.
 *
 * Usage:
 *   const nav = new ConvNav({
 *     messagesEl,   // the scrollable #messages container
 *     headerEl,     // the floating .header element (for offset calc)
 *     badgeEl,      // #scroll-bottom-badge
 *   });
 *   nav.mount();   // wire scroll + mutation + resize listeners
 *   nav.rebuild(); // call explicitly after a full history render
 *   nav.notifyNewMessage(); // call when a new assistant message arrives
 *   nav.destroy(); // clean up listeners
 */
export class ConvNav {
  #messagesEl;
  #headerEl;
  #badgeEl;
  #navEl;
  #trackEl;
  #tooltipEl;
  #tooltipQ;
  #tooltipA;
  #tooltipSep;

  #isScrolledUp = false;
  #tooltipHideTimer = null;
  #navLockedIdx = -1;
  #navLockTimer = null;
  #onJumpToEntry = null;
  #turns = [];
  #hoveredIdx = -1;

  static #MAX_HEIGHT = 560;

  constructor({ messagesEl, headerEl, badgeEl, onJumpToEntry = null }) {
    this.#messagesEl = messagesEl;
    this.#headerEl = headerEl;
    this.#badgeEl = badgeEl;
    // Jump-side hook for cross-panel sync (v3 parity): after the chat
    // scrolls to a turn, app.js highlights/scrolls the Info panel's tree
    // node for the same entry.
    this.#onJumpToEntry = onJumpToEntry;
    this.#navEl = document.getElementById("conv-nav");
    this.#trackEl = document.getElementById("conv-nav-track");
    this.#tooltipEl = document.getElementById("conv-nav-tooltip");
    this.#tooltipQ = document.getElementById("conv-nav-tooltip-q");
    this.#tooltipA = document.getElementById("conv-nav-tooltip-a");
    this.#tooltipSep = document.getElementById("conv-nav-tooltip-sep");
  }

  mount() {
    if (!this.#navEl || !this.#trackEl || !this.#messagesEl) return;

    if (this.#tooltipEl) {
      this.#tooltipEl.onmouseenter = () => clearTimeout(this.#tooltipHideTimer);
      this.#tooltipEl.onmouseleave = (e) => {
        if (this.#trackEl.contains(e.relatedTarget)) return;
        this.#hideTooltip();
      };
    }

    this._onTrackPointer = (e) => this.#updateHoverFromPointer(e);
    this._onTrackLeave = (e) => {
      if (this.#isTooltipTarget(e.relatedTarget)) return;
      this.#hoveredIdx = -1;
      this.#clearWave();
      this.#hideTooltip();
    };

    // Delegate clicks to the whole rail so users don't have to hit the thin
    // tick exactly: a click anywhere maps to the nearest turn (same logic as
    // hover). Inter-tick gaps and the rail's own padding are all jump targets.
    this._onNavClick = (e) => {
      // Dots handle their own click (mouse click gives the right index and
      // keyboard activation keeps working). Only delegate clicks that land
      // outside a dot — i.e. in the inter-tick gaps or rail padding — so the
      // user doesn't have to hit the thin tick precisely.
      if (e.target?.closest?.(".conv-nav-dot")) return;
      const idx = this.#indexFromClientY(e.clientY);
      if (idx < 0) return;
      const turn = this.#turns[idx];
      if (!turn) return;
      this.#jumpTo(turn, idx);
    };

    this.#trackEl.addEventListener("mouseenter", this._onTrackPointer);
    this.#trackEl.addEventListener("mousemove", this._onTrackPointer);
    this.#trackEl.addEventListener("mouseleave", this._onTrackLeave);
    this.#navEl.addEventListener("click", this._onNavClick);

    this._onScroll = () => {
      const threshold = 150;
      const el = this.#messagesEl;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
      this.#isScrolledUp = !atBottom;
      if (atBottom) this.#badgeEl?.classList.add("hidden");
      this.#buildDots();
    };

    this._onResize = () => this.#buildDots();

    this._observer = new MutationObserver(() => this.#buildDots());
    this._observer.observe(this.#messagesEl, { childList: true });

    this.#messagesEl.addEventListener("scroll", this._onScroll);
    window.addEventListener("resize", this._onResize);

    this.#buildDots();
  }

  destroy() {
    this.#messagesEl?.removeEventListener("scroll", this._onScroll);
    window.removeEventListener("resize", this._onResize);
    this.#trackEl?.removeEventListener("mouseenter", this._onTrackPointer);
    this.#trackEl?.removeEventListener("mousemove", this._onTrackPointer);
    this.#trackEl?.removeEventListener("mouseleave", this._onTrackLeave);
    this.#navEl?.removeEventListener("click", this._onNavClick);
    this._observer?.disconnect();
    clearTimeout(this.#tooltipHideTimer);
    clearTimeout(this.#navLockTimer);
  }

  /**
   * Call explicitly after renderHistory() finishes so the nav is always
   * up-to-date even if MutationObserver batching skipped a frame.
   */
  rebuild() {
    this.#buildDots();
  }

  /** Call after a new assistant message finishes rendering. */
  notifyNewMessage() {
    if (this.#isScrolledUp) {
      this.#badgeEl?.classList.remove("hidden");
    }
    this.#buildDots();
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Collect all (user, assistant?) turn pairs from the messages container. */
  #getConversations() {
    const turns = [];
    for (const node of this.#messagesEl.children) {
      if (node.classList.contains("message") && node.classList.contains("user")) {
        // Find the very next sibling that is an assistant message
        let sibling = node.nextElementSibling;
        while (sibling && !sibling.classList.contains("message")) {
          sibling = sibling.nextElementSibling;
        }
        const reply = sibling?.classList.contains("assistant") ? sibling : null;
        turns.push({ user: node, assistant: reply });
      }
    }
    return turns;
  }

  #getActiveIndex(turns) {
    if (this.#navLockedIdx >= 0 && this.#navLockedIdx < turns.length) return this.#navLockedIdx;
    const visibleTop = Math.max(
      this.#messagesEl.getBoundingClientRect().top,
      this.#headerEl?.getBoundingClientRect().bottom || 0,
    );
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].user.getBoundingClientRect().top <= visibleTop + 4) return i;
    }
    return 0;
  }

  #buildDots() {
    const turns = this.#getConversations();
    this.#turns = turns;
    const hasConvs = turns.length > 1;
    this.#navEl.classList.toggle("hidden", !hasConvs);
    if (!hasConvs) {
      this.#trackEl.replaceChildren();
      this.#hoveredIdx = -1;
      this.#hideTooltip(true);
      return;
    }

    const activeIdx = this.#getActiveIndex(turns);

    // Add missing dots
    while (this.#trackEl.children.length < turns.length) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "conv-nav-dot";
      dot.setAttribute("aria-label", `Jump to conversation ${this.#trackEl.children.length + 1}`);
      this.#trackEl.appendChild(dot);
    }
    // Remove extra dots
    while (this.#trackEl.children.length > turns.length) {
      this.#trackEl.removeChild(this.#trackEl.lastChild);
    }

    [...this.#trackEl.children].forEach((dot, i) => {
      dot.onclick = () => this.#jumpTo(this.#turns[i], i);
      dot.classList.toggle("active", i === activeIdx);
      dot.setAttribute("aria-label", `Jump to conversation ${i + 1}`);
      if (this.#hoveredIdx < 0) {
        // No wave when not hovering — keep all dots at their base CSS width
        dot.style.removeProperty("--nav-w");
      }
    });

    if (this.#hoveredIdx >= this.#turns.length) this.#hoveredIdx = this.#turns.length - 1;
    if (this.#hoveredIdx >= 0) {
      this.#applyWave(this.#hoveredIdx);
      const hoveredDot = this.#trackEl.children[this.#hoveredIdx];
      const hoveredTurn = this.#turns[this.#hoveredIdx];
      if (hoveredDot && hoveredTurn) this.#showTooltip(hoveredDot, hoveredTurn);
    }

    // Scale down track if it exceeds the max nav height
    const naturalHeight = this.#trackEl.scrollHeight;
    const scale = naturalHeight > ConvNav.#MAX_HEIGHT ? ConvNav.#MAX_HEIGHT / naturalHeight : 1;
    this.#trackEl.style.transform = scale < 1 ? `scale(${scale})` : "";
    this.#trackEl.style.transformOrigin = scale < 1 ? "top left" : "";
    this.#navEl.style.height = scale < 1 ? `${naturalHeight * scale}px` : "";
  }

  /** Apply gaussian-bell width wave centered on the hovered dot index. */
  #applyWave(centerIdx) {
    [...this.#trackEl.children].forEach((dot, i) => {
      const dist = Math.abs(i - centerIdx);
      // Gaussian bell: peak 20 px, base 10 px, σ=3
      const w = Math.round(10 + 10 * Math.exp(-(dist * dist) / (2 * 3 * 3)));
      dot.style.setProperty("--nav-w", `${w}px`);
    });
  }

  /** Remove per-dot wave widths, letting CSS default take over. */
  #clearWave() {
    for (const dot of this.#trackEl.children) dot.style.removeProperty("--nav-w");
  }

  #jumpTo(turn, idx) {
    if (idx !== undefined) {
      this.#navLockedIdx = idx;
      clearTimeout(this.#navLockTimer);
      this.#navLockTimer = setTimeout(() => {
        this.#navLockedIdx = -1;
        this.#buildDots();
      }, 800);
    }
    const visibleTop =
      this.#headerEl?.getBoundingClientRect().bottom ||
      this.#messagesEl.getBoundingClientRect().top;
    const delta = turn.user.getBoundingClientRect().top - visibleTop;
    const maxScrollTop = this.#messagesEl.scrollHeight - this.#messagesEl.clientHeight;
    const targetScrollTop = Math.max(0, Math.min(this.#messagesEl.scrollTop + delta, maxScrollTop));
    this.#messagesEl.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    const entryId = turn.user?.dataset.entryId;
    if (entryId) this.#onJumpToEntry?.(entryId);
    this.#flashHighlight(turn.user);
    this.#buildDots();
  }

  #flashHighlight(target) {
    target.classList.remove("message-jump-highlight");
    void target.offsetWidth; // reflow to replay animation
    target.classList.add("message-jump-highlight");
    target.addEventListener(
      "animationend",
      () => target.classList.remove("message-jump-highlight"),
      {
        once: true,
      },
    );
  }

  #isTooltipTarget(node) {
    return Boolean(this.#tooltipEl && node && this.#tooltipEl.contains(node));
  }

  #indexFromClientY(clientY) {
    const dots = this.#trackEl.children;
    if (!dots.length) return -1;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < dots.length; i++) {
      const rect = dots[i].getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - mid);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  #updateHoverFromPointer(e) {
    const idx = this.#indexFromClientY(e.clientY);
    if (idx < 0) return;
    if (
      idx === this.#hoveredIdx &&
      this.#tooltipEl &&
      !this.#tooltipEl.classList.contains("hidden")
    ) {
      return;
    }
    const turn = this.#turns[idx];
    const dot = this.#trackEl.children[idx];
    if (!turn || !dot) return;
    this.#hoveredIdx = idx;
    this.#applyWave(idx);
    this.#showTooltip(dot, turn);
  }

  #showTooltip(dotEl, turn) {
    if (!this.#tooltipEl) return;
    clearTimeout(this.#tooltipHideTimer);
    const q = turn.user.textContent.trim().slice(0, 120);
    const a = turn.assistant
      ? turn.assistant.textContent.trim().replace(/\s+/g, " ").slice(0, 180)
      : "";
    if (this.#tooltipQ) this.#tooltipQ.textContent = q;
    if (this.#tooltipA) {
      this.#tooltipA.textContent = a;
      this.#tooltipA.style.display = a ? "" : "none";
    }
    if (this.#tooltipSep) this.#tooltipSep.style.display = a ? "" : "none";

    const wasHidden = this.#tooltipEl.classList.contains("hidden");
    this.#tooltipEl.classList.remove("hidden");
    const dotRect = dotEl.getBoundingClientRect();
    const tipHeight = this.#tooltipEl.offsetHeight || 90;
    const tipWidth = this.#tooltipEl.offsetWidth || 260;
    const top = Math.max(
      8,
      Math.min(
        dotRect.top + dotRect.height / 2 - tipHeight / 2,
        window.innerHeight - tipHeight - 8,
      ),
    );
    this.#tooltipEl.style.top = `${top}px`;
    // Anchor the tooltip to the right of the dot (the rail sits on the
    // chat's left edge), following the dot so panels never cover it.
    this.#tooltipEl.style.left = `${Math.min(dotRect.right + 8, window.innerWidth - tipWidth - 8)}px`;

    // Replay the enter animation only on first show. Updating while already
    // visible (moving along the track) must not fade the tooltip out.
    if (!wasHidden) return;

    this.#tooltipEl.classList.remove("animating");
    void this.#tooltipEl.offsetWidth; // reflow
    this.#tooltipEl.classList.add("animating");
    this.#tooltipEl.addEventListener(
      "animationend",
      () => this.#tooltipEl?.classList.remove("animating"),
      { once: true },
    );
  }

  #hideTooltip(immediate = false) {
    if (!this.#tooltipEl) return;
    clearTimeout(this.#tooltipHideTimer);
    if (immediate) {
      this.#tooltipEl.classList.add("hidden");
      return;
    }
    this.#tooltipHideTimer = setTimeout(() => this.#tooltipEl.classList.add("hidden"), 120);
  }
}
