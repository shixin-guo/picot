import { t } from "../i18n/index.js";

export function setupSettingsEditors({
  rpcCommand,
  closeSettings,
  onModelConfigurationChanged,
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
}) {
  const apiKeysContainer = document.getElementById("settings-api-keys");
  const providerExpansionState = new Map();

  async function loadApiKeysPanel(options = {}) {
    if (!apiKeysContainer) return;
    rememberProviderExpansionState();
    const scrollContainer = options.preserveUi ? getSettingsScrollContainer() : null;
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    if (!options.preserveUi) {
      apiKeysContainer.innerHTML = `<div class="settings-api-keys-loading">${t("settings.config.loadingProviders")}</div>`;
    }
    const data = await rpcCommand({ type: "list_model_catalog" });
    if (!data?.success || !Array.isArray(data.data?.providers)) {
      renderApiKeysPanelError(data?.error || t("settings.config.failedProviders"));
      restoreScroll(scrollContainer, scrollTop);
      return;
    }
    renderApiKeysPanel(data.data.providers);
    restoreScroll(scrollContainer, scrollTop);
  }

  function rememberProviderExpansionState() {
    if (!apiKeysContainer) return;
    for (const row of apiKeysContainer.querySelectorAll(".api-key-row[data-provider]")) {
      const modelList = row.querySelector(".api-model-list");
      if (modelList) {
        providerExpansionState.set(
          row.dataset.provider,
          !modelList.classList.contains("collapsed"),
        );
      }
    }
  }

  function getSettingsScrollContainer() {
    return (
      apiKeysContainer?.closest?.(".settings-content") ||
      document.scrollingElement ||
      document.documentElement
    );
  }

  function restoreScroll(scrollContainer, scrollTop) {
    if (!scrollContainer) return;
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollTop;
    });
  }

  function renderApiKeysPanelError(message) {
    apiKeysContainer.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "settings-api-keys-empty";
    const msg = document.createElement("div");
    msg.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "config-editor-cancel";
    retry.textContent = t("common.retry");
    retry.style.marginTop = "8px";
    retry.addEventListener("click", () => loadApiKeysPanel());
    wrap.appendChild(msg);
    wrap.appendChild(retry);
    apiKeysContainer.appendChild(wrap);
  }

  function renderApiKeysPanel(providers) {
    apiKeysContainer.innerHTML = "";
    if (providers.length === 0) {
      apiKeysContainer.innerHTML = `<div class="settings-api-keys-empty">${t("settings.config.noProviders")}</div>`;
      return;
    }
    for (const p of [...providers].sort((a, b) => Number(b.configured) - Number(a.configured))) {
      apiKeysContainer.appendChild(buildApiKeyRow(p));
    }
  }

  function escapeSelectorValue(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }

  function getProviderModels(provider) {
    return Array.isArray(provider.models) ? provider.models : [];
  }

  function buildApiKeyRow(p) {
    const row = document.createElement("div");
    row.className = "api-key-row";
    row.dataset.provider = p.provider;

    const header = document.createElement("div");
    header.className = "api-key-row-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "api-provider-toggle";
    toggle.setAttribute("aria-label", `Toggle ${p.displayName || p.provider} models`);
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▼";

    const info = document.createElement("div");
    info.className = "api-key-row-info";
    const name = document.createElement("div");
    name.className = "api-key-row-name";
    name.textContent = p.displayName || p.provider;
    info.appendChild(name);

    const actions = document.createElement("div");
    actions.className = "api-key-row-actions";
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.textContent = p.configured
      ? t("settings.config.updateKey")
      : t("settings.config.setKey");
    setBtn.addEventListener("click", () => openApiKeyEditor(row, p));

    const models = getProviderModels(p);
    const hasConfiguredModels = p.configured && models.length > 0;
    if (hasConfiguredModels) {
      const checkHealthBtn = document.createElement("button");
      checkHealthBtn.type = "button";
      checkHealthBtn.className = "api-model-check-visible";
      checkHealthBtn.textContent = t("settings.config.checkHealth");
      checkHealthBtn.disabled = !models.some((model) => model.visible !== false && model.available);
      checkHealthBtn.addEventListener("click", () => checkModelHealth(p.provider));
      actions.appendChild(checkHealthBtn);
    }
    actions.appendChild(setBtn);
    if (p.configured && p.source === "stored") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = t("common.remove");
      removeBtn.addEventListener("click", () => removeApiKey(p));
      actions.appendChild(removeBtn);
    }

    const modelList = hasConfiguredModels ? buildModelList(p) : null;
    header.appendChild(toggle);
    header.appendChild(info);
    if (hasConfiguredModels) {
      const summary = document.createElement("div");
      summary.className = "api-key-row-summary";
      summary.textContent = describeProviderSummary(models);
      header.appendChild(summary);
    }
    header.appendChild(actions);
    row.appendChild(header);
    if (modelList) {
      const isExpanded = providerExpansionState.get(p.provider) ?? true;
      modelList.classList.toggle("collapsed", !isExpanded);
      toggle.setAttribute("aria-expanded", String(isExpanded));
      const toggleModelList = () => {
        modelList.classList.toggle("collapsed");
        const expanded = !modelList.classList.contains("collapsed");
        toggle.setAttribute("aria-expanded", String(expanded));
        providerExpansionState.set(p.provider, expanded);
      };
      header.addEventListener("click", (event) => {
        if (event.target.closest?.(".api-key-row-actions")) return;
        toggleModelList();
      });
      info.classList.add("api-provider-title-toggle");
      info.tabIndex = 0;
      info.setAttribute("role", "button");
      info.setAttribute("aria-label", `Toggle ${p.displayName || p.provider} models`);
      info.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleModelList();
        }
      });
      row.appendChild(modelList);
    } else {
      toggle.hidden = true;
    }
    return row;
  }

  function buildModelList(p) {
    const wrap = document.createElement("div");
    wrap.className = "api-model-list";

    const models = getProviderModels(p);
    if (models.length === 0) {
      return null;
    }

    const columnLabels = document.createElement("div");
    columnLabels.className = "api-model-list-heading";
    const statusColumn = document.createElement("span");
    const modelColumn = document.createElement("span");
    modelColumn.textContent = t("settings.config.model");

    const actions = document.createElement("div");
    actions.className = "api-model-list-heading-actions";
    const visibilityColumn = document.createElement("label");
    visibilityColumn.className = "api-model-select-all";
    const allModelsEnabled = models.every((model) => model.visible !== false);
    const visibilityToggle = document.createElement("input");
    visibilityToggle.type = "checkbox";
    visibilityToggle.className = "api-model-select-all-toggle";
    visibilityToggle.checked = allModelsEnabled;
    visibilityToggle.setAttribute(
      "aria-label",
      `${allModelsEnabled ? "Deselect" : "Select"} all ${p.displayName || p.provider} models`,
    );
    visibilityToggle.addEventListener("change", () =>
      setProviderModelsVisibility(p.provider, visibilityToggle.checked),
    );
    visibilityColumn.appendChild(visibilityToggle);
    columnLabels.append(statusColumn, modelColumn, actions, visibilityColumn);
    wrap.appendChild(columnLabels);

    for (const model of models) {
      wrap.appendChild(buildModelRow(model));
    }
    return wrap;
  }

  function getProviderModelRows(provider) {
    return [
      ...apiKeysContainer.querySelectorAll(
        `.api-model-row[data-provider="${escapeSelectorValue(provider)}"]`,
      ),
    ];
  }

  async function setProviderModelsVisibility(provider, visible) {
    const rows = getProviderModelRows(provider);
    const toggles = rows
      .map((row) => row.querySelector(".api-model-visibility-toggle"))
      .filter(Boolean);
    const modelsToUpdate = rows.filter(
      (row) => row.querySelector(".api-model-visibility-toggle")?.checked !== visible,
    );
    if (modelsToUpdate.length === 0) return;

    const providerRow = apiKeysContainer.querySelector(
      `.api-key-row[data-provider="${escapeSelectorValue(provider)}"]`,
    );
    const visibilityButton = providerRow?.querySelector(".api-model-select-all-toggle");
    if (visibilityButton) visibilityButton.disabled = true;
    for (const toggle of toggles) toggle.disabled = true;
    for (const row of modelsToUpdate) {
      const resp = await rpcCommand({
        type: "set_model_visibility",
        provider,
        modelId: row.dataset.modelId,
        visible,
      });
      if (!resp?.success) {
        if (visibilityButton) visibilityButton.disabled = false;
        for (const toggle of toggles) toggle.disabled = false;
        return;
      }
    }
    await onModelConfigurationChanged?.();
    await loadApiKeysPanel({ preserveUi: true });
  }

  function buildModelRow(model) {
    const row = document.createElement("div");
    row.className = "api-model-row";
    row.dataset.provider = model.provider;
    row.dataset.modelId = model.id;
    row.dataset.available = String(model.available);

    const health = model.health || { status: "unknown" };
    const healthDot = document.createElement("span");
    healthDot.className = `api-model-health-dot ${health.status || "unknown"}`;
    healthDot.title = describeModelHealth(health);

    const label = document.createElement("div");
    label.className = "api-model-label";
    const name = document.createElement("div");
    name.className = "api-model-name";
    name.textContent = model.name || model.id;
    const meta = document.createElement("div");
    meta.className = "api-model-health-status";
    meta.textContent = describeModelStatus(model);
    label.appendChild(name);
    label.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "api-model-actions";

    const visibilityLabel = document.createElement("label");
    visibilityLabel.className = "api-model-visibility";
    const visibility = document.createElement("input");
    visibility.type = "checkbox";
    visibility.className = "api-model-visibility-toggle";
    visibility.setAttribute("aria-label", `Enable ${model.name || model.id}`);
    visibility.checked = model.visible !== false;
    visibility.addEventListener("change", async () => {
      visibility.disabled = true;
      const resp = await rpcCommand({
        type: "set_model_visibility",
        provider: model.provider,
        modelId: model.id,
        visible: visibility.checked,
      });
      if (resp?.success) {
        await onModelConfigurationChanged?.();
        await loadApiKeysPanel({ preserveUi: true });
      } else {
        visibility.checked = !visibility.checked;
        visibility.disabled = false;
      }
    });
    visibilityLabel.appendChild(visibility);

    actions.appendChild(visibilityLabel);

    row.appendChild(healthDot);
    row.appendChild(label);
    row.appendChild(actions);
    return row;
  }

  function describeModelStatus(model) {
    const parts = [];
    if (!model.available) parts.push(t("settings.config.noKeyAvailable"));
    parts.push(describeModelHealth(model.health || { status: "unknown" }));
    return parts.join(" · ");
  }

  function describeProviderSummary(models) {
    const enabled = models.filter((model) => model.visible !== false).length;
    const healthy = models.filter((model) => model.health?.status === "healthy").length;
    const issues = models.filter((model) => model.health?.status === "unhealthy").length;
    return t("settings.config.summary", { enabled, healthy, issues });
  }

  function describeModelHealth(health) {
    if (!health || health.status === "unknown") return t("settings.config.healthUnknown");
    if (health.status === "healthy") {
      return health.latencyMs
        ? t("settings.config.healthyMs", { ms: health.latencyMs })
        : t("settings.config.healthy");
    }
    return health.error
      ? t("settings.config.failedWithError", { error: health.error })
      : t("settings.config.failed");
  }

  function setModelRowChecking(row) {
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    if (dot) {
      dot.className = "api-model-health-dot checking";
      dot.title = t("settings.config.checkingHealthTitle");
    }
    if (status) status.textContent = t("settings.config.checkingHealth");
  }

  function setModelRowHealthError(row, message) {
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    const text = t("settings.config.failedWithError", {
      error: message || t("settings.config.healthCheckFailed"),
    });
    if (dot) {
      dot.className = "api-model-health-dot unknown";
      dot.title = text;
    }
    if (status) status.textContent = text;
  }

  function applyHealthResult(result) {
    const row = apiKeysContainer.querySelector(
      `.api-model-row[data-provider="${escapeSelectorValue(result.provider)}"][data-model-id="${escapeSelectorValue(result.modelId)}"]`,
    );
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    const health = {
      status: result.status,
      latencyMs: result.latencyMs,
      error: result.error,
    };
    if (dot) {
      dot.className = `api-model-health-dot ${result.status || "unknown"}`;
      dot.title = describeModelHealth(health);
    }
    if (status) status.textContent = describeModelHealth(health);
  }

  async function checkModelHealth(provider) {
    for (const modelRow of getProviderModelRows(provider)) {
      const toggle = modelRow.querySelector(".api-model-visibility-toggle");
      if (toggle?.checked && modelRow.dataset.available !== "false") setModelRowChecking(modelRow);
    }
    const resp = await rpcCommand({
      type: "check_model_health",
      provider,
    });
    if (resp?.success && Array.isArray(resp.data?.results)) {
      for (const result of resp.data.results) applyHealthResult(result);
    } else {
      const message = resp?.error || t("settings.config.healthCheckFailed");
      for (const modelRow of getProviderModelRows(provider)) {
        const toggle = modelRow.querySelector(".api-model-visibility-toggle");
        if (toggle?.checked && modelRow.dataset.available !== "false") {
          setModelRowHealthError(modelRow, message);
        }
      }
    }
  }

  function openApiKeyEditor(row, p) {
    const editor = document.createElement("div");
    editor.className = "api-key-editor";

    const title = document.createElement("div");
    title.className = "api-key-row-name";
    title.textContent = t("settings.config.apiKeyTitle", {
      name: p.displayName || p.provider,
    });
    editor.appendChild(title);

    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = t("settings.config.pasteApiKey");
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
    cancelBtn.textContent = t("common.cancel");
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary";
    saveBtn.textContent = t("common.save");
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
        err.textContent = t("settings.config.keyEmpty");
        err.style.display = "";
        return;
      }
      saveBtn.disabled = true;
      const resp = await rpcCommand(
        { type: "set_api_key", provider: p.provider, apiKey: key },
        `Saving ${p.provider} key...`,
      );
      if (resp?.success) {
        await onModelConfigurationChanged?.();
        loadApiKeysPanel();
      } else {
        err.textContent = resp?.error || t("settings.config.failedSaveKey");
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
      t("settings.config.removeKeyConfirm", { name: p.displayName || p.provider }),
    );
    if (!ok) return;
    const resp = await rpcCommand(
      { type: "remove_api_key", provider: p.provider },
      `Removing ${p.provider} key...`,
    );
    if (resp?.success) {
      await onModelConfigurationChanged?.();
      loadApiKeysPanel();
    }
  }

  const btnOpenConfig = document.getElementById("btn-open-config");
  const inlineConfigPath = document.getElementById("inline-config-path");
  const inlineConfigTextarea = document.getElementById("inline-config-textarea");
  const inlineConfigError = document.getElementById("inline-config-error");
  const inlineConfigSave = document.getElementById("inline-config-save");
  const configEditorOverlay = document.getElementById("config-editor-overlay");
  const configEditorModal = document.getElementById("config-editor-modal");
  const configEditorClose = document.getElementById("config-editor-close");
  const configEditorCancel = document.getElementById("config-editor-cancel");
  const configEditorSave = document.getElementById("config-editor-save");
  const configEditorTextarea = document.getElementById("config-editor-textarea");
  const configEditorError = document.getElementById("config-editor-error");
  const configEditorPath = document.getElementById("config-editor-path");

  function openConfigEditor() {
    configEditorError.classList.add("hidden");
    configEditorTextarea.value = "";
    configEditorPath.textContent = "";
    configEditorModal.classList.remove("hidden");
    configEditorOverlay.classList.remove("hidden");

    fetch("/api/agent-config")
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          try {
            configEditorTextarea.value = JSON.stringify(JSON.parse(data.content), null, 2);
          } catch {
            configEditorTextarea.value = data.content;
          }
          configEditorPath.textContent = data.path || "";
        } else {
          showConfigError(data.error || t("settings.config.failedLoadConfig"));
        }
      })
      .catch((e) => showConfigError(e.message));
  }

  function closeConfigEditor() {
    configEditorModal.classList.add("hidden");
    configEditorOverlay.classList.add("hidden");
  }

  function showConfigError(msg) {
    configEditorError.textContent = msg;
    configEditorError.classList.remove("hidden");
  }

  async function loadInlineConfigEditor() {
    if (!inlineConfigTextarea) return;
    inlineConfigError?.classList.add("hidden");
    inlineConfigTextarea.value = "";
    if (inlineConfigPath) inlineConfigPath.textContent = t("common.loading");
    try {
      const resp = await fetch("/api/agent-config");
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || t("settings.config.failedLoadConfig"));
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

  btnOpenConfig?.addEventListener("click", () => {
    closeSettings();
    openConfigEditor();
  });

  inlineConfigSave?.addEventListener("click", async () => {
    if (!inlineConfigTextarea) return;
    clearSettingsSaveMessage(inlineConfigError);
    const content = inlineConfigTextarea.value;
    try {
      JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(
        inlineConfigError,
        t("settings.config.invalidJson", { message: e.message }),
      );
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
      if (!data.success) throw new Error(data.error || t("settings.config.failedSaveConfig"));
      showSettingsSaveSuccess(inlineConfigError);
    } catch (e) {
      showSettingsSaveError(inlineConfigError, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(inlineConfigSave, false);
    }
  });

  configEditorClose.addEventListener("click", closeConfigEditor);
  configEditorCancel.addEventListener("click", closeConfigEditor);
  configEditorOverlay.addEventListener("click", closeConfigEditor);

  configEditorSave.addEventListener("click", async () => {
    configEditorError.classList.add("hidden");
    const content = configEditorTextarea.value;
    try {
      JSON.parse(content);
    } catch (e) {
      showConfigError(t("settings.config.invalidJson", { message: e.message }));
      return;
    }
    configEditorSave.disabled = true;
    try {
      const resp = await fetch("/api/agent-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await resp.json();
      if (data.success) {
        closeConfigEditor();
      } else {
        showConfigError(data.error || t("settings.config.failedSaveConfig"));
      }
    } catch (e) {
      showConfigError(e.message);
    } finally {
      configEditorSave.disabled = false;
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
    if (inlineModelsPath) inlineModelsPath.textContent = t("common.loading");
    try {
      const resp = await fetch("/api/models-config");
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || t("settings.config.failedLoadModels"));
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
      showInlineModelsError(t("settings.config.invalidJson", { message: e.message }));
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showInlineModelsError(t("settings.config.modelsMustObject"));
      return;
    }
    if (
      "providers" in parsed &&
      (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
    ) {
      showInlineModelsError(t("settings.config.providersMustObject"));
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
      if (!data.success) throw new Error(data.error || t("settings.config.failedSaveModels"));
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
      if (!confirm(t("settings.config.replaceExample"))) return;
    }
    inlineModelsTextarea.value = MODELS_JSON_EXAMPLE;
    clearInlineModelsError();
  });

  modelsConfigDocsLink?.addEventListener("click", (e) => {
    e.preventDefault();
    const url =
      "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md";
    fetch("/api/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: url }),
    })
      .then((r) => {
        if (!r.ok) throw new Error("open failed");
      })
      .catch(() => {
        window.open(url, "_blank", "noopener,noreferrer");
      });
  });

  return {
    loadApiKeysPanel,
    loadInlineConfigEditor,
    loadInlineModelsEditor,
  };
}
