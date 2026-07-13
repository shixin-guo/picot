import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupSettingsEditors } from "./app-settings-editors.js";

describe("settings API key model refresh", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`
      <div id="settings-api-keys"></div>
      <button id="config-editor-close"></button>
      <button id="config-editor-cancel"></button>
      <button id="config-editor-save"></button>
      <div id="config-editor-overlay"></div>
      <div id="config-editor-modal"></div>
      <textarea id="config-editor-textarea"></textarea>
      <div id="config-editor-error"></div>
      <div id="config-editor-path"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.confirm = vi.fn(() => true);
    globalThis.requestAnimationFrame = (callback) => callback();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.confirm;
    delete globalThis.requestAnimationFrame;
  });

  test("refreshes model configuration after removing a stored API key", async () => {
    const onModelConfigurationChanged = vi.fn();
    const fetchModelInfo = vi.fn();
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [],
              },
            ],
          },
        };
      }
      if (command.type === "remove_api_key") {
        return { success: true };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      fetchModelInfo,
      closeSettings: vi.fn(),
      onModelConfigurationChanged,
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();
    document.querySelector(".api-key-row-actions .danger").click();
    await Promise.resolve();

    expect(onModelConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(fetchModelInfo).not.toHaveBeenCalled();
  });

  test("renders model rows under authentication providers", async () => {
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [
                  {
                    provider: "anthropic",
                    id: "claude-sonnet-5",
                    contextWindow: 200000,
                    available: true,
                    visible: true,
                    health: { status: "healthy", latencyMs: 42 },
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();

    expect(document.querySelector(".api-model-row")?.textContent).toContain("claude-sonnet-5");
    expect(document.querySelector(".api-model-health-dot.healthy")).not.toBeNull();
    expect(document.querySelector(".api-model-visibility-toggle").checked).toBe(true);
    expect(document.querySelector(".api-model-health-status").textContent).not.toContain(
      "200k context",
    );
  });

  test("renders a compact provider card with health actions and collapsible models", async () => {
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [
                  {
                    provider: "anthropic",
                    id: "claude-sonnet-5",
                    available: true,
                    health: { status: "healthy" },
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();

    expect(document.querySelector(".api-provider-toggle").textContent).toBe("▼");
    expect(document.querySelector(".api-key-row-summary").textContent).toBe(
      "1 enabled · 1 healthy · 0 issues",
    );
    expect(document.querySelector(".api-model-check-visible").textContent).toBe("Check health");
    expect(document.querySelector(".api-key-row-health-check").disabled).toBe(false);
    expect(document.querySelector(".api-model-disable-unhealthy").textContent).toBe(
      "Disable unhealthy models",
    );

    document.querySelector(".api-provider-toggle").click();

    expect(document.querySelector(".api-model-list").hidden).toBe(true);
  });

  test("puts configured providers first without showing authentication source text", async () => {
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                configured: false,
                models: [],
              },
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();

    const providers = document.querySelectorAll(".api-key-row");
    expect(providers[0].dataset.provider).toBe("anthropic");
    expect(providers[1].dataset.provider).toBe("openai");
    expect(document.querySelector(".api-key-row-status")).toBeNull();
  });

  test("does not render health controls when a provider has no keyed models", async () => {
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                configured: false,
                models: [
                  {
                    provider: "openai",
                    id: "gpt-4.1",
                    available: false,
                    visible: false,
                    health: { status: "unknown" },
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();

    expect(document.querySelector(".api-model-empty") === null).toBe(true);
    expect(document.querySelector(".api-model-list") === null).toBe(true);
    expect(document.querySelector(".api-model-row")).toBeNull();
    expect(document.querySelector(".api-model-health-check")).toBeNull();
    expect(document.querySelector(".api-model-check-visible")).toBeNull();
    expect(document.querySelector(".api-key-row-summary")).toBeNull();
  });

  test("toggling model visibility persists and refreshes model info", async () => {
    const onModelConfigurationChanged = vi.fn();
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [
                  {
                    provider: "anthropic",
                    id: "claude-opus-5",
                    available: true,
                    visible: true,
                    health: { status: "unknown" },
                  },
                ],
              },
            ],
          },
        };
      }
      if (command.type === "set_model_visibility") {
        return { success: true };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged,
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();
    const toggle = document.querySelector(".api-model-visibility-toggle");
    toggle.checked = false;
    toggle.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledWith({
      type: "set_model_visibility",
      provider: "anthropic",
      modelId: "claude-opus-5",
      visible: false,
    });
    expect(onModelConfigurationChanged).toHaveBeenCalledTimes(1);
  });

  test("health check updates model row state", async () => {
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [
                  {
                    provider: "anthropic",
                    id: "claude-sonnet-5",
                    available: true,
                    visible: true,
                    health: { status: "unknown" },
                  },
                ],
              },
            ],
          },
        };
      }
      if (command.type === "check_model_health") {
        expect(document.querySelector(".api-model-health-dot.checking")).not.toBeNull();
        return {
          success: true,
          data: {
            results: [
              {
                provider: "anthropic",
                modelId: "claude-sonnet-5",
                status: "unhealthy",
                error: "model overloaded",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();
    document.querySelector(".api-model-health-check").click();
    await Promise.resolve();

    expect(document.querySelector(".api-model-health-dot.unhealthy")).not.toBeNull();
    expect(document.querySelector(".api-model-health-status").textContent).toContain(
      "model overloaded",
    );
  });

  test("keeps the provider card mounted when a health check fails", async () => {
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                models: [
                  {
                    provider: "anthropic",
                    id: "claude-sonnet-5",
                    available: true,
                    visible: true,
                    health: { status: "unknown" },
                  },
                ],
              },
            ],
          },
        };
      }
      if (command.type === "check_model_health") {
        return { success: false, error: "Request timed out" };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();
    const providerRow = document.querySelector(".api-key-row");
    document.querySelector(".api-key-row-health-check").click();
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".api-key-row")).toBe(providerRow);
    expect(document.querySelector(".api-model-health-status").textContent).toContain(
      "Request timed out",
    );
  });

  test("disables all visible unhealthy models for one provider", async () => {
    const onModelConfigurationChanged = vi.fn();
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_model_catalog") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
                models: [
                  {
                    provider: "anthropic",
                    id: "claude-sonnet-5",
                    available: true,
                    visible: true,
                    health: { status: "unhealthy" },
                  },
                  {
                    provider: "anthropic",
                    id: "claude-haiku-5",
                    available: true,
                    visible: true,
                    health: { status: "healthy" },
                  },
                  {
                    provider: "anthropic",
                    id: "claude-opus-5",
                    available: true,
                    visible: false,
                    health: { status: "unhealthy" },
                  },
                ],
              },
            ],
          },
        };
      }
      if (command.type === "set_model_visibility") {
        return { success: true };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      closeSettings: vi.fn(),
      onModelConfigurationChanged,
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();
    document.querySelector(".api-model-disable-unhealthy").click();
    await Promise.resolve();

    expect(rpcCommand).toHaveBeenCalledWith({
      type: "set_model_visibility",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      visible: false,
    });
    expect(rpcCommand).not.toHaveBeenCalledWith({
      type: "set_model_visibility",
      provider: "anthropic",
      modelId: "claude-haiku-5",
      visible: false,
    });
    expect(rpcCommand).not.toHaveBeenCalledWith({
      type: "set_model_visibility",
      provider: "anthropic",
      modelId: "claude-opus-5",
      visible: false,
    });
    expect(onModelConfigurationChanged).toHaveBeenCalledTimes(1);
  });
});
