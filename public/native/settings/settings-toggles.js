// Wires the settings toggle switches in the General tab. Auto-compaction is
// persisted to Pi's default settings; client-only toggles still use localStorage.

const STORAGE_PREFIX = "picot-settings-";

export function setupSettingsToggles({ configGateway, onError } = {}) {
  const toggles = [
    {
      id: "toggle-auto-compact",
      key: "auto-compact",
      defaultValue: true,
      persist: "config",
      load: async () => {
        if (!configGateway) return undefined;
        const response = await configGateway.call("get_default_auto_compaction", {
          scope: "global",
        });
        if (!response?.ok) throw new Error(response?.error || "Failed to load auto-compaction");
        return response.data?.enabled;
      },
      save: async (enabled) => {
        if (!configGateway) return;
        const response = await configGateway.call("set_default_auto_compaction", {
          enabled,
          scope: "global",
        });
        if (!response?.ok) throw new Error(response?.error || "Failed to save auto-compaction");
      },
      onChange: (enabled) => {
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
      id: "toggle-task-notifications",
      key: "task-notifications",
      defaultValue: true,
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

    const applyState = (isEnabled) => {
      button.classList.toggle("on", isEnabled);
      button.setAttribute("aria-checked", String(isEnabled));
      config.onChange?.(isEnabled);
    };

    const storageKey = `${STORAGE_PREFIX}${config.key}`;
    const storedValue = localStorage.getItem(storageKey);
    const initialState = storedValue !== null ? storedValue === "true" : config.defaultValue;
    applyState(initialState);

    if (config.persist === "config") {
      config
        .load?.()
        .then((enabled) => {
          if (typeof enabled === "boolean") applyState(enabled);
        })
        .catch((error) => onError?.(error));
    }

    // Wire click handler
    button.addEventListener("click", () => {
      const previousState = button.classList.contains("on");
      const newState = !previousState;
      applyState(newState);
      if (config.persist === "config") {
        config.save?.(newState).catch((error) => {
          applyState(previousState);
          onError?.(error);
        });
      } else {
        localStorage.setItem(storageKey, String(newState));
      }
    });
  }

  return {
    getToggleState(key) {
      const config = toggles.find((t) => t.key === key);
      const button = config?.id ? document.getElementById(config.id) : null;
      if (button) return button.classList.contains("on");
      const storageKey = `${STORAGE_PREFIX}${key}`;
      const storedValue = localStorage.getItem(storageKey);
      if (storedValue !== null) return storedValue === "true";
      return config?.defaultValue ?? false;
    },
    setToggleState(key, enabled) {
      const config = toggles.find((t) => t.key === key);
      if (config?.persist !== "config") {
        const storageKey = `${STORAGE_PREFIX}${key}`;
        localStorage.setItem(storageKey, String(enabled));
      }
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
