// Wires the thinking-effort radio group in the settings General tab. Updates
// the thinking level via runtime.request({type: "set_thinking_level"}) and
// syncs the UI (radio aria-checked, thumb position, level name display).

import { randomId } from "./random-id.js";

export function setupThinkingEffortControl({ runtime, getTarget, onError }) {
  const radioGroup = document.getElementById("thinking-effort");
  const levelName = document.getElementById("thinking-effort-name");
  const thumb = document.getElementById("thinking-effort-marker");
  if (!radioGroup || !runtime || !getTarget) return;

  const buttons = Array.from(radioGroup.querySelectorAll(".thinking-effort-dot"));
  const levels = buttons.map((btn) => btn.dataset.level).filter(Boolean);

  function updateUI(level) {
    const index = levels.indexOf(level);
    if (index === -1) return;

    // Update aria-checked and active state
    for (let i = 0; i < buttons.length; i++) {
      const isActive = i === index;
      buttons[i].setAttribute("aria-checked", String(isActive));
      buttons[i].classList.toggle("active", isActive);
    }

    // Update level name display
    if (levelName) {
      levelName.textContent = level;
    }

    // Move thumb to the selected position. The thumb has real width (it's a
    // pill, not a point), so anchor it to the button's left edge, centered
    // within the button's own width — not the button's center point, which
    // would push the pill half its width to the right of the target dot.
    if (thumb && buttons[index]) {
      const button = buttons[index];
      const thumbOffset = button.offsetLeft + (button.offsetWidth - thumb.offsetWidth) / 2;
      thumb.style.left = `${thumbOffset}px`;
    }
  }

  async function setThinkingLevel(level) {
    const target = getTarget();
    if (!target) {
      onError?.(new Error("No active session"));
      return;
    }

    try {
      await runtime.request({ type: "set_thinking_level", level }, target, {
        idempotencyKey: randomId(),
      });
      updateUI(level);
    } catch (error) {
      onError?.(error);
    }
  }

  // Wire click handlers
  for (const button of buttons) {
    button.addEventListener("click", () => {
      const level = button.dataset.level;
      if (level) {
        setThinkingLevel(level).catch((error) => onError?.(error));
      }
    });
  }

  // Keyboard navigation for radio group
  radioGroup.addEventListener("keydown", (event) => {
    const currentIndex = buttons.findIndex((btn) => btn.getAttribute("aria-checked") === "true");
    let nextIndex = currentIndex;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      nextIndex = (currentIndex + 1) % buttons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      nextIndex = (currentIndex - 1 + buttons.length) % buttons.length;
    } else {
      return;
    }

    const nextLevel = levels[nextIndex];
    if (nextLevel) {
      buttons[nextIndex].focus();
      setThinkingLevel(nextLevel).catch((error) => onError?.(error));
    }
  });

  return { updateUI };
}
