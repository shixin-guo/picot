// ABOUTME: Builds the settings API-key editor and provider status rows.
// ABOUTME: Routes key changes through the authenticated Pi transport.

import { t } from "./i18n.js";
import { getTransport } from "./transport.js";

export function setupSettingsEditors({
  rpcCommand,
  onModelConfigurationChanged,
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
}) {
  const apiKeysContainer = document.getElementById("settings-api-keys");

  async function loadApiKeysPanel() {
    if (!apiKeysContainer) return;
    apiKeysContainer.replaceChildren();
    const loadingDiv = document.createElement("div");
    loadingDiv.className = "settings-api-keys-loading";
    loadingDiv.textContent = t("settings.loadingProviders");
    apiKeysContainer.appendChild(loadingDiv);
    const data = await rpcCommand({ type: "list_auth_status" });
    if (!data?.success || !Array.isArray(data.data?.providers)) {
      renderApiKeysPanelError(data?.error || t("errors.failedToLoadProviders"));
      return;
    }
    renderApiKeysPanel(data.data.providers);
  }

  function renderApiKeysPanelError(message) {
    apiKeysContainer.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "settings-api-keys-empty";
    const msg = document.createElement("div");
    msg.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "config-editor-cancel";
    retry.textContent = t("actions.retry");
    retry.style.marginTop = "8px";
    retry.addEventListener("click", () => loadApiKeysPanel());
    wrap.appendChild(msg);
    wrap.appendChild(retry);
    apiKeysContainer.appendChild(wrap);
  }

  function renderApiKeysPanel(providers) {
    apiKeysContainer.replaceChildren();
    if (providers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-api-keys-empty";
      empty.textContent = t("settings.apiKeys.noProviders");
      apiKeysContainer.appendChild(empty);
      return;
    }
    for (const p of providers) {
      apiKeysContainer.appendChild(buildApiKeyRow(p));
    }
  }

  function buildApiKeyRow(p) {
    const row = document.createElement("div");
    row.className = "api-key-row";
    row.dataset.provider = p.provider;

    const info = document.createElement("div");
    info.className = "api-key-row-info";
    const name = document.createElement("div");
    name.className = "api-key-row-name";
    name.textContent = p.displayName || p.provider;
    const status = document.createElement("div");
    status.className = `api-key-row-status${p.configured ? " configured" : ""}`;
    status.textContent = describeAuthStatus(p);
    info.appendChild(name);
    info.appendChild(status);

    const actions = document.createElement("div");
    actions.className = "api-key-row-actions";
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.textContent = p.configured ? t("actions.update") : t("actions.setKey");
    setBtn.addEventListener("click", () => openApiKeyEditor(row, p));
    actions.appendChild(setBtn);
    if (p.configured && p.source === "stored") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = t("actions.remove");
      removeBtn.addEventListener("click", () => removeApiKey(p));
      actions.appendChild(removeBtn);
    }

    row.appendChild(info);
    row.appendChild(actions);
    return row;
  }

  function describeAuthStatus(p) {
    if (!p.configured) return t("settings.auth.notConfigured");
    switch (p.source) {
      case "stored":
        return t("settings.auth.configuredAuthJson");
      case "environment":
        return t("settings.apiKeys.fromEnvironment", {
          label: p.label || t("settings.apiKeys.fromEnvironmentFallback"),
        });
      case "runtime":
        return t("settings.auth.runtimeOverride");
      case "fallback":
        return t("settings.auth.customProvider");
      default:
        return t("settings.auth.configured");
    }
  }

  function openApiKeyEditor(row, p) {
    const editor = document.createElement("div");
    editor.className = "api-key-editor";

    const title = document.createElement("div");
    title.className = "api-key-row-name";
    title.textContent = t("settings.apiKeys.editorTitle", {
      provider: p.displayName || p.provider,
    });
    editor.appendChild(title);

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("settings.apiKeys.pastePlaceholder");
    editor.appendChild(input);

    const err = document.createElement("div");
    err.className = "api-key-editor-error";
    err.style.display = "none";
    editor.appendChild(err);

    const actions = document.createElement("div");
    actions.className = "api-key-editor-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "config-editor-cancel";
    cancelBtn.textContent = t("actions.cancel");
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary";
    saveBtn.textContent = t("actions.save");
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    editor.appendChild(actions);

    row.replaceWith(editor);
    requestAnimationFrame(() => input.focus());

    const cancel = () => {
      editor.replaceWith(row);
    };
    cancelBtn.addEventListener("click", cancel);

    const save = async () => {
      const key = input.value.trim();
      if (!key) {
        err.textContent = t("errors.keyCannotBeEmpty");
        err.style.display = "";
        return;
      }
      saveBtn.disabled = true;
      const resp = await rpcCommand(
        { type: "set_api_key", provider: p.provider, apiKey: key },
        t("status.savingKey", { provider: p.provider }),
      );
      if (resp?.success) {
        await onModelConfigurationChanged?.();
        loadApiKeysPanel();
      } else {
        err.textContent = resp?.error || t("errors.failedToSaveKey");
        err.style.display = "";
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        save();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    });
  }

  async function removeApiKey(p) {
    const ok = confirm(
      t("settings.apiKeys.removeConfirm", { provider: p.displayName || p.provider }),
    );
    if (!ok) return;
    const resp = await rpcCommand(
      { type: "remove_api_key", provider: p.provider },
      t("status.removingKey", { provider: p.provider }),
    );
    if (resp?.success) {
      await onModelConfigurationChanged?.();
      loadApiKeysPanel();
    }
  }

  const inlineConfigPath = document.getElementById("inline-config-path");
  const inlineConfigTextarea = document.getElementById("inline-config-textarea");
  const inlineConfigError = document.getElementById("inline-config-error");
  const inlineConfigSave = document.getElementById("inline-config-save");

  async function loadInlineConfigEditor() {
    if (!inlineConfigTextarea) return;
    inlineConfigError?.classList.add("hidden");
    inlineConfigTextarea.value = "";
    if (inlineConfigPath) inlineConfigPath.textContent = t("status.loading");
    try {
      const resp = await fetch("/api/agent-config");
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || t("errors.failedToLoadConfig"));
      try {
        inlineConfigTextarea.value = JSON.stringify(JSON.parse(data.content), null, 2);
      } catch {
        inlineConfigTextarea.value = data.content;
      }
      if (inlineConfigPath) inlineConfigPath.textContent = data.path || "";
    } catch (e) {
      if (inlineConfigPath) inlineConfigPath.textContent = "";
      if (inlineConfigError) {
        inlineConfigError.textContent = e.message || String(e);
        inlineConfigError.classList.remove("hidden");
      }
    }
  }

  inlineConfigSave?.addEventListener("click", async () => {
    if (!inlineConfigTextarea) return;
    clearSettingsSaveMessage(inlineConfigError);
    const content = inlineConfigTextarea.value;
    try {
      JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, t("errors.invalidJson", { detail: e.message }));
      return;
    }
    setSettingsSaveButtonSaving(inlineConfigSave, true);
    try {
      const resp = await fetch("/api/agent-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || t("errors.failedToSaveConfig"));
      showSettingsSaveSuccess(inlineConfigError);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineConfigSave, false);
    }
  });

  const inlineModelsPath = document.getElementById("inline-models-path");
  const inlineModelsTextarea = document.getElementById("inline-models-textarea");
  const inlineModelsError = document.getElementById("inline-models-error");
  const inlineModelsSave = document.getElementById("inline-models-save");
  const inlineModelsInsertExample = document.getElementById("inline-models-insert-example");
  const modelsConfigDocsLink = document.getElementById("models-config-docs-link");

  const MODELS_JSON_EXAMPLE = `{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "llama3.1:8b" },
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
`;

  function showInlineModelsError(message) {
    showSettingsSaveError(inlineModelsError, message);
  }

  function clearInlineModelsError() {
    clearSettingsSaveMessage(inlineModelsError);
  }

  async function loadInlineModelsEditor() {
    if (!inlineModelsTextarea) return;
    clearInlineModelsError();
    inlineModelsTextarea.value = "";
    if (inlineModelsPath) inlineModelsPath.textContent = t("status.loading");
    try {
      const resp = await fetch("/api/models-config");
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || t("errors.failedToLoadModels"));
      try {
        inlineModelsTextarea.value = JSON.stringify(JSON.parse(data.content), null, 2);
      } catch {
        inlineModelsTextarea.value = data.content;
      }
      if (inlineModelsPath) inlineModelsPath.textContent = data.path || "";
    } catch (e) {
      if (inlineModelsPath) inlineModelsPath.textContent = "";
      showInlineModelsError(e.message || String(e));
    }
  }

  inlineModelsSave?.addEventListener("click", async () => {
    if (!inlineModelsTextarea) return;
    clearInlineModelsError();
    const content = inlineModelsTextarea.value;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      showInlineModelsError(t("errors.invalidJson", { detail: e.message }));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showInlineModelsError(t("errors.modelsMustBeObject"));
      return;
    }
    if (
      "providers" in parsed &&
      (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
    ) {
      showInlineModelsError(t("errors.providersMustBeObject"));
      return;
    }
    setSettingsSaveButtonSaving(inlineModelsSave, true);
    try {
      const resp = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || t("errors.failedToSaveModels"));
      showSettingsSaveSuccess(inlineModelsError);
      await onModelConfigurationChanged?.();
    } catch (e) {
      showInlineModelsError(e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineModelsSave, false);
    }
  });

  inlineModelsInsertExample?.addEventListener("click", () => {
    if (!inlineModelsTextarea) return;
    const current = inlineModelsTextarea.value.trim();
    if (current && current !== "{}" && current !== '{\n  "providers": {}\n}') {
      if (!confirm(t("settings.models.replaceConfirm"))) return;
    }
    inlineModelsTextarea.value = MODELS_JSON_EXAMPLE;
    clearInlineModelsError();
  });

  modelsConfigDocsLink?.addEventListener("click", (e) => {
    e.preventDefault();
    const url =
      "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md";
    const transport = getTransport();
    if (transport?.available) {
      transport
        .openExternal(url)
        .catch(() => showInlineModelsError(`${t("settings.models.docsOpenFailed")}: ${url}`));
    } else {
      showInlineModelsError(`${t("settings.models.docsOpenFailed")}: ${url}`);
    }
  });

  return {
    loadApiKeysPanel,
    loadInlineConfigEditor,
    loadInlineModelsEditor,
  };
}
