// ABOUTME: Renders the agent settings.json, AGENTS.md, and APPEND_SYSTEM.md
// ABOUTME: editors on the Settings Advanced Configuration tab behind an injected gateway.
// The provider/model catalog UI lives in the sibling models-page.js (Models tab).

import { onLocaleChange, t } from "../../i18n.js";
import {
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./settings-save-status.js";

function wireFileEditor({ configGateway, pathEl, textareaEl, errorEl, saveBtn, readOp, writeOp }) {
  async function load() {
    if (!textareaEl) return;
    errorEl?.classList.add("hidden");
    textareaEl.value = "";
    if (pathEl) {
      pathEl.textContent = t("migrated.native.settings.settingsConfig.textcontent.loading");
      pathEl.title = "";
    }
    try {
      const data = await configGateway.call(readOp);
      if (!data?.ok) throw new Error(data?.error || "Failed to load file");
      // Markdown editors are plain text: no pretty-printing, no validation.
      textareaEl.value = data.data.content ?? "";
      if (pathEl) {
        pathEl.textContent = data.data.path || "";
        pathEl.title = data.data.path || "";
      }
    } catch (e) {
      if (pathEl) pathEl.textContent = "";
      if (errorEl) {
        errorEl.textContent = e.message || String(e);
        errorEl.classList.remove("hidden");
      }
    }
  }

  saveBtn?.addEventListener("click", async () => {
    if (!textareaEl) return;
    clearSettingsSaveMessage(errorEl);
    const content = textareaEl.value;
    setSettingsSaveButtonSaving(saveBtn, true);
    try {
      const data = await configGateway.call(writeOp, { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save file");
      showSettingsSaveSuccess(errorEl);
    } catch (e) {
      showSettingsSaveError(errorEl, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(saveBtn, false);
    }
  });

  return { load };
}

export function setupSettingsConfig({ configGateway }) {
  const call = (op, params, options) => configGateway.call(op, params, options);
  const inlineConfigPath = document.getElementById("inline-config-path");
  const inlineConfigPathCopy = document.getElementById("inline-config-path-copy");
  const inlineConfigTextarea = document.getElementById("inline-config-textarea");
  const inlineConfigError = document.getElementById("inline-config-error");
  const inlineConfigSave = document.getElementById("inline-config-save");

  function setInlineConfigPath(path, { copyable = true } = {}) {
    if (!inlineConfigPath) return;
    inlineConfigPath.textContent = path;
    inlineConfigPath.title = path;
    if (inlineConfigPathCopy) inlineConfigPathCopy.classList.toggle("hidden", !path || !copyable);
  }

  async function loadInlineConfigEditor() {
    if (!inlineConfigTextarea) return;
    inlineConfigError?.classList.add("hidden");
    inlineConfigTextarea.value = "";
    setInlineConfigPath(t("migrated.native.settings.settingsConfig.textcontent.loading"), {
      copyable: false,
    });
    try {
      const data = await call("read_agent_config");
      if (!data?.ok) throw new Error(data?.error || "Failed to load config");
      try {
        inlineConfigTextarea.value = JSON.stringify(JSON.parse(data.data.content), null, 2);
      } catch {
        inlineConfigTextarea.value = data.data.content;
      }
      setInlineConfigPath(data.data.path || "");
    } catch (e) {
      setInlineConfigPath("", { copyable: false });
      if (inlineConfigError) {
        inlineConfigError.textContent = e.message || String(e);
        inlineConfigError.classList.remove("hidden");
      }
    }
  }

  inlineConfigPathCopy?.addEventListener("click", async () => {
    const path = inlineConfigPath?.textContent || "";
    if (!path) return;
    const defaultLabel = t("settings.copyConfigPath");
    try {
      await navigator.clipboard?.writeText(path);
      inlineConfigPathCopy.title = t("settings.configPathCopied");
      inlineConfigPathCopy.setAttribute("aria-label", t("settings.configPathCopied"));
    } catch {
      inlineConfigPathCopy.title = t("settings.configPathCopyFailed");
      inlineConfigPathCopy.setAttribute("aria-label", t("settings.configPathCopyFailed"));
    }
    setTimeout(() => {
      inlineConfigPathCopy.title = defaultLabel;
      inlineConfigPathCopy.setAttribute("aria-label", defaultLabel);
    }, 1500);
  });

  inlineConfigSave?.addEventListener("click", async () => {
    if (!inlineConfigTextarea) return;
    clearSettingsSaveMessage(inlineConfigError);
    const content = inlineConfigTextarea.value;
    try {
      JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, `Invalid JSON: ${e.message}`);
      return;
    }
    setSettingsSaveButtonSaving(inlineConfigSave, true);
    try {
      const data = await call("write_agent_config", { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save config");
      showSettingsSaveSuccess(inlineConfigError);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineConfigSave, false);
    }
  });

  const agentsMdEditor = wireFileEditor({
    configGateway,
    pathEl: document.getElementById("agents-md-path"),
    textareaEl: document.getElementById("agents-md-textarea"),
    errorEl: document.getElementById("agents-md-error"),
    saveBtn: document.getElementById("agents-md-save"),
    readOp: "read_agents_md",
    writeOp: "write_agents_md",
  });

  const appendSystemMdEditor = wireFileEditor({
    configGateway,
    pathEl: document.getElementById("append-system-md-path"),
    textareaEl: document.getElementById("append-system-md-textarea"),
    errorEl: document.getElementById("append-system-md-error"),
    saveBtn: document.getElementById("append-system-md-save"),
    readOp: "read_append_system_md",
    writeOp: "write_append_system_md",
  });

  onLocaleChange(() => {
    if (inlineConfigTextarea?.isConnected) void loadInlineConfigEditor();
    if (document.getElementById("agents-md-textarea")?.isConnected) void agentsMdEditor.load();
    if (document.getElementById("append-system-md-textarea")?.isConnected) {
      void appendSystemMdEditor.load();
    }
  });

  return {
    loadInlineConfigEditor,
    loadAgentsMdEditor: agentsMdEditor.load,
    loadAppendSystemMdEditor: appendSystemMdEditor.load,
  };
}
