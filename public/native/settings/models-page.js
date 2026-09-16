// Settings → Configuration tab: API keys / model catalog panel plus the inline
// agent-config and models.json editors. Ported from the legacy
// public/settings/editors.js, with the transport swapped from the old HTTP
// `rpcCommand` / `fetch("/api/...")` calls to the native ConfigGateway (which
// routes through the picot-bridge `/picot-config` command). All model-registry
// access still happens inside pi via the bridge — this module only renders.

import { onLocaleChange, t } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";
import { createModelsOAuthLoginDialog } from "./models-oauth-login.js";
import { openCustomProviderEditor } from "./settings-custom-provider.js";
import {
  clearSettingsSaveMessage,
  setSettingsSaveButtonSaving,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./settings-save-status.js";

const HEALTH_CHECK_TIMEOUT_MS = 120_000;
const MODELS_DOCS_URL =
  "https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/models.md";
const PROVIDER_ICON_ALIASES = {
  "amazon-bedrock": "aws",
  "azure-openai-responses": "azure",
  "github-copilot": "github-copilot",
  "google-vertex": "google",
  "ant-ling": "ant-group",
  "cloudflare-ai-gateway": "cloudflare",
  "cloudflare-workers-ai": "cloudflare",
  deepseek: "deep-seek",
  fireworks: "fireworks",
  huggingface: "hugging-face",
  openrouter: "open-router",
  opencode: "open-code",
  "opencode-go": "open-code",
  xai: "x-a-i",
  "vercel-ai-gateway": "vercel",
  "minimax-cn": "minimax",
  moonshotai: "moonshot",
  "moonshotai-cn": "moonshot",
  "xiaomi-token-plan-ams": "xiaomi-mi-mo",
  "xiaomi-token-plan-cn": "xiaomi-mi-mo",
  "xiaomi-token-plan-sgp": "xiaomi-mi-mo",
};
function providerIcon(provider, className = "provider-logo") {
  const key = PROVIDER_ICON_ALIASES[provider] || provider;
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.src = `/icons/providers/${key}.svg`;
  img.onerror = () => {
    img.replaceWith(
      Object.assign(document.createElement("span"), {
        className,
        textContent: provider.slice(0, 1).toUpperCase(),
      }),
    );
  };
  return img;
}

export function setupModelsPage({ configGateway, oauthGateway, onModelConfigurationChanged }) {
  const call = (op, params, options) => configGateway.call(op, params, options);
  const oauthCall = (op, params, options) =>
    oauthGateway
      ? oauthGateway.command({ type: op, ...params }, options)
      : Promise.reject(new Error("oauth unavailable"));
  const apiKeysContainer = document.getElementById("settings-api-keys");
  const providerExpansionState = new Map();
  let catalogProviders = [];

  async function loadApiKeysPanel(options = {}) {
    if (!apiKeysContainer) return;
    rememberProviderExpansionState();
    const scrollContainer = options.preserveUi ? getSettingsScrollContainer() : null;
    const scrollTop = scrollContainer?.scrollTop ?? 0;
    if (!options.preserveUi) {
      const loading = document.createElement("div");
      loading.className = "settings-api-keys-loading";
      loading.textContent = t("settings.loadingProviders");
      apiKeysContainer.replaceChildren(loading);
    }
    let data;
    try {
      data = await call("list_model_catalog");
    } catch (error) {
      renderApiKeysPanelError(error?.message || t("settings.apiKeys.loadFailed"));
      restoreScroll(scrollContainer, scrollTop);
      return;
    }
    if (!data?.ok || !Array.isArray(data.data?.providers)) {
      renderApiKeysPanelError(data?.error || t("settings.apiKeys.loadFailed"));
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
    apiKeysContainer.replaceChildren();
    const wrap = document.createElement("div");
    wrap.className = "settings-api-keys-empty";
    const msg = document.createElement("div");
    msg.textContent = message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "ui-button ui-button--secondary config-editor-cancel";
    retry.textContent = t("actions.retry");
    retry.style.marginTop = "var(--space-2)";
    retry.addEventListener("click", () => loadApiKeysPanel());
    wrap.appendChild(msg);
    wrap.appendChild(retry);
    apiKeysContainer.appendChild(wrap);
  }

  function isCodexProvider(provider) {
    return provider?.provider === "openai-codex";
  }

  /** Connected-state card for the OAuth-managed Codex provider. */
  function buildCodexConnectedCard() {
    const card = document.createElement("div");
    card.className = "provider-manager-card oauth-connected-card";
    const title = document.createElement("div");
    title.className = "api-key-row-name";
    title.textContent = t("settings.models.oauth.connected");
    const logoutBtn = document.createElement("button");
    logoutBtn.type = "button";
    logoutBtn.className = "ui-button ui-button--secondary";
    logoutBtn.textContent = t("settings.models.oauth.logout");
    logoutBtn.addEventListener("click", () => void logoutCodex());
    card.append(title, logoutBtn);
    return card;
  }

  function renderApiKeysPanel(providers) {
    catalogProviders = providers;
    if (inlineModelsTextarea) {
      if (!inlineModelsTextarea.value.trim()) {
        inlineModelsTextarea.value = '{\n  "providers": {}\n}';
      }
      renderModelsConfigLayout();
      return;
    }

    apiKeysContainer.replaceChildren();
    // Codex is OAuth-managed: its configured card is rendered separately as a
    // connected state with a logout action, never as an API-key row.
    const configured = providers.filter(
      (provider) => provider.configured && !isCodexProvider(provider),
    );
    for (const provider of configured.sort((a, b) =>
      (a.displayName || a.provider).localeCompare(b.displayName || b.provider),
    )) {
      apiKeysContainer.appendChild(buildApiKeyRow(provider));
    }
    if (codexOAuthCapability?.configured) {
      apiKeysContainer.appendChild(buildCodexConnectedCard());
    }
  }

  // Codex OAuth capability from the read-only surface; null until queried.
  // Never inferred from the API-key catalog (baseline protocol rule).
  let codexOAuthCapability = null;
  let oauthDialog = null;

  async function loadOAuthCapability() {
    if (!oauthGateway) return;
    try {
      const resp = await oauthCall("get_oauth_login_capabilities");
      const providers =
        resp?.success && Array.isArray(resp.data?.providers) ? resp.data.providers : [];
      codexOAuthCapability = providers.find((p) => p.providerId === "openai-codex") ?? null;
    } catch {
      codexOAuthCapability = null;
    }
    // The panel may have rendered before this resolve (loadModels fires the
    // capability probe alongside loadApiKeysPanel): re-render with the
    // fresh capability so the Codex connected card / login entry appears.
    if (apiKeysContainer?.isConnected && catalogProviders.length > 0) {
      renderApiKeysPanel(catalogProviders);
    }
  }

  function startOAuthLogin() {
    oauthDialog?.destroy();
    oauthDialog = createModelsOAuthLoginDialog({
      command: (frame) => oauthCall(frame.type, frame),
      subscribe: (handler) => oauthGateway.subscribe(handler),
      openExternal: (url) => {
        // System-browser handoff only: no WebView window.open fallback for a
        // Pi-provided URL (open-redirect surface stays closed).
        call("open_external", { url }).catch((error) => {
          console.warn("[models-page] open_external failed:", error);
        });
      },
      copyText: (text) => {
        void navigator.clipboard?.writeText(text);
      },
      onSuccess: async () => {
        await onModelConfigurationChanged?.();
        await loadApiKeysPanel();
        // Re-query the capability surface so the card flips to the connected
        // state with a fresh configured flag.
        await loadOAuthCapability();
        await loadInlineModelsEditor();
      },
      onTerminal: () => {},
    });
    void oauthDialog.start().catch((error) => {
      console.warn("[models-page] OAuth login failed to start:", error);
    });
  }

  async function logoutCodex() {
    const ok = confirm(t("settings.models.oauth.logoutConfirm", { provider: "OpenAI Codex" }));
    if (!ok) return;
    const resp = await call("oauth_logout", { provider: "openai-codex" }).catch(() => null);
    if (resp?.ok) {
      await onModelConfigurationChanged?.();
      await loadApiKeysPanel();
      // Re-query the capability surface so the card flips back to the
      // sign-in entry once Pi confirms the credential is gone.
      await loadOAuthCapability();
    }
  }

  function openProviderPicker(providers) {
    const backdrop = document.createElement("div");
    backdrop.className = "ui-overlay provider-picker-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog provider-picker-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "provider-picker-title");
    const head = document.createElement("div");
    head.className = "provider-picker-head";
    head.innerHTML = `<div><h2 id="provider-picker-title">Add provider</h2><p>Connect a provider to start using its models.</p></div>`;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ui-icon-button ui-icon-button--ghost provider-picker-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    head.appendChild(close);
    const search = document.createElement("input");
    search.className = "ui-input provider-picker-search";
    search.placeholder = "Search providers…";
    const toolbar = document.createElement("div");
    toolbar.className = "provider-picker-toolbar";
    toolbar.append(head, search);
    const body = document.createElement("div");
    body.className = "provider-picker-body";
    dialog.append(toolbar, body);

    const pickerSubtitle = (section, p) => {
      if (section === "custom") return "Custom endpoint";
      if (section === "subscriptions") return "OAuth";
      const count = Array.isArray(p.models) ? p.models.length : 0;
      if (count <= 0) return "";
      return count === 1 ? "1 model" : `${count} models`;
    };

    const appendPickerCard = (parent, p, section) => {
      const card = document.createElement("button");
      card.className = "provider-picker-card";
      card.type = "button";
      card.dataset.section = section;
      const logo = providerIcon(p.provider);
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = p.displayName || p.provider;
      text.append(strong);
      const subtitle = pickerSubtitle(section, p);
      if (subtitle) {
        const small = document.createElement("small");
        small.textContent = subtitle;
        text.append(small);
      }
      card.append(logo, text);
      card.addEventListener("click", () => {
        backdrop.remove();
        if (p.custom) {
          openCustomProviderEditor({
            call,
            setupDialog,
            onSaved: async (providerId) => {
              if (providerId) {
                selectedModelsConfigItem = { type: "provider", provider: providerId };
              }
              await loadInlineModelsEditor();
              await loadApiKeysPanel();
            },
          });
          return;
        }
        if (section === "subscriptions") {
          openSubscriptionSetup(p);
          return;
        }
        let row = apiKeysContainer.querySelector(
          `[data-provider="${escapeSelectorValue(p.provider)}"]`,
        );
        if (!row) {
          row = buildApiKeyRow(p);
          const detail = apiKeysContainer.querySelector(".models-config-main");
          detail?.replaceChildren(row);
        }
        openApiKeyEditor(row, p);
      });
      parent.appendChild(card);
    };

    const appendPickerSection = (label, section, items) => {
      if (!items.length) return;
      const group = document.createElement("section");
      group.className = "provider-picker-section";
      const heading = document.createElement("h3");
      heading.className = "provider-picker-section-title";
      heading.dataset.section = section;
      heading.textContent = label;
      const wrap = document.createElement("div");
      wrap.className = "provider-picker-grid";
      for (const p of items) {
        appendPickerCard(wrap, p, section);
      }
      group.append(heading, wrap);
      body.appendChild(group);
    };

    const render = () => {
      body.replaceChildren();
      const q = search.value.toLowerCase();
      const matches = providers.filter((p) =>
        (p.displayName || p.provider).toLowerCase().includes(q),
      );
      const custom = {
        provider: "custom",
        displayName: "OpenAI / Anthropic compatible",
        custom: true,
      };
      const customItems =
        !q || "custom openai-compatible anthropic-compatible".includes(q)
          ? [custom]
          : matches.filter((p) => p.custom || p.provider === "custom");
      const subscriptionItems = matches.filter(
        (p) =>
          !p.custom &&
          (p.authType === "oauth" ||
            p.source === "oauth" ||
            p.source === "subscription" ||
            (isCodexProvider(p) && Boolean(oauthGateway))),
      );
      const featuredItems = [
        ...customItems.map((p) => ({ p, section: "custom" })),
        ...subscriptionItems.map((p) => ({ p, section: "subscriptions" })),
      ];
      if (featuredItems.length) {
        const group = document.createElement("section");
        group.className = "provider-picker-section";
        group.setAttribute("aria-label", "Custom and subscriptions");
        const wrap = document.createElement("div");
        wrap.className = "provider-picker-featured";
        wrap.dataset.section = "featured";
        for (const { p, section } of featuredItems) {
          appendPickerCard(wrap, p, section);
        }
        group.appendChild(wrap);
        body.appendChild(group);
      }
      appendPickerSection(
        "API key",
        "apiKey",
        matches.filter(
          (p) =>
            !p.custom &&
            !(isCodexProvider(p) && Boolean(oauthGateway)) &&
            p.authType !== "oauth" &&
            p.source !== "oauth" &&
            p.source !== "subscription",
        ),
      );
    };
    search.addEventListener("input", render);
    close.addEventListener("click", () => backdrop.remove());
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) backdrop.remove();
    });
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    dismissOnEscape(backdrop);
    render();
    search.focus();
  }

  function setupDialog(title, subtitle) {
    const backdrop = document.createElement("div");
    backdrop.className = "ui-overlay provider-picker-backdrop";
    const dialog = document.createElement("div");
    dialog.className = "ui-dialog provider-setup-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const head = document.createElement("div");
    head.className = "provider-picker-head";
    const heading = document.createElement("h2");
    heading.textContent = title;
    const caption = document.createElement("p");
    caption.textContent = subtitle;
    const titleWrap = document.createElement("div");
    titleWrap.append(heading, caption);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "ui-icon-button ui-icon-button--ghost provider-picker-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.onclick = () => backdrop.remove();
    head.append(titleWrap, close);
    dialog.appendChild(head);
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    dismissOnEscape(backdrop);
    return { backdrop, dialog };
  }

  function dismissOnEscape(backdrop) {
    const unbind = bindDialogEscape(() => backdrop.remove(), {
      isActive: () => backdrop.isConnected && !backdrop.classList.contains("hidden"),
    });
    const nativeRemove = backdrop.remove.bind(backdrop);
    backdrop.remove = () => {
      unbind();
      nativeRemove();
    };
  }

  function openSubscriptionSetup(p) {
    const isCodex = oauthGateway && isCodexProvider(p);
    if (isCodex) {
      if (codexOAuthCapability?.configured) {
        void logoutCodex();
        return;
      }
      // Do not wait for the capability probe: a pending/failed probe used to
      // close the picker and then sit idle, which looks like a dead click.
      startOAuthLogin();
      return;
    }
    showTerminalLoginDialog(p);
  }

  /** Fallback instructions for subscriptions without an in-app device flow. */
  function showTerminalLoginDialog(p) {
    const { backdrop, dialog } = setupDialog(
      `Connect ${p.displayName || p.provider}`,
      "This provider uses your subscription account.",
    );
    const note = document.createElement("div");
    note.className = "provider-setup-note";
    note.textContent =
      "OAuth login is run by the pi agent. Start the login flow from a terminal, then return here to refresh the provider status.";
    dialog.appendChild(note);
    const command = document.createElement("code");
    command.className = "provider-login-command";
    command.textContent = `pi /login ${p.provider}`;
    dialog.appendChild(command);
    const actions = document.createElement("div");
    actions.className = "provider-setup-actions";
    const close = document.createElement("button");
    close.className = "ui-button ui-button--secondary";
    close.textContent = "Close";
    close.onclick = () => backdrop.remove();
    actions.appendChild(close);
    dialog.appendChild(actions);
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
    toggle.setAttribute(
      "aria-label",
      t("settings.apiKeys.toggleModels", { provider: p.displayName || p.provider }),
    );
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
    setBtn.textContent = p.configured ? t("actions.update") : t("actions.setKey");
    setBtn.addEventListener("click", () => openApiKeyEditor(row, p));

    const models = getProviderModels(p);
    const hasConfiguredModels = p.configured && models.length > 0;
    if (hasConfiguredModels) {
      const checkHealthBtn = document.createElement("button");
      checkHealthBtn.type = "button";
      checkHealthBtn.className = "api-model-check-visible";
      checkHealthBtn.textContent = t("settings.apiKeys.checkHealth");
      checkHealthBtn.disabled = !models.some((model) => model.visible !== false && model.available);
      checkHealthBtn.addEventListener("click", () => checkModelHealth(p.provider));
      actions.appendChild(checkHealthBtn);
    }
    actions.appendChild(setBtn);
    if (p.configured && p.source === "stored") {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = t("actions.remove");
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
      info.setAttribute(
        "aria-label",
        t("settings.apiKeys.toggleModels", { provider: p.displayName || p.provider }),
      );
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
    if (models.length === 0) return null;

    const columnLabels = document.createElement("div");
    columnLabels.className = "api-model-list-heading";
    const statusColumn = document.createElement("span");
    const modelColumn = document.createElement("span");
    modelColumn.textContent = t("settings.apiKeys.model");

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
      t(allModelsEnabled ? "settings.apiKeys.deselectAll" : "settings.apiKeys.selectAll", {
        provider: p.displayName || p.provider,
      }),
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
      const resp = await call("set_model_visibility", {
        provider,
        modelId: row.dataset.modelId,
        visible,
      }).catch(() => null);
      if (!resp?.ok) {
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
    healthDot.className = `api-model-health-dot ${healthDotClass(health)}`;
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
    visibility.setAttribute(
      "aria-label",
      t("settings.apiKeys.enableModel", { model: model.name || model.id }),
    );
    visibility.checked = model.visible !== false;
    visibility.addEventListener("change", async () => {
      visibility.disabled = true;
      const resp = await call("set_model_visibility", {
        provider: model.provider,
        modelId: model.id,
        visible: visibility.checked,
      }).catch(() => null);
      if (resp?.ok) {
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
    if (!model.available) parts.push(t("settings.apiKeys.noKeyAvailable"));
    parts.push(describeModelHealth(model.health || { status: "unknown" }));
    return parts.join(" · ");
  }

  function describeProviderSummary(models) {
    const enabled = models.filter((model) => model.visible !== false).length;
    const healthy = models.filter((model) => model.health?.status === "healthy").length;
    const issues = models.filter((model) => model.health?.status === "unhealthy").length;
    return t("settings.apiKeys.summary", { enabled, healthy, issues });
  }

  function describeModelHealth(health) {
    if (!health || health.status === "unknown") return t("settings.apiKeys.healthUnknown");
    if (health.status === "healthy") {
      return health.latencyMs
        ? t("settings.apiKeys.healthyLatency", { latency: health.latencyMs })
        : t("settings.apiKeys.healthy");
    }
    return health.error
      ? t("settings.apiKeys.failedWithMessage", { message: health.error })
      : t("settings.apiKeys.failed");
  }

  // Healthy responses still vary a lot in latency; a flat green dot hides
  // that. Split into three visual tiers so slow-but-working models stand out
  // from both fast ones and actual failures.
  function healthDotClass(health) {
    if (!health?.status || health.status === "unknown" || health.status === "checking") {
      return health?.status || "unknown";
    }
    if (health.status !== "healthy") return "unhealthy";
    if (typeof health.latencyMs !== "number") return "healthy";
    if (health.latencyMs < 1500) return "healthy";
    if (health.latencyMs < 3000) return "healthy-slow";
    return "healthy-veryslow";
  }

  function setModelRowChecking(row) {
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    if (dot) {
      dot.className = "api-model-health-dot checking";
      dot.title = t("settings.apiKeys.checkingHealth");
    }
    if (status) status.textContent = t("settings.apiKeys.checkingHealthEllipsis");
  }

  function setModelRowHealthError(row, message) {
    if (!row) return;
    const dot = row.querySelector(".api-model-health-dot");
    const status = row.querySelector(".api-model-health-status");
    const text = t("settings.apiKeys.failedWithMessage", {
      message: message || t("settings.apiKeys.healthCheckFailed"),
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
    const health = { status: result.status, latencyMs: result.latencyMs, error: result.error };
    if (dot) {
      dot.className = `api-model-health-dot ${healthDotClass(health)}`;
      dot.title = describeModelHealth(health);
    }
    if (status) status.textContent = describeModelHealth(health);
  }

  async function checkModelHealth(provider) {
    for (const modelRow of getProviderModelRows(provider)) {
      const toggle = modelRow.querySelector(".api-model-visibility-toggle");
      if (toggle?.checked && modelRow.dataset.available !== "false") setModelRowChecking(modelRow);
    }
    const resp = await call(
      "check_model_health",
      { provider },
      { timeoutMs: HEALTH_CHECK_TIMEOUT_MS },
    ).catch((error) => ({ ok: false, error: error?.message }));
    if (resp?.ok && Array.isArray(resp.data?.results)) {
      for (const result of resp.data.results) applyHealthResult(result);
    } else {
      const message = resp?.error || t("settings.apiKeys.healthCheckFailed");
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
    cancelBtn.className = "ui-button ui-button--secondary config-editor-cancel";
    cancelBtn.textContent = t("actions.cancel");
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "ui-button ui-button--primary";
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
        err.textContent = t("settings.apiKeys.keyCannotBeEmpty");
        err.style.display = "";
        return;
      }
      saveBtn.disabled = true;
      try {
        const resp = await call("set_api_key", { provider: p.provider, apiKey: key }).catch(
          (error) => ({
            ok: false,
            error: error?.message,
          }),
        );
        if (resp?.ok) {
          await onModelConfigurationChanged?.();
          await loadApiKeysPanel();
        } else {
          err.textContent = resp?.error || t("settings.apiKeys.saveFailed");
          err.style.display = "";
          saveBtn.disabled = false;
        }
      } catch (error) {
        err.textContent = error?.message || t("settings.apiKeys.saveFailed");
        err.style.display = "";
        saveBtn.disabled = false;
      }
    };
    saveBtn.addEventListener("click", () => {
      save();
    });
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
    const resp = await call("remove_api_key", { provider: p.provider }).catch(() => null);
    if (resp?.ok) {
      await onModelConfigurationChanged?.();
      loadApiKeysPanel();
    }
  }

  const inlineModelsPath = document.getElementById("inline-models-path");
  const inlineModelsTextarea = document.getElementById("inline-models-textarea");
  const inlineModelsError = document.getElementById("inline-models-error");
  const inlineModelsSave = document.getElementById("inline-models-save");
  const inlineModelsInsertExample = document.getElementById("inline-models-insert-example");
  const modelsConfigDocsLink = document.getElementById("models-config-docs-link");
  let selectedModelsConfigItem = null;
  let newModelDraft = null;

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
    if (!inlineModelsTextarea.value.trim()) {
      inlineModelsTextarea.value = '{\n  "providers": {}\n}';
    }
    renderModelsConfigLayout();
    if (inlineModelsPath)
      inlineModelsPath.textContent = t(
        "migrated.native.settings.settingsConfig.textcontent.loading",
      );
    try {
      const data = await call("read_models_config");
      if (!data?.ok) throw new Error(data?.error || "Failed to load models.json");
      try {
        inlineModelsTextarea.value = JSON.stringify(JSON.parse(data.data.content), null, 2);
      } catch {
        inlineModelsTextarea.value = data.data.content;
      }
      renderModelsConfigLayout();
      if (inlineModelsPath) inlineModelsPath.textContent = data.data.path || "";
    } catch (e) {
      if (inlineModelsPath) inlineModelsPath.textContent = "";
      showInlineModelsError(e.message || String(e));
    }
  }

  function renderModelsConfigLayout() {
    if (!inlineModelsTextarea) return;
    let parsed;
    try {
      parsed = JSON.parse(inlineModelsTextarea.value);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    if (
      !parsed.providers ||
      typeof parsed.providers !== "object" ||
      Array.isArray(parsed.providers)
    ) {
      parsed.providers = {};
    }
    const providers = parsed.providers;
    const providerNames = Object.keys(providers);
    const configuredProviders = catalogProviders
      .filter((provider) => provider.configured)
      .sort((a, b) => (a.displayName || a.provider).localeCompare(b.displayName || b.provider));
    if (
      !selectedModelsConfigItem ||
      (selectedModelsConfigItem.type === "auth" &&
        (providerNames.includes(selectedModelsConfigItem.provider) ||
          !configuredProviders.some(
            (provider) => provider.provider === selectedModelsConfigItem.provider,
          ))) ||
      (selectedModelsConfigItem.type !== "auth" && !providers[selectedModelsConfigItem.provider]) ||
      (selectedModelsConfigItem.type === "model" &&
        !providers[selectedModelsConfigItem.provider].models?.[selectedModelsConfigItem.index]) ||
      (selectedModelsConfigItem.type === "model-new" &&
        selectedModelsConfigItem.provider !== newModelDraft?.provider)
    ) {
      newModelDraft = null;
      const defaultAuthProvider = configuredProviders.find(
        (provider) => !providerNames.includes(provider.provider),
      );
      selectedModelsConfigItem = defaultAuthProvider
        ? { type: "auth", provider: defaultAuthProvider.provider }
        : providerNames[0]
          ? { type: "provider", provider: providerNames[0] }
          : null;
    }

    let layout = document.getElementById("models-config-layout");
    if (!layout) {
      layout = document.createElement("div");
      layout.id = "models-config-layout";
      layout.className = "models-config-layout";
      apiKeysContainer.replaceChildren(layout);

      const openSource = document.createElement("button");
      openSource.type = "button";
      openSource.className = "ui-button ui-button--secondary models-config-source-button";
      openSource.textContent = "Advanced JSON editor";

      const sourceDialog = document.createElement("div");
      sourceDialog.className = "models-json-dialog-backdrop hidden";
      const dialog = document.createElement("section");
      dialog.className = "models-json-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-labelledby", "models-json-dialog-title");
      const header = document.createElement("header");
      header.className = "models-json-dialog-header";
      const heading = document.createElement("div");
      const title = document.createElement("h2");
      title.id = "models-json-dialog-title";
      title.textContent = "Advanced JSON editor";
      heading.append(title, inlineModelsPath);
      const close = document.createElement("button");
      close.type = "button";
      close.className = "ui-icon-button ui-icon-button--ghost";
      close.setAttribute("aria-label", "Close advanced JSON editor");
      close.textContent = "×";
      header.append(heading, close);
      dialog.append(header, inlineModelsTextarea);

      const footer = document.createElement("div");
      footer.className = "models-config-footer";
      const sourceSection = inlineModelsSave?.closest(".settings-section");
      const actions = inlineModelsSave?.closest(".settings-config-actions");
      footer.appendChild(openSource);

      // The visual form mutates the config in place but never persists on its
      // own; without this the only Save button lives inside the closed JSON
      // dialog, so field edits silently never reach models.json.
      const toolbarStatus = document.createElement("div");
      toolbarStatus.className = "config-editor-error settings-save-status hidden";
      toolbarStatus.id = "models-config-toolbar-status";
      toolbarStatus.setAttribute("role", "status");
      toolbarStatus.setAttribute("aria-live", "polite");
      const toolbarSave = document.createElement("button");
      toolbarSave.type = "button";
      toolbarSave.className = "ui-button ui-button--primary models-config-toolbar-save";
      toolbarSave.textContent = t("actions.save");
      toolbarSave.addEventListener(
        "click",
        () => void persistInlineModelsConfig({ button: toolbarSave, statusEl: toolbarStatus }),
      );
      footer.append(toolbarStatus, toolbarSave);

      if (actions) {
        actions.classList.add("models-json-dialog-actions");
        dialog.appendChild(actions);
      }
      sourceDialog.appendChild(dialog);
      document.body.appendChild(sourceDialog);

      const closeSourceDialog = () => {
        sourceDialog.classList.add("hidden");
        renderModelsConfigLayout();
        openSource.focus();
      };
      openSource.addEventListener("click", () => {
        sourceDialog.classList.remove("hidden");
        inlineModelsTextarea.focus();
      });
      close.addEventListener("click", closeSourceDialog);
      sourceDialog.addEventListener("click", (event) => {
        if (event.target === sourceDialog) closeSourceDialog();
      });
      bindDialogEscape(closeSourceDialog, {
        isActive: () => sourceDialog.isConnected && !sourceDialog.classList.contains("hidden"),
      });
      inlineModelsTextarea.addEventListener("change", renderModelsConfigLayout);

      footer.classList.add("models-config-toolbar");
      apiKeysContainer.append(footer, layout);
      if (sourceSection) sourceSection.hidden = true;
    } else if (layout.parentNode !== apiKeysContainer) {
      apiKeysContainer.prepend(layout);
    }
    layout.replaceChildren();
    const sidebar = document.createElement("aside");
    sidebar.className = "models-config-sidebar";
    const list = document.createElement("div");
    list.className = "models-provider-list";
    const main = document.createElement("section");
    main.className = "models-config-main";

    const sync = () => {
      inlineModelsTextarea.value = JSON.stringify(parsed, null, 2);
      clearInlineModelsError();
    };
    const update = (callback) => {
      callback();
      sync();
      renderModelsConfigLayout();
    };

    for (const provider of configuredProviders) {
      if (providerNames.includes(provider.provider)) continue;
      const item = document.createElement("button");
      item.type = "button";
      item.className = "models-provider-item models-auth-provider-item";
      item.classList.toggle(
        "selected",
        selectedModelsConfigItem?.type === "auth" &&
          selectedModelsConfigItem.provider === provider.provider,
      );
      item.append(providerIcon(provider.provider, "models-provider-icon"));
      item.appendChild(
        Object.assign(document.createElement("span"), {
          textContent: provider.displayName || provider.provider,
        }),
      );
      item.addEventListener("click", () => {
        selectedModelsConfigItem = { type: "auth", provider: provider.provider };
        renderModelsConfigLayout();
      });
      list.appendChild(item);
    }

    if (configuredProviders.length && providerNames.length) {
      const divider = document.createElement("div");
      divider.className = "models-provider-divider";
      list.appendChild(divider);
    }

    for (const id of providerNames) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "models-provider-item";
      item.classList.toggle(
        "selected",
        selectedModelsConfigItem?.type === "provider" && selectedModelsConfigItem.provider === id,
      );
      item.append(providerIcon(id, "models-provider-icon"));
      item.appendChild(Object.assign(document.createElement("span"), { textContent: id }));
      item.addEventListener("click", () => {
        selectedModelsConfigItem = { type: "provider", provider: id };
        renderModelsConfigLayout();
      });
      list.appendChild(item);
    }
    sidebar.appendChild(list);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "models-provider-add";
    add.textContent = "+ Add provider";
    add.addEventListener("click", () => openProviderPicker(catalogProviders));
    sidebar.appendChild(add);

    if (!selectedModelsConfigItem) {
      const emptyTitle = document.createElement("h3");
      emptyTitle.textContent = "No providers yet";
      const emptyHint = document.createElement("p");
      emptyHint.textContent = "Add a provider to configure a custom model endpoint.";
      main.append(emptyTitle, emptyHint);
    } else if (selectedModelsConfigItem.type === "auth") {
      const provider = configuredProviders.find(
        (candidate) => candidate.provider === selectedModelsConfigItem.provider,
      );
      if (provider) {
        const card = buildApiKeyRow(provider);
        card.classList.add("provider-manager-card");
        card.querySelector(".api-key-row-header")?.classList.add("provider-manager-card-header");
        card.querySelector(".api-model-list")?.classList.add("provider-manager-model-list");
        main.appendChild(card);
      }
    } else if (selectedModelsConfigItem.type === "provider") {
      renderProviderConfigForm(main, parsed, selectedModelsConfigItem.provider, update);
      renderModelsListSection(main, parsed, selectedModelsConfigItem.provider, update);
      const catalogProvider = catalogProviders.find(
        (candidate) => candidate.provider === selectedModelsConfigItem.provider,
      );
      const catalogModels = catalogProvider ? getProviderModels(catalogProvider) : [];
      if (catalogProvider?.configured && catalogModels.length > 0) {
        renderProviderHealthSection(main, catalogProvider);
      }
    } else if (selectedModelsConfigItem.type === "model-new") {
      renderNewModelForm(main, parsed, selectedModelsConfigItem.provider, update);
    } else {
      renderModelConfigForm(
        main,
        parsed,
        selectedModelsConfigItem.provider,
        selectedModelsConfigItem.index,
        update,
      );
    }
    layout.append(sidebar, main);
  }

  function createModelsField(label, control, hint) {
    const field = document.createElement("label");
    field.className = "models-config-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    field.append(caption, control);
    if (hint) {
      const help = document.createElement("small");
      help.textContent = hint;
      field.appendChild(help);
    }
    return field;
  }

  function createModelsInput(value, placeholder = "") {
    const input = document.createElement("input");
    input.className = "ui-input";
    input.value = value ?? "";
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  }

  function renderProviderConfigForm(main, config, providerName, update) {
    const provider = config.providers[providerName];
    const header = document.createElement("div");
    header.className = "models-config-detail-header";
    const eyebrow = document.createElement("span");
    eyebrow.className = "models-config-eyebrow";
    eyebrow.textContent = "Provider";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ui-button ui-button--danger ui-button--sm";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      if (!confirm(`Delete provider “${providerName}”?`)) return;
      update(() => {
        delete config.providers[providerName];
        selectedModelsConfigItem = null;
      });
    });
    header.append(eyebrow, remove);

    const form = document.createElement("div");
    form.className = "models-config-form";
    const name = createModelsInput(providerName, "provider-name");
    name.addEventListener("change", () => {
      const nextName = name.value.trim();
      if (!nextName || nextName === providerName) {
        name.value = providerName;
        return;
      }
      if (config.providers[nextName]) {
        showInlineModelsError(`Provider “${nextName}” already exists.`);
        name.value = providerName;
        return;
      }
      update(() => {
        config.providers[nextName] = provider;
        delete config.providers[providerName];
        selectedModelsConfigItem = { type: "provider", provider: nextName };
      });
    });
    const baseUrl = createModelsInput(provider.baseUrl, "https://api.example.com/v1");
    baseUrl.addEventListener("input", () => {
      provider.baseUrl = baseUrl.value || undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    const apiKey = createModelsInput(
      provider.apiKey,
      "ENV_VAR_NAME, !shell-command, or literal key",
    );
    apiKey.type = "password";
    apiKey.autocomplete = "off";
    apiKey.addEventListener("input", () => {
      provider.apiKey = apiKey.value || undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    const api = document.createElement("select");
    api.className = "ui-select";
    for (const optionValue of [
      "openai-completions",
      "openai-responses",
      "anthropic-messages",
      "google-generative-ai",
    ]) {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      option.selected = (provider.api || "openai-completions") === optionValue;
      api.appendChild(option);
    }
    api.addEventListener("change", () => {
      provider.api = api.value;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    form.append(
      createModelsField("Provider name", name),
      createModelsField("Base URL", baseUrl),
      createModelsField(
        "API Key",
        apiKey,
        "Prefix with ! to run a shell command, or use an environment variable name.",
      ),
      createModelsField("API", api),
    );
    main.append(header, form);
  }

  function renderProviderHealthSection(main, provider) {
    const healthSection = document.createElement("div");
    healthSection.className = "provider-manager-health";

    const header = document.createElement("div");
    header.className = "api-key-row-header provider-manager-health-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "api-provider-toggle";
    toggle.setAttribute(
      "aria-label",
      t("settings.apiKeys.toggleModels", { provider: provider.displayName || provider.provider }),
    );
    toggle.setAttribute("aria-expanded", "true");
    toggle.textContent = "▼";

    const info = document.createElement("div");
    info.className = "api-key-row-info api-provider-title-toggle";
    info.tabIndex = 0;
    info.setAttribute("role", "button");
    info.setAttribute(
      "aria-label",
      t("settings.apiKeys.toggleModels", { provider: provider.displayName || provider.provider }),
    );

    const title = document.createElement("div");
    title.className = "api-key-row-name";
    title.textContent = provider.displayName || provider.provider;
    info.appendChild(title);

    const summary = document.createElement("div");
    summary.className = "api-key-row-summary";
    summary.textContent = describeProviderSummary(getProviderModels(provider));

    const actions = document.createElement("div");
    actions.className = "api-key-row-actions";
    const checkHealthBtn = document.createElement("button");
    checkHealthBtn.type = "button";
    checkHealthBtn.className = "api-model-check-visible";
    checkHealthBtn.textContent = t("settings.apiKeys.checkHealth");
    checkHealthBtn.disabled = !getProviderModels(provider).some(
      (model) => model.visible !== false && model.available,
    );
    checkHealthBtn.addEventListener("click", () => checkModelHealth(provider.provider));
    actions.appendChild(checkHealthBtn);

    header.append(toggle, info, summary, actions);
    const modelList = buildModelList(provider);
    modelList?.classList.add("provider-manager-model-list");
    const toggleModelList = () => {
      if (!modelList) return;
      modelList.classList.toggle("collapsed");
      toggle.setAttribute("aria-expanded", String(!modelList.classList.contains("collapsed")));
    };
    header.addEventListener("click", (event) => {
      if (event.target.closest?.(".api-key-row-actions")) return;
      toggleModelList();
    });
    info.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleModelList();
      }
    });

    healthSection.append(header);
    if (modelList) healthSection.appendChild(modelList);
    main.appendChild(healthSection);
  }

  function renderModelsListSection(main, config, providerName, update) {
    const provider = config.providers[providerName];
    const models = provider.models || [];
    const section = document.createElement("div");
    section.className = "models-config-models-section";
    const header = document.createElement("div");
    header.className = "models-config-models-header";
    const title = document.createElement("h3");
    title.textContent = "Models";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "models-model-add ui-button ui-button--ghost ui-button--sm";
    addBtn.textContent = "+ Add model";
    addBtn.addEventListener("click", () => {
      newModelDraft = { id: "", provider: providerName };
      selectedModelsConfigItem = { type: "model-new", provider: providerName };
      renderModelsConfigLayout();
    });
    header.append(title, addBtn);
    section.appendChild(header);
    if (models.length === 0) {
      const empty = document.createElement("p");
      empty.className = "models-config-models-empty";
      empty.textContent = "No models configured yet.";
      section.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "models-config-models-list";
      for (const [index, model] of models.entries()) {
        const row = document.createElement("li");
        row.className = "models-config-models-row";
        const label = document.createElement("span");
        label.textContent = model.id || "(unnamed model)";
        const actions = document.createElement("div");
        actions.className = "models-config-models-row-actions";
        const editBtn = document.createElement("button");
        editBtn.type = "button";
        editBtn.className = "ui-button ui-button--sm";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", () => {
          selectedModelsConfigItem = { type: "model", provider: providerName, index };
          renderModelsConfigLayout();
        });
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "ui-button ui-button--danger ui-button--sm";
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => {
          if (!confirm(`Delete model “${model.id || "(unnamed model)"}”?`)) return;
          update(() => {
            provider.models.splice(index, 1);
          });
        });
        actions.append(editBtn, deleteBtn);
        row.append(label, actions);
        list.appendChild(row);
      }
      section.appendChild(list);
    }
    main.appendChild(section);
  }

  function renderNewModelForm(main, config, providerName, update) {
    if (!newModelDraft) newModelDraft = { id: "", provider: providerName };
    const draft = newModelDraft;
    const header = document.createElement("div");
    header.className = "models-config-detail-header";
    const eyebrow = document.createElement("span");
    eyebrow.className = "models-config-eyebrow";
    eyebrow.textContent = "New model";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ui-button ui-button--sm";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      newModelDraft = null;
      selectedModelsConfigItem = { type: "provider", provider: providerName };
      renderModelsConfigLayout();
    });
    header.append(eyebrow, cancel);

    const form = document.createElement("div");
    form.className = "models-config-form";
    const bindings = [
      ["Model ID", "id", "model-name"],
      ["Display name", "name", "Optional"],
      ["Context window", "contextWindow", "Optional"],
      ["Max tokens", "maxTokens", "Optional"],
    ];
    for (const [label, key, placeholder] of bindings) {
      const input = createModelsInput(draft[key], placeholder);
      if (key === "contextWindow" || key === "maxTokens") input.type = "number";
      input.addEventListener("input", () => {
        const value = input.value.trim();
        draft[key] = value
          ? key === "contextWindow" || key === "maxTokens"
            ? Number(value)
            : value
          : undefined;
      });
      form.appendChild(createModelsField(label, input));
    }
    const reasoning = document.createElement("input");
    reasoning.type = "checkbox";
    reasoning.checked = draft.reasoning === true;
    reasoning.addEventListener("change", () => {
      draft.reasoning = reasoning.checked || undefined;
    });
    form.appendChild(createModelsField("Reasoning model", reasoning));

    const error = document.createElement("p");
    error.className = "models-config-form-error";
    error.hidden = true;

    const save = document.createElement("button");
    save.type = "button";
    save.className = "ui-button ui-button--primary";
    save.textContent = "Add model";
    save.addEventListener("click", () => {
      const id = (draft.id || "").trim();
      if (!id) {
        error.textContent = "Model ID is required.";
        error.hidden = false;
        return;
      }
      update(() => {
        const provider = config.providers[providerName];
        provider.models ||= [];
        const modelDraft = { ...draft };
        delete modelDraft.provider;
        provider.models.push({ ...modelDraft, id });
        newModelDraft = null;
        selectedModelsConfigItem = {
          type: "model",
          provider: providerName,
          index: provider.models.length - 1,
        };
      });
    });
    form.appendChild(error);
    form.appendChild(save);
    main.append(header, form);
  }

  function renderModelConfigForm(main, config, providerName, index, update) {
    const model = config.providers[providerName].models[index];
    const header = document.createElement("div");
    header.className = "models-config-detail-header";
    const eyebrow = document.createElement("span");
    eyebrow.className = "models-config-eyebrow";
    eyebrow.textContent = "Model";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ui-button ui-button--danger ui-button--sm";
    remove.textContent = "Delete";
    remove.addEventListener("click", () =>
      update(() => {
        config.providers[providerName].models.splice(index, 1);
        selectedModelsConfigItem = { type: "provider", provider: providerName };
      }),
    );
    header.append(eyebrow, remove);

    const form = document.createElement("div");
    form.className = "models-config-form";
    const bindings = [
      ["Model ID", "id", "model-name"],
      ["Display name", "name", "Optional"],
      ["Context window", "contextWindow", "Optional"],
      ["Max tokens", "maxTokens", "Optional"],
    ];
    for (const [label, key, placeholder] of bindings) {
      const input = createModelsInput(model[key], placeholder);
      if (key === "contextWindow" || key === "maxTokens") input.type = "number";
      input.addEventListener("input", () => {
        const value = input.value.trim();
        model[key] = value
          ? key === "contextWindow" || key === "maxTokens"
            ? Number(value)
            : value
          : undefined;
        inlineModelsTextarea.value = JSON.stringify(config, null, 2);
        if (key === "id") {
          const item = document.querySelector(".models-model-item.selected");
          if (item) item.textContent = value || "New model";
        }
      });
      form.appendChild(createModelsField(label, input));
    }
    const reasoning = document.createElement("input");
    reasoning.type = "checkbox";
    reasoning.checked = model.reasoning === true;
    reasoning.addEventListener("change", () => {
      model.reasoning = reasoning.checked || undefined;
      inlineModelsTextarea.value = JSON.stringify(config, null, 2);
    });
    form.appendChild(createModelsField("Reasoning model", reasoning));
    main.append(header, form);
  }

  // Shared persistence for both save entry points: the Advanced JSON editor's
  // button and the visual layout's toolbar button. `button` / `statusEl` let
  // the toolbar surface saving state and errors next to the visual form
  // instead of inside the (closed) JSON dialog.
  async function persistInlineModelsConfig({ button, statusEl } = {}) {
    if (!inlineModelsTextarea) return;
    const saveButton = button || inlineModelsSave;
    const status = statusEl || inlineModelsError;
    clearSettingsSaveMessage(status);
    const content = inlineModelsTextarea.value;
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      showSettingsSaveError(status, `Invalid JSON: ${e.message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      showSettingsSaveError(status, "models.json must be a JSON object.");
      return;
    }
    if (
      "providers" in parsed &&
      (typeof parsed.providers !== "object" || Array.isArray(parsed.providers))
    ) {
      showSettingsSaveError(status, "'providers' must be an object.");
      return;
    }
    setSettingsSaveButtonSaving(saveButton, true);
    try {
      const data = await call("write_models_config", { content });
      if (!data?.ok) throw new Error(data?.error || "Failed to save models.json");
      showSettingsSaveSuccess(status);
      await onModelConfigurationChanged?.();
    } catch (e) {
      showSettingsSaveError(status, e.message || String(e));
    } finally {
      setSettingsSaveButtonSaving(saveButton, false);
    }
  }

  inlineModelsSave?.addEventListener("click", () => void persistInlineModelsConfig());

  inlineModelsInsertExample?.addEventListener("click", () => {
    if (!inlineModelsTextarea) return;
    const current = inlineModelsTextarea.value.trim();
    if (current && current !== "{}" && current !== '{\n  "providers": {}\n}') {
      if (!confirm("Replace current content with the Ollama example?")) return;
    }
    inlineModelsTextarea.value = MODELS_JSON_EXAMPLE;
    selectedModelsConfigItem = { type: "provider", provider: "ollama" };
    renderModelsConfigLayout();
    clearInlineModelsError();
  });

  modelsConfigDocsLink?.addEventListener("click", (e) => {
    e.preventDefault();
    // System-browser handoff only: no WebView window.open fallback for the
    // docs link (keeps the open-redirect surface closed entirely).
    call("open_external", { url: MODELS_DOCS_URL }).catch((error) => {
      console.warn("[models-page] open_external failed:", error);
    });
  });

  onLocaleChange(() => {
    if (apiKeysContainer?.isConnected) void loadApiKeysPanel({ preserveUi: true });
  });

  return { loadApiKeysPanel, loadInlineModelsEditor, loadOAuthCapability };
}
