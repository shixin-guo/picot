import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupModelsPage } from "./models-page.js";

describe("models provider editor", () => {
  let dom;
  let call;

  beforeEach(() => {
    dom = new JSDOM(`
      <div id="settings-api-keys"></div>
      <span id="inline-models-path"></span>
      <textarea id="inline-models-textarea"></textarea>
      <div id="inline-models-error" class="hidden"></div>
      <button id="inline-models-save">Save</button>
      <button id="inline-models-insert-example">Example</button>
      <a id="models-config-docs-link"></a>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.confirm = vi.fn(() => true);
    call = vi.fn(async (operation) => {
      if (operation === "read_models_config") {
        return {
          ok: true,
          data: {
            path: "/home/.pi/agent/models.json",
            content: JSON.stringify({
              providers: {
                gateway: {
                  baseUrl: "https://gateway.example/v1",
                  api: "openai-completions",
                  models: [{ id: "gpt-5.5" }],
                },
                local: {
                  baseUrl: "http://localhost:11434/v1",
                  api: "openai-completions",
                  models: [{ id: "qwen" }],
                },
              },
            }),
          },
        };
      }
      if (operation === "write_models_config") return { ok: true };
      if (operation === "list_model_catalog") {
        return {
          ok: true,
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
                    id: "claude-sonnet",
                    available: true,
                    visible: true,
                    health: { status: "healthy" },
                  },
                ],
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected operation: ${operation}`);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.confirm;
  });

  test("opens the advanced JSON editor in a modal dialog", async () => {
    const editor = setupModelsPage({ configGateway: { call } });
    await editor.loadInlineModelsEditor();

    const trigger = document.querySelector(".models-config-source-button");
    const backdrop = document.querySelector(".models-json-dialog-backdrop");
    expect(backdrop.classList.contains("hidden")).toBe(true);
    expect(backdrop.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();

    trigger.click();
    expect(backdrop.classList.contains("hidden")).toBe(false);
    expect(backdrop.contains(document.getElementById("inline-models-textarea"))).toBe(true);

    backdrop.querySelector('[aria-label="Close advanced JSON editor"]').click();
    expect(backdrop.classList.contains("hidden")).toBe(true);
  });

  test("switches providers without removing siblings from models.json", async () => {
    const editor = setupModelsPage({ configGateway: { call } });
    await editor.loadInlineModelsEditor();

    const providerButtons = document.querySelectorAll(".models-provider-item");
    expect(providerButtons).toHaveLength(2);
    providerButtons[1].click();

    const baseUrl = document.querySelector(
      '.models-config-field input[placeholder="https://api.example.com/v1"]',
    );
    expect(baseUrl.value).toBe("http://localhost:11434/v1");
    baseUrl.value = "http://127.0.0.1:11434/v1";
    baseUrl.dispatchEvent(new window.Event("input", { bubbles: true }));

    const config = JSON.parse(document.getElementById("inline-models-textarea").value);
    expect(Object.keys(config.providers)).toEqual(["gateway", "local"]);
    expect(config.providers.local.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  test("combines stored API-key and custom providers in one master-detail layout", async () => {
    const editor = setupModelsPage({ configGateway: { call } });
    await editor.loadInlineModelsEditor();
    await editor.loadApiKeysPanel();

    const labels = [...document.querySelectorAll(".models-provider-item")].map((item) =>
      item.textContent.trim(),
    );
    expect(labels).toEqual(["Anthropic", "gateway", "local"]);

    document.querySelector(".models-auth-provider-item").click();
    expect(document.querySelector(".models-config-main .api-key-row-name").textContent).toBe(
      "Anthropic",
    );
    expect(document.querySelector(".models-config-main .api-model-name").textContent).toBe(
      "claude-sonnet",
    );
  });

  test("uses provider-card health layout for custom providers", async () => {
    const customCall = vi.fn(async (operation) => {
      if (operation === "read_models_config") {
        return {
          ok: true,
          data: {
            path: "/home/.pi/agent/models.json",
            content: JSON.stringify({
              providers: {
                gateway: {
                  baseUrl: "https://gateway.example/v1",
                  api: "openai-completions",
                  models: [{ id: "gpt-5.5" }],
                },
              },
            }),
          },
        };
      }
      if (operation === "list_model_catalog") {
        return {
          ok: true,
          data: {
            providers: [
              {
                provider: "gateway",
                displayName: "gateway",
                configured: true,
                models: [
                  {
                    provider: "gateway",
                    id: "gpt-5.5",
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
      throw new Error(`Unexpected operation: ${operation}`);
    });
    const editor = setupModelsPage({ configGateway: { call: customCall } });
    await editor.loadInlineModelsEditor();
    await editor.loadApiKeysPanel();

    expect(document.querySelector(".provider-manager-health .api-key-row-header")).not.toBeNull();
    expect(document.querySelector(".provider-manager-health .api-key-row-name").textContent).toBe(
      "gateway",
    );
    expect(
      document.querySelector(".provider-manager-health .api-key-row-summary").textContent,
    ).toBe("settings.apiKeys.summary");
    expect(
      document.querySelector(
        ".provider-manager-health .api-key-row-actions .api-model-check-visible",
      ),
    ).not.toBeNull();
  });

  test("renders authenticated providers while models.json is still loading", async () => {
    let resolveModelsConfig;
    const pendingModelsConfig = new Promise((resolve) => {
      resolveModelsConfig = resolve;
    });
    const delayedCall = vi.fn(async (operation) => {
      if (operation === "read_models_config") return pendingModelsConfig;
      return call(operation);
    });
    const editor = setupModelsPage({ configGateway: { call: delayedCall } });
    const modelsLoad = editor.loadInlineModelsEditor();

    await editor.loadApiKeysPanel();
    expect(document.querySelector(".models-config-layout")).not.toBeNull();
    expect(document.querySelector(".models-auth-provider-item")?.textContent).toContain(
      "Anthropic",
    );

    resolveModelsConfig({
      ok: true,
      data: { path: "/home/.pi/agent/models.json", content: '{"providers":{}}' },
    });
    await modelsLoad;
  });

  test("adds a model and saves the complete provider configuration", async () => {
    const onModelConfigurationChanged = vi.fn();
    const editor = setupModelsPage({
      configGateway: { call },
      onModelConfigurationChanged,
    });
    await editor.loadInlineModelsEditor();

    document.querySelector(".models-model-add").click();
    const modelId = document.querySelector('.models-config-field input[placeholder="model-name"]');
    modelId.value = "claude-sonnet";
    modelId.dispatchEvent(new window.Event("input", { bubbles: true }));
    document.querySelector(".models-config-form .ui-button--primary").click();
    document.getElementById("inline-models-save").click();
    await vi.waitFor(() => expect(onModelConfigurationChanged).toHaveBeenCalledOnce());

    const write = call.mock.calls.find(([operation]) => operation === "write_models_config");
    const saved = JSON.parse(write[1].content);
    expect(saved.providers.gateway.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "claude-sonnet",
    ]);
    expect(saved.providers.local.models[0].id).toBe("qwen");
  });

  test("add-provider dialog uses themed overlay primitives", async () => {
    const editor = setupModelsPage({ configGateway: { call } });
    await editor.loadInlineModelsEditor();

    document.querySelector(".models-provider-add").click();
    const dialog = document.querySelector(".provider-picker-dialog");
    expect(dialog.classList.contains("ui-dialog")).toBe(true);
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.closest(".ui-overlay.provider-picker-backdrop")).not.toBeNull();
    expect(dialog.querySelector(".ui-input.provider-picker-search")).not.toBeNull();
    expect(dialog.querySelector("#provider-picker-title").textContent).toBe("Add provider");
  });
});

test("keeps provider keyboard focus inside the clipped sidebar", () => {
  const css = readFileSync("public/native/settings/settings-config.css", "utf8");
  const focusRule = css.match(
    /\.models-provider-item:focus-visible[^{]*\{(?<declarations>[^}]*)\}/,
  );

  expect(focusRule?.groups?.declarations).toMatch(/outline:\s*none/);
  expect(focusRule?.groups?.declarations).toMatch(/background:\s*var\(--bg-glass-hover\)/);
});

test("provider picker dialog does not fall back to a light-theme surface", () => {
  const css = readFileSync("public/native/settings/settings-config.css", "utf8");
  expect(css).not.toMatch(/--bg-primary/);
  expect(css).toMatch(/\.provider-picker-dialog[\s\S]*?color:\s*var\(--text-primary\)/);
});

test("does not draw a curved inset border on the selected provider or model", () => {
  const css = readFileSync("public/native/settings/settings-config.css", "utf8");
  const selectedRules = [...css.matchAll(/[^{}]*\.selected[^{}]*\{(?<declarations>[^}]*)\}/g)];
  const providerSelectionRules = selectedRules.filter((rule) =>
    /\.models-(?:provider|model)-item\.selected/.test(rule[0]),
  );

  expect(providerSelectionRules).not.toHaveLength(0);
  for (const rule of providerSelectionRules) {
    expect(rule.groups.declarations).not.toMatch(/box-shadow/);
  }
});
