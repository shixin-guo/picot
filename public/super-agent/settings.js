export const SUPER_AGENT_ENABLED_STORAGE_KEY = "pi-studio-super-agent-enabled";

export function isSuperAgentEnabled(storage = localStorage) {
  return storage?.getItem(SUPER_AGENT_ENABLED_STORAGE_KEY) === "true";
}

export function setSuperAgentEnabled(enabled, storage = localStorage) {
  storage?.setItem(SUPER_AGENT_ENABLED_STORAGE_KEY, String(Boolean(enabled)));
}
