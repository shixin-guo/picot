// Wires the settings toggle switches in the General tab (auto-compaction, show
// thinking, auth). Persists state to localStorage and applies UI classes. These
// toggles control client-side UI behavior rather than runtime configuration.

const STORAGE_PREFIX = "picot-settings-";

export function setupSettingsToggles() {
  const toggles = [
    {
      id: "toggle-auto-compact",
      key: "auto-compact",
      defaultValue: false,
      onChange: (enabled) => {
        // Auto-compaction behavior would be implemented by message-renderer.js
        document.body.dataset.autoCompact = enabled ? "on" : "off";
      },
    },
    {
      id: "toggle-show-thinking",
      key: "show-thinking",
      defaultValue: true,
      onChange: (enabled) => {
        // Show/hide thinking blocks in messages
        document.body.dataset.showThinking = enabled ? "on" : "off";
      },
    },
    {
      id: "toggle-auth",
      key: "auth-enabled",
      defaultValue: false,
      onChange: (enabled) => {
        // Auth toggle state (actual auth logic is handled by the host)
        document.body.dataset.authEnabled = enabled ? "on" : "off";
      },
    },
    {
      id: "toggle-beta-updates",
      key: "beta-updates",
      defaultValue: false,
      onChange: (enabled) => {
        window.dispatchEvent(
          new CustomEvent("picot-update-channel-changed", {
            detail: { beta: enabled },
          }),
        );
      },
    },
  ];

  for (const config of toggles) {
    const button = document.getElementById(config.id);
    if (!button) continue;

    // Load initial state from localStorage
    const storageKey = `${STORAGE_PREFIX}${config.key}`;
    const storedValue = localStorage.getItem(storageKey);
    const isEnabled = storedValue !== null ? storedValue === "true" : config.defaultValue;

    // Set initial UI state
    button.classList.toggle("on", isEnabled);
    button.setAttribute("aria-checked", String(isEnabled));
    config.onChange?.(isEnabled);

    // Wire click handler
    button.addEventListener("click", () => {
      const newState = !button.classList.contains("on");
      button.classList.toggle("on", newState);
      button.setAttribute("aria-checked", String(newState));
      localStorage.setItem(storageKey, String(newState));
      config.onChange?.(newState);
    });
  }

  return {
    getToggleState(key) {
      const storageKey = `${STORAGE_PREFIX}${key}`;
      const storedValue = localStorage.getItem(storageKey);
      const config = toggles.find((t) => t.key === key);
      if (storedValue !== null) return storedValue === "true";
      return config?.defaultValue ?? false;
    },
    setToggleState(key, enabled) {
      const storageKey = `${STORAGE_PREFIX}${key}`;
      localStorage.setItem(storageKey, String(enabled));
      const config = toggles.find((t) => t.key === key);
      if (config?.id) {
        const button = document.getElementById(config.id);
        if (button) {
          button.classList.toggle("on", enabled);
          button.setAttribute("aria-checked", String(enabled));
        }
      }
      config?.onChange?.(enabled);
    },
  };
}
