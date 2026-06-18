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
      if (command.type === "list_auth_status") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
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
});
