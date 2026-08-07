// ABOUTME: Shared modal-dialog focus management for the Skills settings tabs.
// ABOUTME: Adds focus trap, Escape-to-cancel, background inert, and opener focus restoration.

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** @returns {HTMLElement[]} */
function focusableWithin(root) {
  // The selector already excludes [disabled]; we intentionally skip a
  // layout-based visibility check so this works in jsdom (no layout) and for
  // controls the dialog reveals itself.
  return [...root.querySelectorAll(FOCUSABLE_SELECTOR)];
}

let activeModal = null;

/**
 * Drive a single inline modal dialog across re-renders. Call after every
 * render that may have shown, hidden, or rebuilt the dialog.
 *
 * - When `dialog` is non-null: arms a Tab/Shift+Tab focus trap, listens for
 *   Escape to invoke `onCancel`, marks background siblings through `inertRoot`
 *   `inert`, and moves focus to `initialFocus` (or the first focusable control).
 * - When `dialog` is null: tears down the previous trap, un-sets `inert`, and
 *   restores focus through the supplied stable callback/selector.
 *
 * Only one modal is managed at a time (module-singleton). Re-entering with a
 * new dialog (or null) cleans up the previous one first.
 *
 * @param {HTMLElement|null} dialog - the dialog element, or null when closed.
 * @param {Object} [options]
 * @param {HTMLElement} [options.initialFocus] - element to focus on open.
 * @param {HTMLElement|(()=>HTMLElement|null)} [options.restoreFocusTo] - opener or resolver.
 * @param {HTMLElement} [options.inertRoot] - ancestor whose background is inerted.
 * @param {string} [options.owner] - stable owner preventing another tab's render from closing this dialog.
 * @param {() => void} [options.onCancel] - invoked on Escape.
 */
export function manageModalDialog(dialog, options = {}) {
  if (!dialog) {
    // An inactive tab can re-render on locale changes; it must not close the
    // modal owned by the currently active Skills tab.
    if (!options.owner || activeModal?.owner === options.owner) {
      activeModal?.cleanup();
      activeModal = null;
    }
    return;
  }

  activeModal?.cleanup();
  activeModal = null;
  const { initialFocus, restoreFocusTo, inertRoot, owner, onCancel } = options;

  // Inert siblings at every level from the dialog to the Skills settings root.
  // The dialog itself stays connected while the surrounding panels, tablist,
  // and save message become non-interactive.
  const inerted = [];
  let branch = dialog;
  while (branch.parentElement) {
    const parent = branch.parentElement;
    for (const sibling of parent.children) {
      if (sibling === branch || sibling.hasAttribute("inert")) continue;
      sibling.setAttribute("inert", "");
      inerted.push(sibling);
    }
    if (parent === inertRoot) break;
    branch = parent;
  }

  const onKeydown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
      return;
    }
    if (event.key !== "Tab") return;
    const foci = focusableWithin(dialog);
    if (foci.length === 0) return;
    const first = foci[0];
    const last = foci[foci.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };
  dialog.addEventListener("keydown", onKeydown);

  // Move focus into the dialog.
  const target = initialFocus ?? focusableWithin(dialog)[0];
  target?.focus();

  activeModal = {
    owner,
    cleanup: () => {
      dialog.removeEventListener("keydown", onKeydown);
      for (const sibling of inerted) sibling.removeAttribute("inert");
      const opener = typeof restoreFocusTo === "function" ? restoreFocusTo() : restoreFocusTo;
      opener?.focus?.();
    },
  };
}
